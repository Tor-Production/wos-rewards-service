# Architecture — Whiteout Survival Rewards Service

- **Status:** Draft
- **Date:** 2026-08-30
- **Owner:** wos-rewards-service maintainers
- **Supersedes:** none
- **Related:** [ADR 0001 — Discord event ingestion](adr/0001-discord-event-ingestion.md) (**Proposed**), [Whiteout provider decision](whiteout-provider-decision.md)

> Evidence in this document is tagged **[fact:<ref>]** (confirmed by an official
> documentation page listed in [§25](#25-official-sources)), **[inference]** (a design
> conclusion drawn from those facts), or **[assumption]** (needs a spike or human decision).

---

## 1. Scope, goals, non-goals

### In scope

- A Discord bot that registers Whiteout Survival players from plain messages in **one
  configured registration channel** and processes gift codes for them.
- Cloudflare Workers + Durable Objects + D1 + Queues as the backend runtime, TypeScript
  strict mode, staging-first.
- `MockWhiteoutProvider` as the default gift-code redemption provider in development,
  automated tests, and staging.
- A stable ingestion boundary (`DiscordEventSource`) so the rest of the system does not
  depend on how the Discord Gateway connection is hosted.

### Goals

- Idempotent handling of every Discord event, player registration, gift code, and
  redemption attempt.
- **Atomic acceptance:** a Discord event is never marked accepted without either its
  registration work or its validation response also becoming durable in the same unit (or
  remaining resumable through an explicit state machine).
- **Global redemption serialization:** at most one `WhiteoutProvider.redeem` call is
  in flight per `(player_id, code)` pair, regardless of how many operations reference it.
  One owner-path retry stays attached to one durable `attempt_id` across redelivery; lease
  contention is separate from provider-failure retry accounting; every global terminal
  transition is guarded by the exact `attempt_id`; and terminal results are re-evaluable
  per reason (state-dependent failures reopen when the player's `state` changes, including
  a guarded check before a stale in-flight attempt can terminalize).
- **One logical summary per operation with at-least-once Discord delivery and bounded
  duplicate suppression.** Every user-facing Discord message (operation summary or
  invalid-input reply) is built deterministically, persisted per chunk, and delivered
  through the same durable mechanism; duplicates remain possible outside Discord's
  few-minute nonce window **[fact:D6]**.
- Clear staging/production separation with no shared secrets, databases, or queues.
- No dependency on undocumented Whiteout Survival endpoints, scraping, cookies, session
  credentials, CAPTCHA bypass, or anti-bot bypass.

### Non-goals

- Production gift-code redemption (blocked — see
  [whiteout-provider-decision.md](whiteout-provider-decision.md)).
- A finalized gift-code discovery source (represented as an abstraction only).
- Discord self-bot behaviour or automation of a normal Discord user account.
- Slash-command / interactions UX as the primary registration path (evaluated only as ADR
  0001 Option 3 / fallback).
- Multi-guild scale-out, a web dashboard, analytics, or historical reporting.
- Choosing where a non-Cloudflare companion process runs (infra decision, deferred).

---

## 2. System context and deployment topology

> **PROVISIONAL — pending [ADR 0001](adr/0001-discord-event-ingestion.md) spike.**
> The ingestion tier below shows **Option 2 (external companion Gateway client)** as the
> provisional reference topology because official platform documentation does **not**
> establish a reliability guarantee for a permanently hosted Cloudflare Gateway client
> **[fact:C1][fact:C2]**. ADR 0001 is **Proposed**; a time-boxed spike decides between
> Option 1 (Durable Object Gateway client) and Option 2. Everything to the right of the
> `DiscordEventSource` boundary is identical for either outcome.

```mermaid
flowchart LR
  subgraph DISCORD["Discord"]
    GW["Discord Gateway (MESSAGE_CREATE)"]
    REST["Discord REST API (Create Message)"]
  end

  subgraph ING_TIER["Ingestion tier — PROVISIONAL"]
    SRC["DiscordEventSource<br/>Option 1: Durable Object | Option 2: external companion"]
  end

  subgraph CF["Cloudflare backend — implementation-agnostic"]
    ING["Ingestion Worker /ingest<br/>atomic accept or resumable state machine"]
    D1[("D1: players, gift_codes, redemptions (global claim + generation),<br/>processed_events (state machine), operations, operation_items,<br/>summary_chunk_layout, discord_output_deliveries, outbox_jobs")]
    DISP["Outbox dispatcher (Cron + inline)"]
    Q1[["Queue: registration-jobs"]]
    Q2[["Queue: code-fanout-jobs"]]
    DLQ[["Queue: redemption-dlq"]]
    RC["Registration consumer"]
    FC["Fan-out consumer"]
    DLC["DLQ inspection consumer"]
    SWEEP["Operation sweeper (Cron)"]
    OUTD["Output delivery dispatcher (Cron + inline)"]
    OUT["Discord output builder"]
    PROV["WhiteoutProvider adapter (Mock by default)"]
    GCS["GiftCodeSource adapter (not authorized)"]
  end

  GW --> SRC
  SRC -->|"authenticated HTTPS: RegistrationMessageEvent"| ING
  ING --> D1
  D1 --> DISP
  DISP --> Q1
  DISP --> Q2
  Q1 --> RC
  Q2 --> FC
  RC -->|"claim redemptions(player_id,code)"| D1
  FC -->|"claim redemptions(player_id,code)"| D1
  RC --> PROV
  FC --> PROV
  Q1 -. "exhausted retries" .-> DLQ
  Q2 -. "exhausted retries" .-> DLQ
  DLQ --> DLC --> D1
  SWEEP --> D1
  RC --> OUT
  FC --> OUT
  SWEEP --> OUT
  OUT --> D1
  D1 --> OUTD
  OUTD --> REST
  GCS --> D1
```

### Deployment stacks

Two fully separate stacks, `staging` and `production`, selected by the `ENVIRONMENT`
variable. Each stack has its own D1 database, its own three Queues, its own Durable Object
namespace (if Option 1 is chosen), its own Discord application + bot token, its own Cron
Triggers, and its own secret set. No resource, name, or secret is shared between stacks.
See [§19](#19-staging-and-production-separation).

### Trust boundaries

- **Discord ↔ ingestion tier:** the Discord bot token authenticates the Gateway
  connection. Only `MESSAGE_CREATE` events for the configured guild + registration channel,
  authored by a **non-bot, non-system, non-webhook** user, are relevant
  ([§5](#5-discord-registration-flow)).
- **Ingestion tier ↔ Cloudflare backend:** the ingestion tier authenticates to the
  Ingestion Worker with `INGESTION_SHARED_SECRET` (Option 2) or is in-process (Option 1).
  The ingestion tier is **untrusted for business logic** — it may not decide whether a
  registration is valid.
- **Cloudflare backend ↔ Whiteout Survival:** all access goes through the
  `WhiteoutProvider` interface, serialized per `(player_id, code)` by the global
  `redemptions` record. No other component talks to the game.

---

## 3. `DiscordEventSource` — the ingestion boundary

`DiscordEventSource` is the single seam the rest of the system depends on. It delivers one
message shape to the Ingestion Worker and nothing else:

```ts
// The only payload the Cloudflare backend consumes from the ingestion tier.
interface RegistrationMessageEvent {
  event_id: string;          // Discord message id, canonical string (never a number)
  guild_id: string;          // canonical string
  channel_id: string;        // canonical string
  author_id: string;         // canonical string (message.author.id)
  author_is_bot: boolean;    // message.author.bot === true
  author_is_system: boolean; // message.author.system === true
  webhook_id: string | null; // message.webhook_id (non-null => webhook-authored)
  application_id: string | null; // message.application_id
  content: string;           // RAW message content, forwarded even when syntactically invalid
  created_at: string;        // ISO-8601 timestamp from the Discord message
}

interface DiscordEventSource {
  // Implementations hold the Discord Gateway connection and filter to the configured
  // guild + registration channel. In PRODUCTION they drop bot / system / webhook /
  // own-application messages before creating a RegistrationMessageEvent. In STAGING they
  // drop the same EXCEPT senders listed in SPIKE_SENDER_ALLOWLIST, which are forwarded
  // with author_is_bot / author_is_system / webhook_id / application_id UNCHANGED so the
  // Ingestion Worker can validate them. They perform NO player-registration business
  // validation.
}
```

### Author filtering

**Production — unconditional drop.** Production registration ingestion **ignores**:

- the application's own messages (`author_id` equals the app's bot user id, or
  `application_id` equals `DISCORD_APPLICATION_ID`);
- any message where `author_is_bot` is true;
- any message where `author_is_system` is true;
- any message where `webhook_id` is non-null (webhook-authored).

The `DiscordEventSource` applies this filter **before creating a `RegistrationMessageEvent`**.
The Ingestion Worker re-applies the identical filter as defense in depth using the
forwarded `author_is_bot` / `author_is_system` / `webhook_id` / `application_id` fields
**[fact:D2][fact:D7]**. In production `SPIKE_SENDER_ALLOWLIST` is **undefined in the config
of both tiers**, so both filters are strict with no code branch to weaken.

#### Staging spike exception — reachable at both tiers

The mandated ADR 0001 spike sender is a **dedicated bot or incoming webhook**, so its
messages would be dropped by the production rule before reaching the Worker. In the
`staging` stack only, `SPIKE_SENDER_ALLOWLIST` (dedicated spike bot / webhook sender ids)
is consulted by **both** tiers:

- The **`DiscordEventSource`** (companion in Option 2, or the DO in Option 1) does **not**
  drop a bot/webhook message whose `author_id` or `webhook_id` is in
  `SPIKE_SENDER_ALLOWLIST`; it forwards it with all flags intact. This is the only change
  that lets the spike message *reach* the Worker.
- The **Ingestion Worker** remains the **authoritative staging gate**: it re-checks the
  same `SPIKE_SENDER_ALLOWLIST`, drops any bot/webhook sender not on it, and **asserts
  `ENVIRONMENT !== "production"`** before consulting the list at all.

The allow-list can only ever hold dedicated bot-account or incoming-webhook ids, never a
normal user. It is never defined in the production config of either tier. See
[ADR 0001 §6](adr/0001-discord-event-ingestion.md#6-decision-proposed-spike-gated).

### Candidate implementations (decided by [ADR 0001](adr/0001-discord-event-ingestion.md))

| | `DurableObjectGatewaySource` (Option 1) | `CompanionGatewaySource` (Option 2, provisional) |
|---|---|---|
| Host | A Durable Object holds the outbound Gateway WebSocket | A minimal always-on process outside Cloudflare |
| Reliability basis | **Not guaranteed by docs** — outbound WebSockets do not hibernate and an active outbound connection only *prevents eviction for up to 15 minutes per connection* **[fact:C2]**; normal lifecycle/eviction timing resumes afterward **[fact:C1]** | A normal long-lived process; standard supervised-restart operations |
| Secrets it holds | Discord bot token (Worker secret) | Discord bot token + `INGESTION_SHARED_SECRET` |
| Decision | The ADR 0001 spike tests whether Option 1 is reliable enough; if it passes, Option 1 is preferred (fewer moving parts) | Provisional reference until the spike completes or is explicitly waived |

**Blocking rule:** the real `DiscordEventSource` adapter (either implementation) is **not
built** until the ADR 0001 spike completes or is explicitly waived. Phases 1–4
([§23](#23-phased-implementation-order)) build everything to the right of this boundary
against `RegistrationMessageEvent` alone.

### Companion validation scope (Option 2)

The companion validates **only**: transport schema of its own forward request, its auth
context (`INGESTION_SHARED_SECRET`), `guild_id`, `channel_id` (must equal
`DISCORD_REGISTRATION_CHANNEL_ID`), and the author gate above — drop bot / system / webhook /
own-application messages in production; in staging forward senders in
`SPIKE_SENDER_ALLOWLIST` unchanged. It **forwards `content` verbatim even when the
registration syntax is invalid**, because the Cloudflare business layer must generate the
Discord validation reply **[inference]**. It has no D1 access and never writes to Discord.

---

## 4. Configuration and environment

Variable **names only** — no values appear in this repository. Values are supplied per
stack via Wrangler vars (non-secret) and Wrangler secrets (secret).

### Non-secret configuration

| Name | Read by | Purpose |
|---|---|---|
| `ENVIRONMENT` | all | `staging` or `production`; selects the stack |
| `DISCORD_REGISTRATION_CHANNEL_ID` | ingestion tier, ingestion Worker | the only channel whose messages are registration commands |
| `DISCORD_GUILD_ID` | ingestion tier, ingestion Worker | expected guild |
| `DISCORD_APPLICATION_ID` | ingestion Worker, output builder | own application id; used by the author filter |
| `DEFAULT_STATE` | registration parser | state used when the message omits a numeric state (contract in `AGENTS.md`) |
| `DISCORD_MESSAGE_MAX_LENGTH` | output builder | chunking threshold (defaults to the Discord limit) |
| `OPERATION_DEADLINE_SECONDS` | consumers, sweeper | max wall time before an operation is force-closed with a partial summary |
| `ITEM_CLAIM_LEASE_SECONDS` | consumers, sweeper | `operation_items` lease TTL |
| `REDEMPTION_CLAIM_LEASE_SECONDS` | consumers, sweeper | `attempt_expires_at` TTL; bounds only when a *different* attempt may steal (T3) or the sweeper re-drives (T11) — an owner resumes its own `attempt_id` (T2) regardless; set above a few provider-retry `delaySeconds` cycles |
| `OUTPUT_CLAIM_LEASE_SECONDS` | output dispatcher, sweeper | `discord_output_deliveries` claim lease TTL |
| `FANOUT_EXPANSION_PAGE_SIZE` | fan-out expansion worker | rows per bounded expansion page |
| `SWEEPER_REDRIVE_BATCH` | operation sweeper | max stuck `(player_id, code)` pairs re-driven per sweeper run |
| `REDEMPTION_MAX_REEVAL` | ingestion Worker, sweeper, repair | cap on `redemptions.reeval_count`; beyond it only an operator `repair_run` may reopen the row |
| `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED` | operation sweeper | default `false`; when `true`, the sweeper may reopen a `retry_exhausted` global row once per cooldown (bounded by `REDEMPTION_MAX_REEVAL`) |
| `SUMMARY_BUILD_PAGE_SIZE` | summary builder | `operation_items` per layout page / chunks per render page |
| `SUMMARY_MAX_CHUNKS` | summary builder | hard cap on chunks per summary; overflow becomes a deterministic `"+N more not listed"` line in the final chunk |
| `OUTBOX_DISPATCH_MAX_ATTEMPTS` | outbox dispatcher | attempts before an outbox row is marked `dead` |
| `OUTPUT_DISPATCH_MAX_ATTEMPTS` | output dispatcher | send attempts before a delivery row is alerted |
| `CODE_DISCOVERY_ENABLED` | code-discovery scheduler | master switch; `false` until a source is authorized |
| `PRODUCTION_REDEMPTION_ENABLED` | provider adapter | must be `false` unless an authorized provider is documented and approved |
| `PROVIDER_MODE` | provider adapter | `mock` (default) or a named authorized provider |
| `REGISTRATION_JOBS_QUEUE` / `CODE_FANOUT_JOBS_QUEUE` / `REDEMPTION_DLQ_QUEUE` | producers/consumers | queue bindings |
| `PROVIDER_MAX_RETRIES` | consumers | retry cap for retryable provider failures (≤ Queues max, [fact:C8]) |
| `PROVIDER_RATE_LIMIT_PER_SECOND` | provider adapter | client-side rate limiting toward the provider |
| `SPIKE_SENDER_ALLOWLIST` | `DiscordEventSource` **and** ingestion Worker (**staging only**) | dedicated spike bot/webhook sender ids; the source forwards them instead of dropping them, the Worker re-checks the same list as the authoritative gate; never set in the production config of either tier |
| `LOG_LEVEL` | all | structured-log verbosity |

### Secrets (names only — never values, never logged)

| Name | Held by | Purpose |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ingestion tier, output dispatcher | Discord bot authentication |
| `DISCORD_PUBLIC_KEY` | interactions fallback only | Ed25519 verification for the `/register` fallback ([ADR 0001](adr/0001-discord-event-ingestion.md) Option 3) |
| `INGESTION_SHARED_SECRET` | companion (Option 2), ingestion Worker | authenticates companion → `/ingest` |

**No production Whiteout provider secret is defined.** A future authorized provider may use
any authentication mechanism; its secret name(s) are added only when its contract is
documented and approved. Any `WHITEOUT_PROVIDER_*` name that appears later is a non-binding
placeholder, not a commitment to API-key authentication.

---

## 5. Discord registration flow

### Channel and author gate

A message is a candidate registration command only if it is in
`DISCORD_REGISTRATION_CHANNEL_ID` within `DISCORD_GUILD_ID` **[fact:D2][fact:D3]** **and**
passes the author filter in [§3](#author-filtering) (not a bot, system, webhook, or the app
itself) **[fact:D7]**. Everything else is dropped before an event is created. In the
`staging` stack only, `SPIKE_SENDER_ALLOWLIST` senders are exempt from the bot/webhook drop
at both the `DiscordEventSource` and the Ingestion Worker
([§3](#staging-spike-exception--reachable-at-both-tiers)).

### Parsing (authoritative rules from `AGENTS.md`)

Supported message forms:

- `PLAYER_ID`
- `PLAYER_ID DISPLAY_NAME`
- `PLAYER_ID STATE`
- `PLAYER_ID STATE DISPLAY_NAME`

Behaviour:

- `PLAYER_ID` is required and must be numeric (validated as `^\d+$`). It is **stored and
  transported as a canonical string** — see [§10](#10-identifier-handling).
- If the second token is numeric, it is `STATE` (also kept as a string).
- If the second token is not numeric, `STATE` is `DEFAULT_STATE` (from environment
  configuration, never hard-coded) and the second and all remaining tokens are
  `DISPLAY_NAME`.
- `DISPLAY_NAME` is optional and may contain spaces.
- If no display name is supplied, Discord output uses `ID <PLAYER_ID>`.
- Re-registering an existing player updates the existing row (upsert), never creates a
  duplicate.
- Display names are sanitized and mentions suppressed on output
  ([§18](#18-discord-output-safety)).
- The bot never infers state or nickname from any Whiteout Survival endpoint. The `STATE`
  carried forward to the provider is exactly the one from this contract.

### Atomic acceptance

The Ingestion Worker never writes a bare "processed" marker before the work. It builds the
**entire write set** for the event and commits it as **one atomic D1 `db.batch()`**
**[fact:C9]** whose first statement is a plain `INSERT INTO processed_events (event_id, …)`.
A primary-key conflict rolls the whole batch back atomically and is interpreted as a
**duplicate delivery** → ack, no-op.

- **Invalid input** — the atomic unit persists, together:
  1. `processed_events` row with `status = 'accepted_invalid'` and `validation_reason`;
  2. the `discord_output_deliveries` row for the validation reply (single chunk,
     deterministic ≤ 25-char nonce, `status = 'pending'`, **no footer**).
- **Valid input** — the atomic unit persists, together:
  1. `processed_events` row with `status = 'accepted_valid'` and `operation_id`;
  2. the `players` upsert (and, if `state` changed, `players.state_updated_at = now`);
  3. the `operations` row (`type = 'registration_run'`) with `expected_count` fixed at the
     active-code snapshot size;
  4. one `operation_items` row per snapshotted active code;
  5. one per-item `outbox_jobs` row;
  6. **if the accepted registration changed `players.state`**, the guarded **T12** reopen of
     any state-dependent (`player_ineligible`) `redemptions` failures for this `player_id`
     ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)) — never
     touching `success` / `already_redeemed` rows. (An old-state attempt still `in_progress`
     is handled at terminalization by **T8**, not here.)

A registration write set is bounded by the number of currently-active gift codes, which is
small in practice. **If that count ever exceeds a safe single-batch size**, acceptance
falls back to the **explicit state machine**: the atomic unit commits only
`processed_events (status = 'accepted_valid')` + the `operations` shell
(`expansion_state = 'pending'`), and a paginated expansion
([§7](#7-new-code-fan-out-flow)) fills `operation_items` + `outbox_jobs`.
`processed_events.status` advances to `work_committed` only when
`expansion_state = 'expanded'`. The sweeper re-drives any event stuck in `accepted_valid`.
**A crash can never leave an event `accepted_*` without either its registration work or its
validation-reply delivery row durably present**, because the marker is only ever written in
the same batch as one of them.

### Invalid message reply

The validation reply is delivered by the **output delivery dispatcher**
([§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery))
from its persisted `discord_output_deliveries` row — the same durable mechanism as
summaries (the trivial one-chunk case). It is
mention-suppressed, describes the accepted forms, and **carries no runtime footer**. A
retry resumes the unsent delivery rather than re-posting, with bounded Discord-side
duplicate suppression **[fact:D6]**.

### Valid message — sequence

```mermaid
sequenceDiagram
  participant U as User (registration channel)
  participant S as DiscordEventSource
  participant I as Ingestion Worker
  participant DB as D1
  participant X as Outbox dispatcher
  participant Q as registration-jobs
  participant C as Registration consumer
  participant R as redemptions (global claim)
  participant P as WhiteoutProvider (Mock)
  participant OD as Output delivery dispatcher

  U->>S: message "PLAYER_ID [STATE] [NAME]"
  S->>I: POST /ingest RegistrationMessageEvent (auth, author-filtered; staging: allow-listed bot/webhook forwarded)
  I->>DB: ONE atomic batch — INSERT processed_events(accepted_valid), upsert players, insert operations, operation_items, outbox_jobs; reopen state-dependent redemptions failures if state changed
  Note over DB: PK conflict on processed_events => whole batch rolls back => duplicate, no-op
  I->>X: best-effort enqueue
  X->>Q: one registration job per code
  loop each code
    Q->>C: job {operation_id, item_key=code, job_id, player_id, code, attempt_id}
    C->>DB: claim-or-resume operation_items lease by attempt_id
    C->>R: claim-or-resume redemptions(player_id, code) by attempt_id (T1/T2/T3)
    alt redemption already terminal (T15/terminal)
      R-->>C: terminal outcome (success | already_redeemed | permanent_failure | retry_exhausted)
      C->>DB: mirror outcome onto operation_items
    else current_attempt_id = my attempt_id (T1/T2/T3)
      C->>P: redeem(PlayerRef{playerId,state}, code, idempotencyKey)
      P-->>C: success | already_redeemed | retryable | permanent
      C->>DB: terminal write WHERE current_attempt_id = attempt_id AND status='in_progress' (T5/T6); player_ineligible => compare attempt_state vs players.state (T7 terminal / T8 back to pending); mirror
      Note over C,Q: retryable => message.retry (same body/attempt_id) => redelivery resumes as T2
    else different live attempt (T4 contention)
      C->>DB: release operation_items lease (back to pending)
      C->>Q: ack (no message.retry, no max_retries consumed, no redemptions write)
      Note over R: sweeper re-drives the pair with a fresh attempt_id
    end
  end
  C->>DB: finalisable? seal summary_item_snapshot (none->sealing->building), then paged layout + render
  OD->>DB: claim next pending delivery chunk (in chunk_index order)
  OD->>U: Create Message (per-chunk deterministic nonce, enforce_nonce); footer only in final chunk
  OD->>DB: record discord_message_id, sent_at WHERE claim_token matches
```

A zero-active-code snapshot yields `expected_count = 0`; the operation is immediately
finalisable and produces a **single-chunk** zero-result summary
(`"0 codes applied"`) whose one chunk carries the runtime footer.

---

## 6. Existing-code processing after registration

1. **Atomic acceptance** ([§5](#atomic-acceptance)) has already committed the `players`
   upsert, the `registration_run` operation, its `operation_items`, their `outbox_jobs`,
   and any guarded state-dependent `redemptions` reopen in one unit (or via the resumable
   state machine).
2. **Dispatch** (`registration-jobs`) — inline best-effort plus the Cron dispatcher
   ([§14](#14-transactional-outbox)).
3. **Consume:** each job carries `{operation_id, item_key: code, job_id, player_id, code,
   attempt_id}`. The consumer:
   - claim-or-resumes the `operation_items` lease by `attempt_id`
     ([§15.1](#151-operation-item-lease-queue-dedup--accounting));
   - **claim-or-resumes the global `redemptions` record** for `(player_id, code)` by
     `attempt_id` ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority),
     T1/T2/T3); if the row is already terminal it reuses that outcome without calling the
     provider; if `current_attempt_id` is a **different live attempt** (T4) it **releases
     its `operation_items` lease, `ack`s, and stops** — the sweeper re-drives with a fresh
     `attempt_id`;
   - when `current_attempt_id` is its own `attempt_id`, calls
     `WhiteoutProvider.redeem({ playerId, state }, code, idempotencyKey)`, honouring
     `PROVIDER_RATE_LIMIT_PER_SECOND`; a `retryable` outcome ⇒ `message.retry({ delaySeconds
     })` (same body/`attempt_id` ⇒ redelivery resumes as **T2**)
     ([§17](#17-retry-and-permanent-failure-classification));
   - writes the `redemptions` terminal row **guarded on `current_attempt_id = :attempt_id
     AND status = 'in_progress'`** (T5/T6; `player_ineligible` ⇒ **T7** if
     `attempt_state = players.state`, else **T8** back to `pending`), then mirrors the
     outcome onto its `operation_items` row.
4. **Aggregate & summarize:** when every item is terminal
   ([§15.3](#153-completion-accounting)), the operation's summary is sealed into an
   immutable `summary_item_snapshot` and then built by the **paged, cursor-driven,
   idempotent** process
   ([§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery)):
   how many codes were applied (`success` + `already_redeemed`) and which, identifying the
   player by display name or `ID <PLAYER_ID>`. The runtime footer from `AGENTS.md` appears
   **only in the final persisted chunk**.

---

## 7. New-code fan-out flow

1. **Discover** a candidate code via `GiftCodeSource`
   ([§9](#9-scheduled-cron-components-and-the-trigger-budget),
   [§11](#11-whiteoutprovider-and-giftcodesource-abstractions)). The source is **not
   authorized** yet; the flow is defined so it works the moment an authorized source exists.
2. **Deduplicate** on `gift_codes.code` (unique). A re-seen code is a no-op.
3. **Open a `code_distribution_run` operation** and fix a **stable player snapshot
   boundary** at discovery time (a monotonic `player_id` cursor filtered by `snapshot_at`,
   or an `operation_players_snapshot` side table). `expected_count` = boundary size.
4. **Bounded, restartable expansion:** the fan-out expansion worker repeatedly reads the
   next `FANOUT_EXPANSION_PAGE_SIZE` players after `expansion_cursor` and, in one atomic D1
   batch, writes that page's `operation_items` rows + per-item `outbox_jobs` rows + the
   advanced `expansion_cursor`. `expansion_state` moves `pending → expanding → expanded`.
   After a crash it resumes from the persisted cursor; already-written pages are skipped by
   primary-key conflict.
5. **Consume** (`code-fanout-jobs`): claim-or-resume the `operation_items` lease and the
   global `redemptions` record by `attempt_id` exactly as in
   [§6](#6-existing-code-processing-after-registration) — reuse a terminal outcome; on a
   **different live attempt** (T4) **release the item lease and `ack`** (sweeper re-drive
   with a fresh `attempt_id`, no retry budget consumed); or call the provider when
   `current_attempt_id` is your own `attempt_id`, with `attempt_id`-guarded terminal writes
   (T5–T8).
6. **Aggregate & summarize:** when `expansion_state = expanded` **and** all items are
   terminal, the operation's summary is sealed into `summary_item_snapshot` and built by the
   **paged, cursor-driven, idempotent** process ([§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery)):
   the code, the applied-player count (`success` + `already_redeemed`), and a comma-separated
   list of display names / `ID <PLAYER_ID>` fallbacks. Output is **chunked** when it exceeds
   `DISCORD_MESSAGE_MAX_LENGTH` ([§18](#18-discord-output-safety)) and capped at
   `SUMMARY_MAX_CHUNKS`; the runtime footer appears **only in the final persisted chunk**.
   Zero registered players ⇒ single-chunk zero-result summary.

### Overlap is handled by the global redemption record

A `registration_run` snapshots the codes active at registration time; a
`code_distribution_run` snapshots the players registered at discovery time. These can still
**overlap for the same `(player_id, code)`** (e.g. a race between a registration and a
just-discovered code). The `redemptions` record for `(player_id, code)` is the **single
provider-call authority** ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)):
whichever consumer claims it first calls the provider; every other operation item for the
same pair joins or reuses that terminal outcome and never calls the provider
independently **[inference]**.

---

## 8. Component responsibilities

| Component | Responsibility | Notes |
|---|---|---|
| `DiscordEventSource` | Hold the Gateway connection; filter to guild+channel; drop bot/system/webhook/own-app messages (production) — forward `SPIKE_SENDER_ALLOWLIST` senders unchanged (staging); POST `RegistrationMessageEvent` | Companion **or** DO, per ADR 0001; no business logic |
| Ingestion Worker (`/ingest`) | Authenticate the source; re-apply the author filter (authoritative staging gate, asserts non-production); parse; **atomically** persist `processed_events` + (validation-reply delivery row **or** registration work + outbox rows) + guarded reopen of state-dependent `redemptions` failures on a `state` change, or the resumable state-machine shell | Stateless Worker; PK conflict ⇒ duplicate no-op |
| Fan-out expansion worker | Paginate the player snapshot into `operation_items` + outbox rows | Cursor-driven, bounded, restartable |
| Outbox dispatcher | Enqueue `pending` outbox rows; back off; mark `dead`; **atomic-reopen** pre-summary or flag a repair after finalization ([§14](#14-transactional-outbox)) | Cron (every minute, [fact:C4]) + inline best-effort |
| Registration consumer | Claim-or-resume the item lease **and** the global redemption by the body's `attempt_id` (T1/T2/T3); reuse a terminal outcome; **release + `ack`** on a different live attempt (T4); redeem when `current_attempt_id` is its own; `attempt_id`-guarded terminal writes (T5–T8, incl. `attempt_state` vs `players.state`); mirror; trigger the seal + summary build | Queue consumer; contention (T4) never uses `message.retry` |
| Fan-out consumer | Same as the registration consumer, for one `(player_id, code)` per job; triggers the seal + summary build when expansion done | Queue consumer |
| DLQ inspection consumer | Terminalize the global `redemptions` row `retry_exhausted` **only** on an exact `current_attempt_id = message.attempt_id` match while `status='in_progress'` (T9); otherwise (T10) record `dlq_stale_attempt` and change nothing — a stale `attempt_id` never terminalizes a newer one, even if the newer lease has since expired; mirror to non-terminal `operation_items` | Consumer of `redemption-dlq`; each DLQ message is one specific `attempt_id` |
| Operation sweeper | Force-close operations past `OPERATION_DEADLINE_SECONDS` (and **seal the snapshot then**); reset expired redemption / item / output leases (`in_progress → pending`, T11); mirror terminal redemptions onto waiting items; **re-drive** up to `SWEEPER_REDRIVE_BATCH` stuck non-terminal pairs whose global redemption is non-terminal and unclaimed — **fresh `attempt_id`**, fresh budget; **T14** guarded `state`-mismatch reopen of already-terminal `player_ineligible` rows; atomic-reopen outbox-dead items pre-seal; optional bounded `retry_exhausted` reopen | Cron |
| Discord output builder | **Paged, cursor-driven, idempotent**: **seal** `summary_item_snapshot` (once), then a layout pass assigns snapshot `sort_key` ranges to chunks (`summary_chunk_layout`, persisting the open-chunk accumulator with the cursor) and a render pass persists `discord_output_deliveries` rows; every pass reads **only** the immutable snapshot; footer only in the final chunk; capped at `SUMMARY_MAX_CHUNKS` | Cron (shared `scheduled()` handler) + inline best-effort |
| Output delivery dispatcher | Claim `pending` (or lease-expired) `discord_output_deliveries` chunks in `chunk_index` order; send via Create Message with per-chunk nonce + `enforce_nonce`; record `discord_message_id`; resume at the first unsent chunk | Cron (every minute) + inline best-effort |
| `WhiteoutProvider` adapter | `redeem(PlayerRef, code, idempotencyKey)` → structured result; provider-side rate limiting; error mapping | `MockWhiteoutProvider` by default |
| `GiftCodeSource` adapter | Discover/list candidate codes from an **authorized** source | Not authorized; disabled |
| Code-discovery scheduler | Poll the authorized source when `CODE_DISCOVERY_ENABLED=true` | Cron; no-op until authorized |
| D1 | System of record | See [§12](#12-preliminary-d1-data-model) |
| Queues + DLQ | Async fan-out + retry isolation | See [§13](#13-cloudflare-queue-and-dead-letter-queue-boundaries) |

---

## 9. Scheduled (Cron) components and the trigger budget

Cloudflare allows **5 Cron Triggers per account on Free, 250 on Paid** **[fact:C5]**, and
minimum granularity is one minute **[fact:C4]**. The design keeps the scheduled surface
small and, where practical, multiplexes work into a single `scheduled()` handler that
dispatches by current UTC minute.

| Scheduled job | Cadence | Work |
|---|---|---|
| Outbox dispatcher | every minute | enqueue `pending` `outbox_jobs`; back off; mark `dead`; atomic-reopen pre-summary or flag a repair after finalization ([§14](#14-transactional-outbox)) |
| Summary builder | every minute | advance the seal / layout / render cursors (`snapshot_cursor`, `summary_layout_cursor` + `summary_layout_open`, `summary_build_cursor`) for operations that are finalisable or in `summary_state ∈ {sealing, building}` ([§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery)); shares the `scheduled()` handler |
| Output delivery dispatcher | every minute | claim and send `pending` / lease-expired `discord_output_deliveries` chunks in `chunk_index` order; resume at the first unsent chunk |
| Operation sweeper | every minute | force-close operations past `deadline_at` (seal the snapshot then); reset expired redemption / item / output leases (`in_progress → pending`, T11); mirror terminal `redemptions` onto waiting `operation_items`; re-drive up to `SWEEPER_REDRIVE_BATCH` stuck non-terminal, unclaimed pairs with a fresh `attempt_id`; T14 `state`-mismatch reopen; optional bounded `retry_exhausted` reopen |
| Retention | hourly | delete fully-accounted `enqueued` outbox rows, `sent` delivery rows, and `summary_chunk_layout` / `summary_item_snapshot` rows for delivered operations past the retention window |
| Code-discovery scheduler | configurable | poll the authorized `GiftCodeSource` when `CODE_DISCOVERY_ENABLED=true`; **no-op until a source is authorized** |

Durable Object **alarms** ([fact:C3]) are an implementation option for per-operation timers
if Option 1 is chosen or if per-operation precision is needed; they do not consume the Cron
Trigger budget.

---

## 10. Identifier handling

- **`PLAYER_ID`** is validated on input as `^\d+$`, then **stored and transported only as a
  canonical string**: D1 column type `TEXT`, TypeScript type `string`, JSON string in every
  queue payload and interface. It is **never** parsed to a JavaScript `number` and **never**
  stored in a SQLite `INTEGER` column, because large numeric ids lose precision beyond
  2^53 and integer affinity would normalise away leading zeros **[fact:C9]**.
- **`STATE`** is digit-only input but is likewise kept as `TEXT` / `string`; no arithmetic
  is performed on it. It is carried unchanged into `PlayerRef.state`
  ([§11](#11-whiteoutprovider-and-giftcodesource-abstractions)).
- **Canonicalisation rule (to finalise in implementation):** trim surrounding whitespace;
  reject empty; preserve the remaining digit string verbatim.
- Every key, foreign key, queue payload field, `operation_items.item_key`, redemption
  `idempotency_key`, and idempotency check in this document uses string identifiers.

---

## 11. `WhiteoutProvider` and `GiftCodeSource` abstractions

The two concerns are **separate interfaces**. Discovery never lives on `WhiteoutProvider`.

```ts
// State comes from the registration contract (user input or DEFAULT_STATE).
// The provider MUST NOT look up or infer state or nickname.
interface PlayerRef {
  playerId: string;
  state: string;
}

type RedeemResult =
  | { outcome: 'success'; providerReceipt?: string }          // terminal, IMMUTABLE, counts as applied
  | { outcome: 'already_redeemed'; providerReceipt?: string } // terminal, IMMUTABLE, success-equivalent, counts as applied
  | { outcome: 'retryable'; reasonCode: string }              // 429 / 5xx / network / provider "rate limited"
  | { outcome: 'permanent'; reasonCode: string };             // reasonCode classifies terminality/reopen:
                                                             //   code-dependent  : code_invalid | code_expired  (repair_run only)
                                                             //   state-dependent : player_ineligible            (auto-reopen when players.state changes)
                                                             //   operational     : provider_bad_request | provider_auth_failed (repair_run only)

interface WhiteoutProvider {
  // Apply ONE gift code to ONE player. `idempotencyKey` is the stable per-(player,code)
  // key from the global redemptions record; a compliant real provider uses it (or an
  // authorized reconciliation lookup) so a retried redemption is a safe no-op.
  redeem(player: PlayerRef, code: string, idempotencyKey: string): Promise<RedeemResult>;
}

interface DiscoveredCode {
  code: string;
  source: string;        // identifier of the authorized source
  discoveredAt: string;  // ISO-8601
}

interface GiftCodeSource {
  // Discover/list candidate gift codes from a SEPARATELY AUTHORIZED source.
  // Status: NOT AUTHORIZED. No scraping, no undocumented game endpoint.
  listCandidateCodes(): Promise<DiscoveredCode[]>;
}
```

- The **registration consumer reads active codes from D1** (`gift_codes` where
  `status='active'`), never from `WhiteoutProvider`.
- `MockWhiteoutProvider` is the default in development, automated tests, and staging. It
  accepts the `PlayerRef` + `idempotencyKey` signature, produces deterministic, configurable
  outcomes (`success`, `already_redeemed`, `retryable` for simulated rate limits and 5xx,
  `permanent` for invalid/expired codes), and is idempotent by construction — the same
  `idempotencyKey` never applies a code twice.
- `already_redeemed` is a **success-equivalent terminal outcome**, not a failure. It counts
  toward "codes applied" / "players" in operation totals and user-facing summaries; a
  summary may render a parenthetical note but never lists it as a failure
  ([§15.3](#153-completion-accounting), [§17](#17-retry-and-permanent-failure-classification)).
- Error mapping is a table owned by the adapter (provider signal → outcome + `reasonCode`);
  see [whiteout-provider-decision.md §6](whiteout-provider-decision.md#6-provider-rate-limits-and-error-mapping).
- All Whiteout Survival access goes through `WhiteoutProvider`, serialized per
  `(player_id, code)` by the global `redemptions` record. Real redemption stays disabled
  until an authorized provider and its API contract are documented and approved.

---

## 12. Preliminary D1 data model

> **Preliminary — no migrations are authored in this task.** Column lists below are a
> design sketch for later implementation. All identifier columns are `TEXT`
> ([§10](#10-identifier-handling)).

### `players`

| Column | Type | Notes |
|---|---|---|
| `player_id` | TEXT PK | canonical digit string |
| `state` | TEXT | digit string; from input or `DEFAULT_STATE` |
| `state_updated_at` | TEXT NULL | set when an upsert changes `state`; triggers the guarded redemption reopen ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)) |
| `display_name` | TEXT NULL | rendered as `ID <player_id>` when null |
| `created_at`, `updated_at` | TEXT | ISO-8601 |

Re-registration = upsert on `player_id`.

### `gift_codes`

| Column | Type | Notes |
|---|---|---|
| `code` | TEXT PK | dedupe key |
| `status` | TEXT | `active` / `expired` / `disabled` |
| `discovered_at` | TEXT | |
| `source` | TEXT | authorized-source identifier |
| `first_seen_event_id` | TEXT NULL | provenance |

### `processed_events` (event-acceptance state machine)

| Column | Type | Notes |
|---|---|---|
| `event_id` | TEXT PK | Discord message id; the atomic marker |
| `kind` | TEXT | `registration` |
| `status` | TEXT | `accepted_invalid` / `accepted_valid` / `work_committed` / `finalized` |
| `outcome` | TEXT NULL | `invalid` / `valid` |
| `operation_id` | TEXT NULL | set in the same atomic unit when `accepted_valid` |
| `validation_reason` | TEXT NULL | set in the same atomic unit when `accepted_invalid` |
| `output_delivery_group` | TEXT | groups `discord_output_deliveries` rows for this event's validation reply (invalid) |
| `received_at`, `accepted_at`, `committed_at`, `finalized_at` | TEXT NULL | lifecycle timestamps |

The row is **only ever inserted in the same `db.batch()`** as the validation-reply delivery
row (invalid) or the registration work + outbox rows (valid). No earlier bare insert
exists. A PK conflict on insert ⇒ duplicate delivery ⇒ the whole batch rolls back ⇒ ack,
no-op. In state-machine mode, `status` stays non-terminal (`accepted_valid`) until
`work_committed`; the sweeper re-drives anything stuck.

### `redemptions` (global provider-call authority)

| Column | Type | Notes |
|---|---|---|
| `player_id` | TEXT | PK part |
| `code` | TEXT | PK part |
| `idempotency_key` | TEXT | deterministic, stable per pair — e.g. `redeem:v1:<player_id>:<code>`; **kept stable across re-evaluations** so a compliant provider still dedupes a genuine prior `success` |
| `status` | TEXT | `pending` / `in_progress` / `success` / `already_redeemed` / `permanent_failure` / `retry_exhausted`; may transition `permanent_failure → pending` (guarded state reopen) or `permanent_failure` / `retry_exhausted → pending` (operator `repair_run`); **`success` / `already_redeemed` never transition** — see the state-transition table in [§15.2](#152-global-redemption-record--the-sole-provider-call-authority) |
| `current_attempt_id` | TEXT NULL | the durable `attempt_id` currently authorised to call the provider for this pair (from the queue message body); every terminal write is guarded on `current_attempt_id = :attempt_id` |
| `attempt_expires_at` | TEXT NULL | lease for `current_attempt_id` (`REDEMPTION_CLAIM_LEASE_SECONDS`); the **same** owner re-stamps it on every redelivery of its message |
| `attempt_state` | TEXT NULL | the `PlayerRef.state` the `current_attempt_id` is using; compared against the current `players.state` before a state-dependent terminal (T7/T8) and on reopen |
| `attempt_generation` | INTEGER | audit counter, `+1` only when a **new** `attempt_id` is granted (not on same-attempt resume); not a guard |
| `attempts` | INTEGER | provider-call attempts made under `current_attempt_id` (`+1` on each resume; reset when a new attempt is granted or on reopen) |
| `reeval_count` | INTEGER | number of guarded reopens; capped by `REDEMPTION_MAX_REEVAL` |
| `provider_receipt` | TEXT NULL | optional reconciliation reference from a real provider |
| `reason_code` | TEXT NULL | for `permanent_failure` / `retry_exhausted`; classifies reopen eligibility ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)) |
| `first_claimed_at`, `terminal_at`, `updated_at` | TEXT NULL | |

PK `(player_id, code)`. This row — **not** `operation_items` — is the sole authority for
whether `WhiteoutProvider.redeem` may be called for the pair. A message that only ever
**contended** (never became `current_attempt_id`) can never write any status here.

### `operations`

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT PK | ULID/UUID |
| `type` | TEXT | `registration_run` / `code_distribution_run` / `repair_run` |
| `trigger_kind` | TEXT | `discord_event` / `discovered_code` / `human_repair` |
| `trigger_ref` | TEXT | event id, `code`, or origin `operation_id` |
| `snapshot_at` | TEXT | boundary timestamp |
| `expected_count` | INTEGER | fixed at snapshot; `0` allowed |
| `expansion_state` | TEXT | `pending` / `expanding` / `expanded` |
| `expansion_cursor` | TEXT NULL | last `player_id` expanded, fixed sort order |
| `state` | TEXT | `pending` / `in_progress` / `awaiting_summary` / `summarized` / `stale_closed` |
| `deadline_at` | TEXT | `snapshot_at + OPERATION_DEADLINE_SECONDS` |
| `summary_state` | TEXT | `none` / `sealing` / `building` / `built` / `delivering` / `delivered` (real per-chunk state lives in `discord_output_deliveries`) |
| `snapshot_cursor` | TEXT NULL | resumable keyset cursor of the **seal** pass over `operation_items` — the last `(player_id, code)` sealed (a stable keyset that never reorders); NULL until sealing starts |
| `snapshot_sealed_at` | TEXT NULL | set when every row is copied into `summary_item_snapshot` and `summary_state` becomes `building` |
| `summary_delivery_group` | TEXT NULL | groups this operation's summary chunk rows — deterministic, `sum:<operation_id>` |
| `summary_chunk_total` | INTEGER NULL | set when the layout pass completes; `≤ SUMMARY_MAX_CHUNKS` |
| `summary_layout_cursor` | TEXT NULL | the last `summary_item_snapshot.sort_key` folded by the layout pass (resumable; the snapshot is immutable so the keyset is stable) |
| `summary_layout_open` | TEXT NULL | JSON accumulator for the not-yet-sealed chunk — `{first_sort_key, bytes, chunk_index}` — persisted **in the same `db.batch()`** as `summary_layout_cursor` and any newly-sealed `summary_chunk_layout` rows |
| `summary_build_cursor` | INTEGER | last `chunk_index` persisted by the render pass (default `0`, resumable) |
| `success_count` / `already_redeemed_count` / `permanent_failure_count` / `retry_exhausted_count` / `completed_count` | INTEGER NULL | **cache only**, recomputed from `operation_items` at build time |
| `created_at`, `updated_at` | TEXT | |

### `operation_items`

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `item_key` | TEXT | PK part — `code` (registration) or `player_id` (distribution) |
| `player_id` | TEXT | resolved pair member |
| `code` | TEXT | resolved pair member |
| `job_id` | TEXT | `registration:<operation_id>:<code>` / `distribution:<operation_id>:<player_id>` |
| `status` | TEXT | `pending` / `in_progress` / `success` / `already_redeemed` / `permanent_failure` / `retry_exhausted` (mirrors the global `redemptions` outcome) |
| `claim_token` | TEXT NULL | holds the owning `attempt_id`; a redelivered owner message resumes the lease via `claim_token = :attempt_id` |
| `claim_expires_at` | TEXT NULL | lease expiry (`ITEM_CLAIM_LEASE_SECONDS`) |
| `reason_code` | TEXT NULL | |
| `attempts` | INTEGER | |
| `updated_at` | TEXT | |

PK `(operation_id, item_key)`. The item lease dedupes queue redeliveries and drives
completion accounting; it does **not** authorize a provider call. It is keyed by the same
`attempt_id` as the global claim so one owner resumes **both** gates on redelivery.

### `operation_players_snapshot` (distribution runs only; optional)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `player_id` | TEXT | PK part |

Point-in-time player boundary when a monotonic cursor filter is not used.

### `summary_item_snapshot` (immutable rendered inputs, sealed once)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `player_id`, `code` | TEXT | PK parts — the **stable keyset** (never reordered by status changes) |
| `status` | TEXT | the `operation_items` status **at seal time** (`still_pending` for a partial/`stale_closed` summary) |
| `reason_code` | TEXT NULL | captured at seal time |
| `display_label` | TEXT | the **already-sanitised** rendered label (`players.display_name` sanitised, or `ID <player_id>`), captured at seal time |
| `sort_key` | TEXT | sortable rendering order, `printf('%d\|%s\|%s', status_rank(status), player_id, code)` (`status_rank`: `success`,`already_redeemed`,`permanent_failure`,`retry_exhausted`,`still_pending`); fixed at seal time |
| `created_at` | TEXT | |

PK `(operation_id, player_id, code)`. Written by the paged **seal** pass
([§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery))
reading `operation_items` in `(player_id, code)` order (each row sealed exactly once, so a
mid-seal status change cannot reorder or duplicate it); `ON CONFLICT DO NOTHING`.
**Immutable after seal** — later `operation_items` status changes and `players.display_name`
edits never touch it. Both the layout and render passes read **only** this table,
`ORDER BY sort_key`.

### `summary_chunk_layout` (deterministic item→chunk assignment)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `chunk_index` | INTEGER | PK part, 1-based |
| `first_sort_key`, `last_sort_key` | TEXT | inclusive `summary_item_snapshot.sort_key` bounds rendered into this chunk |
| `overflow_remaining` | INTEGER NULL | on the final chunk when the summary is capped: how many snapshot rows are represented by the `"+N more not listed"` line |
| `created_at` | TEXT | |

PK `(operation_id, chunk_index)`. Written in bounded pages by the layout pass; rows are a
pure function of the immutable `summary_item_snapshot`, so a crash-resumed layout
re-derives identical rows (`ON CONFLICT DO NOTHING`).

### `discord_output_deliveries` (durable per-message output)

| Column | Type | Notes |
|---|---|---|
| `delivery_id` | TEXT PK | deterministic — e.g. `out:<group>:<chunk_index>` |
| `delivery_group` | TEXT | `output_delivery_group` (event) or `summary_delivery_group` (operation) |
| `event_id` | TEXT NULL | set for validation replies |
| `operation_id` | TEXT NULL | set for operation summaries |
| `channel_id` | TEXT | target channel |
| `output_type` | TEXT | `validation_reply` / `registration_summary` / `distribution_summary` / `partial_summary` |
| `chunk_index` | INTEGER | 1-based |
| `chunk_total` | INTEGER | total chunks in this logical message |
| `content` | TEXT | immutable rendered chunk text (or store `content_hash` and rebuild deterministically) |
| `content_hash` | TEXT | hash of `content` for tamper/consistency checks |
| `has_footer` | INTEGER | 1 only when `chunk_index = chunk_total` **and** `output_type` ≠ `validation_reply` |
| `nonce` | TEXT | deterministic, **≤ 25 chars**, derived by hashing `delivery_id` **[fact:D6]** |
| `status` | TEXT | `pending` / `claimed` / `sent` / `superseded` |
| `claim_token` | TEXT NULL | current claimant |
| `claim_expires_at` | TEXT NULL | lease expiry (`OUTPUT_CLAIM_LEASE_SECONDS`) |
| `attempts` | INTEGER | send attempts |
| `discord_message_id` | TEXT NULL | recorded after Create Message |
| `sent_at`, `created_at`, `updated_at` | TEXT NULL | |

All chunks of a logical message are built and persisted **before any are sent**. The
dispatcher sends them in `chunk_index` order and resumes at the first non-`sent` row.

### `outbox_jobs`

| Column | Type | Notes |
|---|---|---|
| `job_id` | TEXT PK | per-item deterministic id (see `operation_items.job_id`) |
| `operation_id` | TEXT | |
| `item_key` | TEXT | |
| `type` | TEXT | `registration` / `distribution` |
| `attempt_id` | TEXT | durable identity of the current attempt; minted at row creation, **re-minted** on every reset to `pending` (atomic-reopen, sweeper re-drive); copied into `payload_json`; **not** changed by `message.retry` |
| `payload_json` | TEXT | the queue message body `{operation_id, item_key, job_id, player_id, code, attempt_id}` |
| `status` | TEXT | `pending` / `enqueued` / `dead` |
| `attempts` | INTEGER | |
| `available_at` | TEXT | backoff gate |
| `last_error` | TEXT NULL | |
| `created_at`, `updated_at` | TEXT | |

---

## 13. Cloudflare Queue and dead-letter-queue boundaries

- **Queues:** `registration-jobs`, `code-fanout-jobs`. One message per unit of work,
  carrying `{operation_id, item_key, job_id, player_id, code, attempt_id}` in the body.
  `attempt_id` is the durable identity of this attempt: it is minted when the `outbox_jobs`
  row is created or reset to `pending`, and **`message.retry` re-delivers the same body, so
  it is stable across an owner-path retry**. Cloudflare Queues exposes **no producer-side
  idempotency key** — deduplication is entirely consumer-side **[fact:C7]**. Delivery is
  at-least-once, so consumers must be safely re-runnable.
- **Batching / limits:** batch size ≤ 100 messages / 256 KB, batch wait ≤ 60 s, message
  ≤ 128 KB, `delaySeconds` ≤ 24 h, `max_retries` up to 100 **[fact:C8]**. `message.retry({
  delaySeconds })` with backoff up to `PROVIDER_MAX_RETRIES` is used **only** on the owner
  path for provider `retryable` outcomes; on each redelivery the owner re-acquires its own
  `attempt_id` (T2) and re-stamps `attempt_expires_at`, so the retry budget and the
  eventual DLQ ownership stay attached to that one durable attempt.
- **Contention is never a retry.** When a consumer's `attempt_id` is **not** the global
  row's `current_attempt_id` and that incumbent lease is live (T4), the consumer
  **releases its `operation_items` lease, `ack`s the message, and stops**. It never calls
  the provider, never calls `message.retry`, and never touches the global row. The pair is
  re-driven later by the Operation sweeper as a **fresh job with a fresh `attempt_id` and a
  fresh `max_retries` budget**. Consequence: **every message that reaches `redemption-dlq`
  is a specific `attempt_id`'s owner-path attempt that had spent its retries** — a
  contention message can never reach the DLQ.
- **DLQ:** `redemption-dlq` receives a message only after its owner-path attempt exhausts
  `max_retries` **[fact:C6]** — so a DLQ message unambiguously means "the attempt named by
  its `attempt_id` is gone with its retries spent". The inspection consumer terminalizes on
  an **exact `attempt_id` match** (T9), with **no lease or generation check**:
  ```sql
  UPDATE redemptions
     SET status = 'retry_exhausted', reason_code = 'provider_retry_exhausted',
         current_attempt_id = NULL, attempt_expires_at = NULL,
         terminal_at = :now, updated_at = :now
   WHERE (player_id, code) = (:pid, :code)
     AND status = 'in_progress'
     AND current_attempt_id = :msg_attempt_id;      -- the exact attempt whose budget was spent
  ```
  If `current_attempt_id <> :msg_attempt_id` (a newer attempt has taken over — **whether or
  not its lease has since expired**, T10), the write matches nothing: the DLQ message is
  **audit-only**, records a `dlq_stale_attempt` diagnostic, and changes nothing. If the row
  is already terminal or `pending`, it does nothing. When it does terminalize it mirrors
  `retry_exhausted` onto every non-terminal `operation_items` row for the pair. A stale DLQ
  message therefore can never terminalize a newer attempt. **Business-rule (`permanent`)
  failures never enter the DLQ** — they are recorded as terminal outcomes directly.
- Discord output delivery does **not** use a queue or DLQ: it is a Cron + inline dispatcher
  over `discord_output_deliveries` rows, with `attempts` and an alert after
  `OUTPUT_DISPATCH_MAX_ATTEMPTS`.

---

## 14. Transactional outbox

**Decision:** a per-item transactional outbox bridges the gap between a committed D1 intent
and a Queue enqueue. This design is **intended to prevent loss between the committed D1
intent and eventual Queue enqueue, subject to the documented platform guarantees and the
recovery process below** — it is not an absolute "no loss" claim.

- **Atomic write:** each page of domain rows is written together with its per-item
  `outbox_jobs` rows in a single `db.batch()` (atomic, all-or-nothing) **[fact:C9]** — the
  same unit as the `processed_events` marker for registration acceptance
  ([§5](#atomic-acceptance)). Large fan-out is written a bounded page at a time
  ([§7](#7-new-code-fan-out-flow)), never one unbounded batch.
- **Identity:** `job_id` is per unit of work
  (`registration:<operation_id>:<code>` / `distribution:<operation_id>:<player_id>`) and is
  carried in the queue message body alongside `operation_id`, `item_key`, `player_id`,
  `code`. The **consumer** uses it as the application-level dedup key (no producer key
  exists, [fact:C7]).
- **Dispatch:** (a) inline best-effort `queue.send()` immediately after a page commits,
  marking sent rows `enqueued`; (b) authoritative Cron dispatcher (every minute,
  [fact:C4]) scanning `status='pending' AND available_at <= now`, enqueuing, marking
  `enqueued`, and on failure setting `available_at` with exponential backoff and
  incrementing `attempts`. After `OUTBOX_DISPATCH_MAX_ATTEMPTS` the row is marked `dead` and
  an alert is raised.
- **`dead` handling — no ineffective requeue.** A `dead` outbox row means one unit of work
  never reached its queue. The dispatcher resolves it by one of two explicit paths,
  guarded on the operation's finalisation state:
  - **Atomic reopen (only while the summary has not started).** If
    `operations.summary_state = 'none'` **and**
    `operations.state NOT IN ('summarized','stale_closed')`, one `db.batch()` resets the
    `outbox_jobs` row to `pending` (`attempts = 0`, `available_at = now`, **a fresh
    `attempt_id`**) **and** the matching `operation_items` row to `pending`
    (`claim_token = NULL`). The guard makes the reset a no-op once the operation has moved
    on. (The summary reads an immutable snapshot sealed at `summary_state <> 'none'`, so
    `sealing` / `building` / `built` / `delivering` / `delivered` take the repair path
    below.)
  - **Human-triggered repair (summary already sealed / building / done).** If
    `operations.summary_state <> 'none'` **or** `operations.state IN
    ('summarized','stale_closed')`, the dispatcher records the `operation_items` row as
    `retry_exhausted` (reason `outbox_dead`) so accounting is closed, raises an alert, and
    creates a `repair_run` operation stub (`type = 'repair_run'`, `trigger_ref` = origin
    `operation_id`) listing the affected `(player_id, code)` pairs. A human triggers the
    repair, which reuses the global `redemptions` records and produces its own summary
    (its own snapshot). A finalized operation and its snapshot are **never** mutated in
    place.
- **Recovery:** on restart the dispatcher simply re-scans `pending`. The operation sweeper
  resets rows stuck in `enqueued` with no downstream progress past a threshold back to
  `pending`. A retention job deletes fully-accounted `enqueued` rows after a fixed period.

---

## 15. Redemption serialization, aggregation, and durable summary delivery

### 15.1 Operation-item lease (queue-dedup + accounting)

Each `operation_items` row carries a short lease so a redelivered or duplicated queue
message does not run the same item body twice, and so completion accounting is stable.

- **States:** `pending` → `in_progress` (`claim_token = attempt_id`, `claim_expires_at`) →
  `success` | `already_redeemed` | `permanent_failure` | `retry_exhausted`.
- **Atomic claim-or-resume** (the message body's `attempt_id` is `:aid`):
  ```sql
  UPDATE operation_items
     SET status = 'in_progress', claim_token = :aid, claim_expires_at = :exp, updated_at = :now
   WHERE operation_id = :op AND item_key = :key
     AND (status = 'pending'
          OR (status = 'in_progress' AND claim_token = :aid)          -- my own attempt resuming
          OR (status = 'in_progress' AND claim_expires_at < :now));   -- an expired lease, steal
  ```
  Proceed only if one row changed. A redelivery whose `attempt_id` **matches** `claim_token`
  resumes (re-stamps the lease) and proceeds to §15.2; a redelivery that finds the item
  terminal, or `in_progress` held by a **different** live `attempt_id`, is acked as a no-op.
- The item lease **does not authorize a provider call** — that is §15.2. It only guards the
  local item body (claim/resume the global redemption, mirror the outcome), keyed by the
  same `attempt_id` so one owner passes **both** gates.

### 15.2 Global redemption record — the sole provider-call authority

Before calling `WhiteoutProvider.redeem` for a `(player_id, code)` pair, a consumer **must
claim the global `redemptions` record** for that pair. This serializes redemption across
**all** operations (registration and distribution), which the per-operation item lease
cannot do on its own **[inference]**.

- **Deterministic key:** `idempotency_key = "redeem:v1:" + player_id + ":" + code`, stable
  for the life of the pair (**including across re-evaluations**), stored on the row and
  passed to the provider. Keeping it stable is deliberate: a compliant provider still
  dedupes a genuine prior `success`, while a reopened *non-applied* failure (e.g.
  `player_ineligible`) can safely be re-attempted.
- **Durable attempt identity:** the message body carries `attempt_id` (`:aid`), minted by
  the outbox layer and **unchanged by `message.retry`** ([§13](#13-cloudflare-queue-and-dead-letter-queue-boundaries)).
  The `redemptions` row's `current_attempt_id` names the one attempt currently authorised to
  call the provider. `attempt_generation` is an audit counter only.
- **Claim-or-resume** (one upsert; grants a new attempt **or** resumes the caller's own):
  ```sql
  INSERT INTO redemptions (player_id, code, idempotency_key, status,
                           current_attempt_id, attempt_expires_at, attempt_state,
                           attempt_generation, attempts, first_claimed_at, updated_at)
       VALUES (:pid, :code, :idk, 'in_progress', :aid, :exp, :state, 1, 1, :now, :now)
  ON CONFLICT (player_id, code) DO UPDATE SET
       status = 'in_progress',
       current_attempt_id = :aid,
       attempt_expires_at = :exp,
       attempt_state = :state,
       attempt_generation = redemptions.attempt_generation
                            + (CASE WHEN redemptions.current_attempt_id = :aid THEN 0 ELSE 1 END),
       attempts = (CASE WHEN redemptions.current_attempt_id = :aid
                        THEN redemptions.attempts + 1 ELSE 1 END),
       updated_at = :now
     WHERE redemptions.status = 'pending'                                            -- T1: free
        OR (redemptions.status = 'in_progress' AND redemptions.current_attempt_id = :aid)   -- T2: my own attempt resuming (lease live OR expired)
        OR (redemptions.status = 'in_progress' AND redemptions.attempt_expires_at < :now);  -- T3: a different attempt whose lease expired — steal
  ```

#### State-transition table (the single source of truth)

Every SQL guard, Queue-message field, DLQ rule, sweeper rule, and scenario below conforms
to this table. `A` = the caller's `attempt_id`; all rows require `PK = (:pid, :code)`.

| # | From (`status`, attempt) | Trigger | Guard | To | Attempt-field effect |
|---|---|---|---|---|---|
| T1 | `pending` | job for `A` | `status='pending'` | `in_progress` | `current_attempt_id=A`, `attempt_generation+=1`, `attempt_expires_at`, `attempt_state`, `attempts=1` |
| T2 | `in_progress` (`A`) | **redelivery of `A`** (owner retry) | `status='in_progress' AND current_attempt_id=A` | `in_progress` | keep `A` + `attempt_generation`; `attempts+=1`; re-stamp `attempt_expires_at`, `attempt_state` |
| T3 | `in_progress` (`B`, lease expired) | job for `A≠B` | `status='in_progress' AND current_attempt_id<>A AND attempt_expires_at<:now` | `in_progress` | `current_attempt_id=A`, `attempt_generation+=1`, …, `attempts=1` |
| T4 | `in_progress` (`B`, lease live) | job for `A≠B` | none of T1–T3 match | *(unchanged)* | `A` releases its `operation_items` lease and `ack`s — **contention** |
| T5 | `in_progress` (`A`) | provider `success` / `already_redeemed` | `status='in_progress' AND current_attempt_id=A` | `success` / `already_redeemed` | `current_attempt_id=NULL`, `attempt_expires_at=NULL`, `terminal_at` |
| T6 | `in_progress` (`A`) | provider `permanent`, reason ∈ {`code_invalid`,`code_expired`,`provider_bad_request`,`provider_auth_failed`} | `status='in_progress' AND current_attempt_id=A` | `permanent_failure` | `current_attempt_id=NULL`, `reason_code`, `terminal_at` |
| T7 | `in_progress` (`A`) | provider `permanent` = `player_ineligible`, **`attempt_state = players.state`** | `status='in_progress' AND current_attempt_id=A AND attempt_state=(SELECT state FROM players WHERE player_id=:pid)` | `permanent_failure` (`player_ineligible`) | `current_attempt_id=NULL`, `terminal_at` |
| T8 | `in_progress` (`A`) | provider `permanent` = `player_ineligible`, **`attempt_state <> players.state`** (obsolete-state result) | `status='in_progress' AND current_attempt_id=A AND attempt_state<>(…players.state) AND reeval_count<:max` | `pending` | `current_attempt_id=NULL`, `attempt_generation+=1`, `reeval_count+=1`, `reason_code=NULL`, `attempts=0` |
| T9 | `in_progress` (`A`) | **DLQ message whose `attempt_id`=`A`** (retries spent) | `status='in_progress' AND current_attempt_id=A` | `retry_exhausted` | `current_attempt_id=NULL`, `reason_code='provider_retry_exhausted'`, `terminal_at` |
| T10 | `in_progress` (`X`) | **DLQ message whose `attempt_id`=`A≠X`** | `current_attempt_id<>A` (write matches nothing) | *(unchanged)* | audit-only `dlq_stale_attempt`; never terminalizes — even if `X`'s lease has since expired |
| T11 | `in_progress` (`A`, lease expired) | Operation sweeper | `status='in_progress' AND attempt_expires_at<:now` | `pending` | `current_attempt_id=NULL`; sweeper re-enqueues a fresh `attempt_id` |
| T12 | `permanent_failure`/`player_ineligible` | valid re-registration changes `players.state` | atomic acceptance batch, `attempt_state<>:new_state AND reeval_count<:max` | `pending` | `attempt_generation+=1`, `reeval_count+=1`, `reason_code=NULL`, `terminal_at=NULL`, `attempts=0` |
| T13 | `permanent_failure` (code/operational) / `retry_exhausted` | operator `repair_run` | — | `pending` | `attempt_generation+=1`, `reeval_count+=1` |
| T14 | `permanent_failure`/`player_ineligible` (already terminal, predates T8) | Operation sweeper, `attempt_state<>players.state AND reeval_count<:max AND` a non-terminal `operation_items` waits | sweeper | `pending` | as T12 |
| T15 | `success` / `already_redeemed` | anything | — | *(immutable)* | — |

#### Consumer path

1. **Terminal already** (T15, or T5–T9/T13 already applied): the claim-or-resume `WHERE`
   does not match; the consumer **does not call the provider**, reads the terminal row, and
   mirrors the outcome onto its `operation_items` row.
2. **Claim granted or resumed** (T1 / T2 / T3): `current_attempt_id = A`. Call
   `redeem({ playerId, state }, code, idempotency_key)`. Then:
   - `success` / `already_redeemed` → **T5**, guarded `WHERE status='in_progress' AND
     current_attempt_id=:aid`; mirror onto `operation_items`.
   - `permanent` (code/operational reason) → **T6**, same guard; mirror.
   - `permanent` = `player_ineligible` → compare `attempt_state` with the current
     `players.state`: equal → **T7** terminal; different → **T8** back to `pending`
     (bounded by `REDEMPTION_MAX_REEVAL`) so a fresh attempt runs with the current state.
     A stale in-flight attempt can therefore never write the terminal result for a
     re-registered player.
   - `retryable` → `message.retry({ delaySeconds })`. The body (and `attempt_id`) is
     redelivered unchanged; on redelivery the consumer re-runs claim-or-resume → **T2**
     (`attempts+=1`, lease re-stamped) and calls the provider again. The retry budget stays
     attached to `A`.
3. **Contention** (T4): `current_attempt_id` is a **different** live attempt. The consumer
   releases its `operation_items` lease (`status='pending'`, `claim_token=NULL`) and
   `message.ack()`s. It never calls the provider, never `message.retry`, never writes to
   `redemptions`. Forward progress comes from the sweeper re-drive. A T4 message can never
   reach the DLQ and can never terminalize the shared row.

#### Terminal-write guards

Every terminal write to the global row — from a **consumer** (T5–T8) or the **DLQ
inspection consumer** (T9/T10) — carries `WHERE status = 'in_progress' AND
current_attempt_id = :attempt_id` (T7/T8 add the `attempt_state` vs `players.state`
comparison). There is **no** lease-time or `attempt_generation` check on a terminal write:
the exact `attempt_id` is the ownership proof. The sweeper's lease recovery (T11) moves the
row **only `in_progress → pending`** and never writes a terminal status.

#### Crash-safe re-drive (Operation sweeper)

Every minute, bounded by `SWEEPER_REDRIVE_BATCH`, the sweeper:

- **T11:** resets `redemptions` rows stuck `in_progress` past `attempt_expires_at` to
  `pending` (`current_attempt_id = NULL`);
- re-enqueues **one fresh job per pair** — with a **fresh `attempt_id`** and a fresh
  `max_retries` budget — where some `operation_items` row is non-terminal **and** the global
  `redemptions` row is non-terminal **and** has `current_attempt_id IS NULL` (or the lease
  just expired) — i.e. nobody is working it;
- **T14:** reopens an already-terminal `permanent_failure`/`player_ineligible` row whose
  `attempt_state <> players.state` and `reeval_count < REDEMPTION_MAX_REEVAL` while a
  non-terminal `operation_items` waits (catch-up for rows that turned terminal before T8);
- mirrors any now-terminal `redemptions` outcome onto every non-terminal `operation_items`
  row for the pair:
  ```sql
  UPDATE operation_items
     SET status = :mirror, reason_code = :rc, updated_at = :now
   WHERE (player_id, code) = (:pid, :code)
     AND status IN ('pending', 'in_progress');
  ```

This single mechanism covers contention `ack`s, owner crashes mid-retry, obsolete-state
terminals, and lost queue messages. While any `operation_items` for a pair is non-terminal
and the operation is within its deadline, the pair keeps being re-driven.

#### Terminality is per `reason_code`

| Outcome / `reason_code` | Terminality | Reopen path |
|---|---|---|
| `success`, `already_redeemed` | **immutable** (T15) | never |
| `permanent_failure` / `player_ineligible` (**state-dependent**) | terminal until the player's `state` changes | **T8** (before an obsolete-state attempt terminalizes), **T12** (atomic acceptance batch of a re-registration that changes `players.state`), or **T14** (sweeper catch-up); each guarded, `reeval_count += 1`, capped by `REDEMPTION_MAX_REEVAL`, after which only a `repair_run` (T13) may reopen it |
| `permanent_failure` / `code_invalid`, `code_expired` (**code-dependent**) | terminal | operator `repair_run` only (T13; e.g. after correcting `gift_codes.status`) |
| `permanent_failure` / `provider_bad_request`, `provider_auth_failed` (**operational**) | terminal | operator `repair_run` only (T13), after the operational cause is fixed |
| `retry_exhausted` (**operational**) | terminal for accounting | operator `repair_run` (T13); **or** a bounded sweeper auto-reopen after a cooldown when `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED = true` (capped by `REDEMPTION_MAX_REEVAL`) |

**T12 — state-change reopen** (runs inside the same atomic acceptance `db.batch()` as the
re-registration, [§5](#atomic-acceptance)):

```sql
UPDATE redemptions
   SET status = 'pending', current_attempt_id = NULL, attempt_expires_at = NULL,
       reason_code = NULL, terminal_at = NULL,
       attempts = 0, attempt_generation = attempt_generation + 1,
       reeval_count = reeval_count + 1, updated_at = :now
 WHERE player_id = :pid
   AND status = 'permanent_failure'
   AND reason_code = 'player_ineligible'               -- explicitly state-dependent only
   AND reeval_count < :max_reeval
   AND (attempt_state IS NULL OR attempt_state <> :new_state);
```

It never matches `success` / `already_redeemed` / code-dependent / operational rows. The
new registration operation's own `operation_items` for the pair then drive a fresh claim →
a fresh provider call (fresh `attempt_id`) with the new `state`. Already-`summarized`
operations and their sealed `summary_item_snapshot` are **not** retroactively changed.
`MockWhiteoutProvider` is idempotent by construction; a compliant production provider is
required to be, or acceptance fails
([whiteout-provider-decision.md §5](whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider)).

#### Crash ambiguity

If a real provider performs the redemption but the Worker crashes before the guarded
terminal write, the redelivered message re-enters the consumer path as **T2** (same
`attempt_id`) and calls the provider again. This is why a production `WhiteoutProvider`
**must** support a stable redemption idempotency key or an authorized reconciliation lookup
([whiteout-provider-decision.md §5](whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider));
without one, production redemption stays blocked.

### 15.3 Completion accounting

Counts are **derived on demand** from `operation_items`
(`SELECT status, COUNT(*) ... GROUP BY status`) as the source of truth; the counter columns
on `operations` are a recomputed cache. An operation is finalisable when
`count(status IN ('success','already_redeemed','permanent_failure','retry_exhausted')) >= expected_count`
(and, for distribution runs, `expansion_state = 'expanded'`).

**`applied` in a summary = `success` + `already_redeemed`.** `already_redeemed` is never
counted as a failure; a summary may append a parenthetical note (e.g. `"(already had 2)"`)
but the headline count includes it.

### 15.4 Deterministic, bounded, crash-resumable summary build and per-chunk delivery

A single nonce/message id cannot represent a chunked summary, and the chunk count grows with
the player list, so the build is **paged like fan-out expansion** — never one unbounded
Worker invocation or `db.batch()`. Summaries and invalid-input replies share the same
durable per-message model; a validation reply is the trivial one-chunk case.

**Deterministic identity (independent of build order).** For an operation, the summary's
`delivery_group = "sum:" + operation_id`. Chunk `k` has
`delivery_id = "out:" + delivery_group + ":" + k` and
`nonce = base62(hash(delivery_id))[:25]` (≤ 25 chars **[fact:D6]**). The rendered content of
chunk `k` is a pure function of `(operation_id, k)` and the **immutable
`summary_item_snapshot`** (ordered by `sort_key`) — never `operation_items` or `players`
after the seal.

**Seal (the atomic transition that freezes every rendered input).** When an operation
becomes finalisable ([§15.3](#153-completion-accounting)) **or** is force-closed at
`deadline_at`, a single guarded statement moves `summary_state: 'none' → 'sealing'`
(`WHERE summary_state = 'none'` — exactly one writer wins). Then a **paged seal pass** (page
size `SUMMARY_BUILD_PAGE_SIZE`) reads `operation_items` for the operation in **`(player_id,
code)` order** (the stable keyset — mid-seal `status` changes cannot reorder it), joins
`players` for the label, and — in one **bounded** `db.batch()` per page —
`INSERT … INTO summary_item_snapshot` (`status`/`reason_code`/**sanitised** `display_label`
captured now, `sort_key` computed from `status_rank(status)`) `ON CONFLICT
(operation_id, player_id, code) DO NOTHING`, advancing `operations.snapshot_cursor` (the last
`(player_id, code)` sealed). When the last row is copied, `summary_state: 'sealing' →
'building'` and `snapshot_sealed_at = now`. After the seal, **late `operation_items` status
changes and `players.display_name` edits update those base rows only** (the live audit
record) — the snapshot row already exists, so `ON CONFLICT DO NOTHING` leaves it untouched,
and the seal is deterministic under a resumed crash (each `(player_id, code)` is read once).

1a. **Layout pass (paged, resumable).** Read `summary_item_snapshot` `ORDER BY sort_key` in
    pages of `SUMMARY_BUILD_PAGE_SIZE`, resuming after `operations.summary_layout_cursor`.
    Fold each row into the open chunk, tracking `{first_sort_key, bytes, chunk_index}`
    (`operations.summary_layout_open`); when adding a row would exceed
    `DISCORD_MESSAGE_MAX_LENGTH` minus headroom for the `(part N/M)` marker **and** the
    footer (reserved on *every* chunk boundary so `chunk_total` never shifts), seal the open
    chunk. In one **bounded** `db.batch()` write the newly-sealed
    `summary_chunk_layout(operation_id, chunk_index, first_sort_key, last_sort_key)` rows
    (`ON CONFLICT DO NOTHING`) **and** `summary_layout_cursor = last sort_key read` **and**
    `summary_layout_open = {current open chunk}` — atomically, so a crash resumes with the
    partial chunk intact (no lost items, no reprocessing: the cursor always advances by a
    whole page and the open-chunk accumulator carries the remainder). If `chunk_index`
    reaches `SUMMARY_MAX_CHUNKS`, stop: the final chunk records `overflow_remaining`
    (snapshot rows beyond the cap) and will render a deterministic
    `"+<overflow_remaining> more not listed"` line. When the last snapshot row is folded,
    seal the final open chunk and set `operations.summary_chunk_total`
    (`summary_state` stays `'building'` — it covers both the layout and render passes).
1b. **Render + persist pass (paged, resumable, idempotent).** For `chunk_index` from
    `summary_build_cursor + 1`, in pages of `SUMMARY_BUILD_PAGE_SIZE`: read that chunk's
    `first_sort_key..last_sort_key` window from `summary_item_snapshot` (a bounded read),
    render its content with the `(part chunk_index/summary_chunk_total)` marker and — **only
    when `chunk_index = summary_chunk_total`** — the runtime footer; `INSERT` the
    `discord_output_deliveries` row (`status = 'pending'`, `has_footer` per the rule,
    deterministic `nonce`) `ON CONFLICT (delivery_id) DO NOTHING`; advance
    `summary_build_cursor` in the **same** `db.batch()`. When
    `summary_build_cursor = summary_chunk_total`, set `summary_state = 'built'`.
2. **Deliver (resumable).** The output delivery dispatcher (Cron + inline) processes the
   group in `chunk_index` order (`summary_state`: `built → delivering → delivered`):
   - claim: `UPDATE discord_output_deliveries SET status='claimed', claim_token=:tok,
     claim_expires_at=:exp WHERE delivery_id=:id AND (status='pending' OR
     (status='claimed' AND claim_expires_at < :now))`;
   - send via Create Message with the row's `nonce` and `enforce_nonce = true`;
   - record: `UPDATE ... SET status='sent', discord_message_id=:mid, sent_at=:now WHERE
     delivery_id=:id AND claim_token=:tok`.
   After a crash it **resumes at the first non-`sent` row**. When all rows are `sent`,
   `operations.summary_state = 'delivered'`.
3. **Footer placement.** The runtime footer from `AGENTS.md` is present **only in the row
   with `chunk_index = chunk_total`** and only for summary `output_type`s — never in a
   `validation_reply`, never in any earlier chunk.

Each pass does O(items) total work but a **strictly bounded** amount per invocation and per
`db.batch()`, keeping within D1 statement / bound-parameter / CPU limits **[fact:C9][fact:C10]**.

**Delivery guarantee.** One logical result per operation (or per invalid event), **delivered
at least once with bounded Discord nonce suppression**. Within Discord's few-minute
`enforce_nonce` window a re-send of the same chunk returns the existing message
**[fact:D6]**; **outside that window a duplicate chunk is possible**. Mitigations: short
dispatcher lease (`OUTPUT_CLAIM_LEASE_SECONDS`), deterministic content per chunk, and the
`sent` state gating re-sends. This document does not claim exactly-once Discord delivery.

### 15.5 Zero-result operations

If a `registration_run` snapshot has **zero active codes**, or a `code_distribution_run`
snapshot has **zero registered players**, `expected_count = 0` and the operation is
**immediately finalisable**. The seal pass writes zero `summary_item_snapshot` rows; the
layout pass produces `summary_chunk_total = 1` in one page; the render pass persists a
**single** `discord_output_deliveries` row (`chunk_index = chunk_total = 1`,
`has_footer = 1`) with a zero-result body (`"0 codes applied"` / `"applied to 0 players"`),
delivered by the same dispatcher. The runtime footer is present in that one chunk.

### 15.6 Scenario matrix

| Scenario | Handling |
|---|---|
| All items terminal | Seal `summary_item_snapshot` → layout pass → render pass → dispatcher delivers chunks in order → `summary_state = 'delivered'` |
| Owner-path `retryable` result | Consumer `message.retry`s; the body (and `attempt_id`) is redelivered unchanged; on redelivery **T2** re-acquires the same attempt (`attempts += 1`, lease re-stamped) and calls the provider again. The retry budget stays attached to that `attempt_id`. |
| A different attempt hits a **live** incumbent (T4) | The consumer releases its `operation_items` lease and `ack`s — no `message.retry`, no `max_retries` consumed, no write to `redemptions`; the sweeper re-drives the pair with a **fresh `attempt_id`** or mirrors the outcome once the incumbent terminalizes |
| A DLQ message for `attempt_id` A (retries spent) | **T9** if `redemptions.current_attempt_id = A` → `retry_exhausted`; **T10** if a newer attempt has taken over (`current_attempt_id ≠ A`, **even if that newer lease has since expired**) → audit-only `dlq_stale_attempt`, no write. No lease/generation check. |
| Owner crashes mid-retry | Its message stops re-stamping; `attempt_expires_at` passes → sweeper **T11** resets `in_progress → pending` (never terminal) and re-enqueues a **fresh `attempt_id`**. A late DLQ message for the old `attempt_id` is T10 (no-op). |
| Player changes `state` while an old-state attempt is still `in_progress` | The old attempt's `player_ineligible` result hits **T8**: `attempt_state ≠ players.state` ⇒ the row goes back to `pending` (bounded by `REDEMPTION_MAX_REEVAL`) instead of terminalizing; a fresh `attempt_id` re-drives with the current `state`. **T14** (sweeper) is the catch-up for rows that turned terminal before T8 existed. |
| Player re-registers with a corrected `state` after a terminal `player_ineligible` | **T12** inside the atomic acceptance batch: `permanent_failure → pending`, guarded on `attempt_state ≠ new state`, `reeval_count += 1`, capped; the new operation's items re-drive a fresh attempt with the new `state`; `success` / `already_redeemed` are never reopened (T15) |
| An `outbox_jobs` row goes `dead` **before** the seal | Dispatcher **atomic-reopens** the outbox row (fresh `attempt_id`) + item row (guarded on `summary_state='none'`) |
| An `outbox_jobs` row goes `dead` after the seal / finalization | Item recorded `retry_exhausted (outbox_dead)`; alert; `repair_run` stub; finalized operation and its snapshot not mutated |
| Operation misses `deadline_at` | Sweeper → `state = 'stale_closed'` **and seals the snapshot then** (non-terminal items captured as `still_pending`); a **partial** summary (`output_type = 'partial_summary'`) is built from that immutable snapshot; late terminalizations update `operation_items` only — no re-render, no second summary |
| Late redemption result **or** `players.display_name` change after the seal | The base `operation_items` / `players` row is updated (live audit); `summary_item_snapshot` is immutable, so no pass re-computes a different boundary or content |
| Layout page ends mid-chunk | The open-chunk accumulator (`summary_layout_open = {first_sort_key, bytes, chunk_index}`) is persisted **in the same `db.batch()`** as `summary_layout_cursor`; the next invocation resumes the partial chunk exactly |
| Crash mid seal / layout / render | Resume from `snapshot_cursor` / (`summary_layout_cursor` + `summary_layout_open`) / `summary_build_cursor`; re-derived rows are byte-identical (`ON CONFLICT DO NOTHING`) |
| Summary would exceed `SUMMARY_MAX_CHUNKS` | Layout stops at the cap; the final chunk carries a deterministic `"+N more not listed"` line; footer still only in that final chunk |
| Crash after some summary chunks sent | Dispatcher resumes at the first non-`sent` `discord_output_deliveries` row |
| Crash after a chunk was accepted by Discord but before recording `discord_message_id` | Re-send uses the same per-chunk `nonce` + `enforce_nonce`; inside the window Discord returns the existing message; outside it a duplicate chunk is possible (documented residual risk) |
| Crash between event accept and work commit (state-machine mode) | `processed_events.status` is still `accepted_valid`; the sweeper re-drives expansion; the marker is never `finalized` without the work |

---

## 16. Idempotency

| Layer | Key | Mechanism |
|---|---|---|
| Discord event acceptance | `processed_events.event_id` | marker inserted **only** in the same atomic `db.batch()` as the validation-reply delivery row (invalid) or the registration work + outbox rows (valid); PK conflict ⇒ whole batch rolls back ⇒ duplicate no-op; state-machine mode keeps `status` non-terminal until `work_committed` |
| Player | `players.player_id` | upsert |
| Gift code | `gift_codes.code` | unique |
| **Redemption (global)** | `redemptions (player_id, code)` | claim-or-resume upsert keyed by the durable `attempt_id`; **sole provider-call authority**; deterministic `idempotency_key` (stable across re-evaluations); **every terminal write (consumer or DLQ) guarded on `current_attempt_id = :attempt_id` + `status='in_progress'`** — no lease/generation check; state-dependent terminal adds `attempt_state` vs `players.state`; `success` / `already_redeemed` immutable (T15); contention (T4) writes nothing here; full transition table in [§15.2](#152-global-redemption-record--the-sole-provider-call-authority) |
| Operation item | `operation_items (operation_id, item_key)` | PK + short lease keyed by the same `attempt_id` (queue-dedup + accounting only); mirrors the global outcome |
| Outbox → Queue | `outbox_jobs.job_id` + `attempt_id` in the message body | **consumer-side** dedup (no producer key, [fact:C7]); `attempt_id` re-minted only on a reset to `pending`, never on `message.retry` |
| Summary rendered inputs | `summary_item_snapshot (operation_id, player_id, code)` (ordered by `sort_key`) | sealed once (`summary_state: none → sealing → building`) reading `operation_items` in stable `(player_id, code)` order, `ON CONFLICT DO NOTHING`; immutable after seal; both build passes read only this |
| Discord output (per chunk) | `discord_output_deliveries.delivery_id` + deterministic `nonce`; `summary_chunk_layout (operation_id, chunk_index)` | `delivery_id` / `nonce` / content are pure functions of `(operation_id, chunk_index)` + the immutable snapshot; seal / layout / render passes resume from `snapshot_cursor` / (`summary_layout_cursor` + `summary_layout_open`) / `summary_build_cursor` with `ON CONFLICT DO NOTHING`; `enforce_nonce` bounded suppression ([fact:D6]); delivery resumes at first unsent chunk |

Queues are at-least-once **[fact:C7][fact:C8]**; every consumer is written to be safely
re-runnable.

---

## 17. Retry and permanent-failure classification

| Provider / transport signal | Class (`reason_code`) | Action | Reopen |
|---|---|---|---|
| HTTP 429, `Retry-After` present | `retryable` | owner path (T2): `message.retry`, honour `Retry-After`, exponential backoff, re-stamp `attempt_expires_at` | — |
| HTTP 5xx, connection reset, timeout | `retryable` | owner path (T2): retry with backoff up to `PROVIDER_MAX_RETRIES` | — |
| Provider "rate limited" / "temporarily unavailable" | `retryable` | owner path (T2): retry with backoff | — |
| Redemption succeeded now | `success` | T5 terminal, guarded on `current_attempt_id`; record `provider_receipt` if returned | **never** (T15) |
| Redemption already applied for this pair | `already_redeemed` | T5 **terminal, success-equivalent**; no retry; counts toward `applied`; never a failure | **never** (T15) |
| Invalid / expired / disabled code | `permanent` (`code_invalid` / `code_expired`) | T6 terminal `permanent_failure`, no retry, **never DLQ** | operator `repair_run` (T13) only |
| Player ineligible / unknown to the game | `permanent` (`player_ineligible`) — **state-dependent** | T7 if `attempt_state = players.state`; **T8** (row → `pending`) if `attempt_state ≠ players.state` — a stale in-flight attempt never terminalizes | T8 / T12 / T14 (guarded `state` mismatch, `reeval_count += 1`, capped by `REDEMPTION_MAX_REEVAL`); then `repair_run` only |
| Bad request / auth failure | `permanent` (`provider_bad_request` / `provider_auth_failed`) — operational | T6 terminal `permanent_failure` | operator `repair_run` (T13) only, after the cause is fixed |
| Input validation failure (bad `PLAYER_ID`) | n/a | never reaches a queue; durable validation reply instead ([§5](#invalid-message-reply)) | — |
| Owner-path attempt exhausts retries | `retry_exhausted` | message → `redemption-dlq`; the global row is set `retry_exhausted` **only** by the DLQ consumer's exact-`attempt_id` write (T9); a stale `attempt_id` message is audit-only (T10); mirrored items marked `retry_exhausted` | operator `repair_run` (T13); or bounded sweeper reopen when `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED` |

Backoff, `delaySeconds`, and `PROVIDER_MAX_RETRIES` stay within Queue limits **[fact:C8]**.
Contention never consumes the retry budget ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)).

---

## 18. Discord output safety

- **Sanitisation:** display names and any echoed user input are sanitized
  (strip/escape backticks, `@`, `#`, `:` role/emoji triggers, zero-width and control
  characters; cap length). Sanitisation happens **at seal time**, and the sanitised
  `display_label` is frozen in `summary_item_snapshot`; the render pass never re-reads
  `players`, so a later name change cannot alter an in-progress or delivered summary.
- **Mention suppression:** every Create Message call sets `allowed_mentions` to an empty
  allow-list so `@everyone`, role, and user mentions never fire.
- **No silent mutation:** the service never edits or deletes a message it did not just
  create; summaries and replies are new messages only.
- **Deterministic chunking:** the layout pass splits on `summary_item_snapshot` row
  boundaries (never mid-item), hard-caps each chunk below `DISCORD_MESSAGE_MAX_LENGTH`, adds
  `(part N/M)` continuation markers, and persists **every chunk (in bounded, cursor-resumable
  pages — [§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery))
  before any is sent**. Each chunk has its own deterministic ≤ 25-char nonce and its own
  delivery state.
- **Footer scope:** the runtime footer defined in `AGENTS.md` is present **only in the final
  persisted chunk** (`chunk_index = chunk_total`) of a summary or partial summary emitted
  after gift-code processing. It is never in an earlier chunk, never in a
  `validation_reply`, and never in logs, docs, commit messages, or PR descriptions. This
  document does not reproduce the footer string; the authoritative text lives in `AGENTS.md`.

---

## 19. Staging and production separation

| Resource | Separation |
|---|---|
| D1 database | distinct database per stack; distinct binding name |
| Queues (`registration-jobs`, `code-fanout-jobs`, `redemption-dlq`) | distinct queues per stack |
| Durable Object namespace (Option 1) | distinct namespace per stack |
| Discord application + bot token | distinct app and `DISCORD_BOT_TOKEN` per stack |
| Cron Triggers | defined per stack; **≤ 5 per account on Free, ≤ 250 on Paid** [fact:C5] |
| Secrets | never shared; set per stack via Wrangler secrets |
| `SPIKE_SENDER_ALLOWLIST` | **staging only**; consulted by **both** the `DiscordEventSource` (forwards allow-listed bot/webhook senders) and the Ingestion Worker (authoritative gate; asserts `ENVIRONMENT !== "production"`); undefined in the production config of both tiers |
| `PRODUCTION_REDEMPTION_ENABLED` | `false` in staging always; `false` in production until an authorized provider is approved |

Migrations are applied to staging first, then production, after review.

---

## 20. Observability without leaking secrets

- **Structured logs** with an explicit field allow-list: `environment`, `operation_id`,
  `operation_type`, `item_key`, `player_id`, `code`, `event_id` (correlation id), `status`,
  `reason_code`, `attempts`, `queue`, `delivery_id`, `chunk_index`, timings.
  **Never logged:** `DISCORD_BOT_TOKEN`, `INGESTION_SHARED_SECRET`, any future provider
  secret, `SPIKE_SENDER_ALLOWLIST` contents, raw message `content` beyond a
  truncated/sanitized preview needed for a validation-failure log, provider response bodies
  beyond mapped `reasonCode`s / `provider_receipt`.
- **Redaction helper** applied at the log boundary; unit-tested.
- **Metrics:** events accepted (valid / invalid); redemptions by outcome (`success` /
  `already_redeemed` / `retryable` / `permanent` / `retry_exhausted`); attempt outcomes
  (T1 grant / T2 resume / T3 steal / T4 contention-released); **sweeper re-drives**
  (fresh `attempt_id`); **`dlq_stale_attempt`** count (T10); **redemption re-evaluations**
  by trigger (T8 in-flight / T12 re-registration / T14 sweeper / T13 `repair_run`);
  operations by `state`; operations `stale_closed`; seal / layout / render cursor lag;
  **summaries capped at `SUMMARY_MAX_CHUNKS`**; `discord_output_deliveries` by `status`;
  unsent-chunk age; DLQ depth; queue backlog; outbox backlog and `dead` count; `repair_run`
  count; Gateway reconnect / RESUME / IDENTIFY counts (ingestion tier).
- **Alerts:** DLQ depth > 0, outbox `dead` count > 0, `dlq_stale_attempt` rate,
  `discord_output_deliveries` stuck `pending`/`claimed` beyond a threshold, operations stuck
  in `summary_state ∈ {sealing, building}` beyond a threshold, operations `stale_closed`
  rate, `repair_run` created, `reeval_count` hitting `REDEMPTION_MAX_REEVAL`, ingestion tier
  disconnected, IDENTIFY budget pressure.

---

## 21. Testing strategy

- **Mandated unit tests (`AGENTS.md`):** input validation; deduplication; retry
  classification; message chunking; provider error mapping.
- **Additional unit / integration tests:**
  - registration parser table (all four forms, numeric-vs-name second token, spaces in
    names, `DEFAULT_STATE` fallback, `ID <PLAYER_ID>` fallback);
  - string-identifier round-trips (no precision loss, leading zeros preserved);
  - **atomic acceptance:** valid-input batch commits marker + work + outbox together;
    invalid-input batch commits marker + validation-reply delivery row together; a simulated
    crash between accept and work-commit (state-machine mode) leaves `processed_events`
    non-terminal and is re-driven; PK conflict on a duplicate delivery rolls the whole batch
    back;
  - **global redemption serialization:** two operations referencing the same
    `(player_id, code)` result in exactly one provider call; the loser reuses the terminal
    outcome; a terminal `redemptions` row is mirrored onto every waiting `operation_items`
    row (via consumer and via sweeper);
  - **owner-path retry resumes the same attempt:** after a `retryable` result the
    redelivered message re-acquires its own `attempt_id` via **T2** (item + global gates),
    `attempts += 1`, and calls the provider again — the retry is not swallowed; the DLQ
    message for that `attempt_id` still owns the budget;
  - **contention is not a retry (T4):** a different attempt hitting a live incumbent
    releases its item lease and `ack`s — no `message.retry`, no `max_retries`, no DLQ, no
    `redemptions` write; the sweeper re-drives with a **fresh `attempt_id`**;
  - **DLQ binds to the exact `attempt_id` (T9/T10):** a DLQ message whose `attempt_id`
    equals `current_attempt_id` terminalizes `retry_exhausted`; a stale `attempt_id`
    (`current_attempt_id` is a newer attempt, **whether or not that newer lease has since
    expired**) is audit-only `dlq_stale_attempt` — it never terminalizes the newer attempt;
  - **state race (T8):** a `player_ineligible` result whose `attempt_state ≠ players.state`
    returns the row to `pending` instead of terminalizing; a fresh attempt runs with the
    current state; **T14** covers rows that turned terminal before T8; capped by
    `REDEMPTION_MAX_REEVAL`; `idempotency_key` unchanged; `success` / `already_redeemed`
    never reopen (T15);
  - **`already_redeemed`** counts toward `applied` and never as a failure in totals and
    rendered summaries;
  - **immutable summary snapshot:** the seal atomically freezes `status` / `reason_code` /
    sanitised `display_label` / ordering into `summary_item_snapshot`; a late
    `operation_items` change or `players.display_name` edit after the seal never alters
    layout boundaries or rendered content; both passes read only the snapshot;
  - **paged layout resumes an open chunk:** a layout page that ends mid-chunk persists
    `summary_layout_open = {first_sort_key, bytes, chunk_index}` **in the same `db.batch()`**
    as `summary_layout_cursor`; the resumed pass produces byte-identical chunks; no single
    `db.batch()` exceeds a bounded row count; a summary over `SUMMARY_MAX_CHUNKS` emits a
    deterministic `"+N more not listed"` line;
  - **durable output delivery:** dispatcher resumes at the first unsent chunk after a crash;
    validation reply carries no footer; re-send within the nonce window does not duplicate;
  - **outbox `dead`:** atomic reopen (fresh `attempt_id`) while `summary_state='none'`;
    `repair_run` stub once the snapshot is sealed / finalized; finalized operation and its
    snapshot never mutated in place;
  - **author filtering:** bot-, system-, webhook-, and own-application-authored messages are
    dropped in production by **both** the `DiscordEventSource` and the Worker; in staging the
    source forwards `SPIKE_SENDER_ALLOWLIST` senders and the Worker re-checks the same list;
    with the list unset (production config) both filters are strict;
  - item-lease concurrency (two workers, one winner; expired-lease steal);
  - zero-result operation finalisation; bounded-expansion resume from cursor.
- **Provider:** `MockWhiteoutProvider` in every automated test and in staging.
- **Runtime:** tests run under a Workers-compatible test runner; integration tests where
  available (local D1, local Queues).
- **Pre-finish gate:** run formatting, type checking, unit tests, and available integration
  tests. (At the time this document is authored the repository has no build yet; only
  Markdown checks apply — see [§24](#24-unresolved-decisions-and-risks).)

---

## 22. Failure modes and recovery

| Failure | Effect | Recovery |
|---|---|---|
| `DiscordEventSource` down | Live `MESSAGE_CREATE` events missed while down | Supervised restart; on reconnect, Discord replays only within session/Resume limits [fact:D1]; missed events need bounded REST catch-up or manual re-send ([§24](#24-unresolved-decisions-and-risks)) |
| Gateway Resume fails (Invalid Session `d=false`) | Fresh IDENTIFY required | Reconnect + IDENTIFY; watch the 1000/24 h IDENTIFY budget [fact:D1] |
| Ingestion Worker `/ingest` unavailable | Companion cannot forward | Companion retries with bounded local buffer; the atomic accept + PK conflict makes re-sends safe |
| Crash between event accept and work commit | Event `accepted_valid` but work incomplete | State-machine mode: `processed_events.status` non-terminal; sweeper re-drives expansion; marker never `finalized` without work. Single-batch mode: the marker only exists if the work committed |
| D1 unavailable | Atomic unit cannot commit | Ingestion returns 5xx; companion retries; nothing accepted or enqueued without a committed unit |
| Two operations target the same `(player_id, code)` | Risk of double provider call | Global `redemptions` claim-or-resume by `attempt_id`: one attempt is `current_attempt_id`, others reuse the terminal outcome or **release + `ack`** on T4 contention; sweeper re-drives with a fresh `attempt_id`; only the `attempt_id` owner terminalizes; outcome mirrored to all |
| Owner-path `retryable` result | Second provider attempt could be lost | The redelivered message re-acquires its own `attempt_id` (T2) through both gates, `attempts += 1`, and calls the provider again; the retry budget and eventual DLQ ownership stay with that `attempt_id` |
| Contending message (T4) | Could exhaust `max_retries` → DLQ → poison the shared row | Contention is off the retry path: release item lease + `ack`; the sweeper re-drives with a fresh `attempt_id`/budget; a T4 message can never write to the global row or reach the DLQ |
| Claim owner crashes mid-retry | Global row stuck `in_progress` | `attempt_expires_at` passes → sweeper **T11** resets `in_progress → pending` (never terminal), re-enqueues a fresh `attempt_id`; a late DLQ message for the old `attempt_id` is **T10** (no-op) |
| Stale DLQ message vs a newer attempt | Wrong `retry_exhausted` on the shared row | DLQ write is guarded `current_attempt_id = message.attempt_id AND status='in_progress'` (T9); if a newer attempt has taken over — **even if its lease has since expired** — the write matches nothing (T10, `dlq_stale_attempt`); it never overwrites a fresher attempt |
| Player changes `state` while an old-state attempt is still `in_progress` | Stale `player_ineligible` becomes the new registration's terminal | Before terminalizing, **T8** compares `attempt_state` with `players.state`; mismatch ⇒ row → `pending` (capped), fresh attempt with current state; **T14** sweeper catch-up for pre-T8 terminals |
| Player re-registers with corrected `state` after a terminal `player_ineligible` | Old failure would be reused forever | **T12** in the atomic acceptance batch reopens the guarded row (`permanent_failure → pending`, `reeval_count += 1`, capped); the new operation re-drives with the new `state`; `success` / `already_redeemed` never reopen |
| Provider redeems then Worker crashes before recording | Ambiguous redemption | Redelivery re-enters as T2 (same `attempt_id`) and calls again. Production requires a stable idempotency key or authorized reconciliation; until then production redemption is blocked. Mock is idempotent |
| Queue backlog | Delayed redemptions | Consumers scale (push concurrency up to 250, [fact:C8]); operations bounded by `deadline_at` |
| Provider outage / rate-limit storm | Many `retryable` failures | Owner-path backoff + `PROVIDER_RATE_LIMIT_PER_SECOND`; an attempt's retries exhaust → DLQ → `attempt_id`-guarded `retry_exhausted` (T9) + mirrored items; summary lists failures |
| DLQ growth | Redemptions stuck | Alert; DLQ consumer terminalises **only on an exact `attempt_id` match**; operator triage / `repair_run` |
| Very large player list → summary | One unbounded seal/build batch could exceed D1 limits | Paged seal + paged layout + paged render, each bounded per invocation and per `db.batch()`, cursor-resumable, capped at `SUMMARY_MAX_CHUNKS` |
| Late `operation_items` result or `players.display_name` change after the seal | A later pass could compute a different boundary / render different text | `summary_item_snapshot` is immutable after the seal; the base row is updated for audit only; both passes read only the snapshot |
| Crash mid seal / layout / render | Partial snapshot / layout / delivery rows | Resume from `snapshot_cursor` / (`summary_layout_cursor` + `summary_layout_open`) / `summary_build_cursor`; re-derived rows byte-identical (`ON CONFLICT DO NOTHING`) |
| Duplicate queue delivery | Repeated processing attempt | Absorbed by the item lease + the global redemption claim, both keyed by `attempt_id` |
| Partial fan-out (crash mid-expansion) | Some `operation_items` missing | Expansion worker resumes from `expansion_cursor`; finalisation waits for `expanded` |
| Outbox row `dead` before the seal | One unit of work never enqueued | Atomic reopen of the outbox row (fresh `attempt_id`) + item row (guarded on `summary_state='none'`) |
| Outbox row `dead` after the seal / finalization | Same, but the snapshot is sealed | Item `retry_exhausted (outbox_dead)`; alert; `repair_run` stub; no in-place mutation of the operation or its snapshot |
| Crash mid summary/reply delivery | Some chunks sent, some not | Dispatcher resumes at the first non-`sent` `discord_output_deliveries` row; duplicate possible only for a chunk re-sent outside the nonce window |

---

## 23. Phased implementation order

Each phase is its own branch + PR, starting from the merged `main`. No merge or deploy is
automated.

1. **Scaffold** — TypeScript strict, Wrangler config for the `staging` stack,
   `MockWhiteoutProvider`, test harness. Staging only.
2. **D1 schema + migrations** for the preliminary model ([§12](#12-preliminary-d1-data-model)).
3. **Ingestion Worker + `DiscordEventSource` interface + atomic acceptance + transactional
   outbox + Queues** — no real Gateway adapter yet; drive `/ingest` with synthetic
   `RegistrationMessageEvent`s (including bot/webhook cases).
4. **Consumers + global redemption serialization + operation aggregation + durable output
   delivery** — item lease, `redemptions` claim, deterministic per-chunk build/deliver,
   footer placement, zero-result handling, bounded expansion, outbox reopen / repair.
5. **ADR 0001 spike** — decide Option 1 vs Option 2 against the spike's pass/fail criteria.
6. **Chosen `DiscordEventSource` adapter** — implement the winner. *(Blocked until phase 5
   completes or is explicitly waived.)*
7. **Observability, sweepers, DLQ consumer, hardening.**
8. **Blocked** — authorized `WhiteoutProvider` / `GiftCodeSource`; production redemption.
   Requires the authorizations in
   [whiteout-provider-decision.md](whiteout-provider-decision.md).

---

## 24. Unresolved decisions and risks

### Resolved

- **Ingestion outcome framing:** spike Option 1 first, then decide. ADR 0001 stays
  **Proposed**; Option 2 is the provisional reference topology; Option 1 is not rejected;
  the real adapter is blocked until the spike completes or is explicitly waived.
- **Slash commands:** documented only in ADR 0001 (Option 3 / fallback), not as a secondary
  path here.
- **Event acceptance:** atomic (`processed_events` marker only in the same batch as the
  work or the validation-reply delivery row), with a resumable state machine as the
  large-write-set fallback.
- **Redemption serialization:** the global `redemptions (player_id, code)` record is the
  sole provider-call authority; operation items reuse its terminal outcome.
- **Durable attempt identity (`attempt_id`):** one owner-path retry stays attached to one
  `attempt_id` across `message.retry` (T2 resumes both the item and global gates); lease
  contention (T4) is off the retry path — the waiter releases + `ack`s and the sweeper
  re-drives with a **fresh `attempt_id`**; **every** global terminal write (consumer or DLQ)
  is guarded by `current_attempt_id = :attempt_id` alone (no lease/generation check);
  `attempt_generation` is an audit counter only. The single state-transition table
  (T1–T15) in §15.2 is the source of truth for all guards, the queue-message field, the DLQ
  rule, the sweeper rules, and the scenario matrix.
- **DLQ ↔ generation:** a DLQ message names one `attempt_id`; it terminalizes `retry_exhausted`
  only on `current_attempt_id = message.attempt_id` (T9). A stale `attempt_id` — a newer
  attempt has taken over, **whether or not its lease has since expired** — is audit-only
  (T10, `dlq_stale_attempt`).
- **State race:** a `player_ineligible` result whose `attempt_state ≠ players.state`
  returns the row to `pending` (**T8**) instead of terminalizing; **T12** covers a
  re-registration, **T14** the sweeper catch-up; all capped by `REDEMPTION_MAX_REEVAL`;
  `idempotency_key` stays stable; `success` / `already_redeemed` never reopen (T15).
- **Staging spike exception:** reachable at **both** the `DiscordEventSource` (forwards
  allow-listed bot/webhook senders) and the Ingestion Worker (authoritative gate); the
  production filter is unconditional because `SPIKE_SENDER_ALLOWLIST` is absent there.
- **Immutable summary snapshot:** an atomic seal (`summary_state: none → sealing → building`)
  freezes `status` / `reason_code` / sanitised `display_label` / ordering into
  `summary_item_snapshot`; both the layout and render passes read **only** that; late
  `operation_items` / `players` changes update the base rows for audit and never alter a
  started summary. A layout page that ends mid-chunk persists the open-chunk accumulator
  (`summary_layout_open`) with `summary_layout_cursor` in the same `db.batch()`.
- **Discord output:** durable per-chunk `discord_output_deliveries` built by a **paged,
  crash-resumable** seal + layout + render process over the immutable snapshot, bounded per
  `db.batch()`, capped at `SUMMARY_MAX_CHUNKS`; one logical result, at-least-once delivery,
  bounded duplicate suppression; footer only in the final chunk.
- **D1 → Queue reliability:** per-item transactional outbox carrying `attempt_id`; `dead`
  rows are atomic-reopened (fresh `attempt_id`) while `summary_state='none'`, or handed to a
  `repair_run` once the snapshot is sealed / finalized (no ineffective requeue).
- **`nonce` / `enforce_nonce`:** confirmed — `nonce` ≤ 25 chars; `enforce_nonce` checks
  uniqueness within the past few minutes and returns the existing message for a same-author
  repeat **[fact:D6]**.
- **`already_redeemed`:** explicit success-equivalent terminal outcome; counts toward
  `applied`, never a failure.

### Open

- Whether a permanently hosted Cloudflare Gateway client (Option 1) is reliable enough —
  the ADR 0001 spike decides.
- Where the companion runs if Option 2 stands (infra decision).
- `player_id` canonicalisation edge cases (max length; leading zeros — current lean:
  preserve verbatim).
- Tuning during implementation: lease durations (`ITEM_CLAIM_LEASE_SECONDS`,
  `REDEMPTION_CLAIM_LEASE_SECONDS` — an owner always resumes its **own** `attempt_id` (T2)
  regardless of lease, so this only bounds how long a *different* attempt waits before T3
  steal / T11 re-drive; set it comfortably above a few provider-retry `delaySeconds` cycles
  to avoid wasted parallel attempts, `OUTPUT_CLAIM_LEASE_SECONDS`),
  `FANOUT_EXPANSION_PAGE_SIZE`, `SUMMARY_BUILD_PAGE_SIZE`, `SUMMARY_MAX_CHUNKS`,
  `SWEEPER_REDRIVE_BATCH`, `REDEMPTION_MAX_REEVAL`, and the single-batch size threshold that
  triggers state-machine acceptance.
- Whether `repair_run` is fully automated later or stays human-triggered; whether
  `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED` is ever enabled in production.
- Missed-event backfill: bounded REST catch-up vs manual re-send only.
- The gift-code discovery source and its contract — not authorized.

### Risks

- Privileged `MESSAGE_CONTENT` intent could gate future scaling (approval needed above
  ~100 guilds / 10,000 users) **[fact:D3]**; mitigation: stay small or plan verification
  early.
- If Option 2 stands, the companion is a single point of failure for live ingestion;
  mitigation: supervised restart, health checks, alerting, atomic accept + PK conflict so
  re-sends are safe.
- Cloudflare hibernation/eviction timings (~10 s / ~70–140 s idle; 15-minute cap on how
  long an active outbound connection *prevents* eviction) are documented but operational
  **[fact:C1][fact:C2]**; the spike must observe actual behaviour and must not be read as a
  platform guarantee.
- Discord documents no exactly-once message creation; a summary chunk or validation reply
  re-sent outside the few-minute `enforce_nonce` window can duplicate **[fact:D6]** —
  mitigated, not eliminated.
- At-least-once delivery with no producer dedup key **[fact:C7]** ⇒ duplicate work unless
  the item lease and the global redemption claim are implemented exactly.
- A real provider that redeems but whose Worker crashes before the conditional
  `redemptions` write can double-apply a code — hence the production-provider
  idempotency-key / reconciliation requirement; until met, production redemption stays
  blocked.
- The gift-code source remaining unauthorized blocks any real end-to-end; staging stays on
  the mock provider indefinitely.

---

## 25. Official sources

Every fact tag above resolves here. All URLs are official
(`docs.discord.com/developers/*`, `developers.cloudflare.com/*`).

| Ref | URL | Facts used |
|---|---|---|
| D1 | <https://docs.discord.com/developers/events/gateway> | Connection lifecycle; Hello + `heartbeat_interval`; jittered first heartbeat; Heartbeat ACK, missed ACK → close with a non-`1000`/`1001` code then reconnect + Resume; Identify required, **1000 IDENTIFY / 24 h** globally (RESUME excluded); Resume needs `session_id` + `resume_gateway_url` + last `s`, no re-Identify; resumable vs non-resumable close codes; Invalid Session (`d` true/false); `1000`/`1001` invalidate the session; **120 gateway events / 60 s → immediate disconnect**; `max_concurrency` bounds IDENTIFY |
| D2 | <https://docs.discord.com/developers/events/gateway-events> | `MESSAGE_CREATE` "Sent when a message is created"; payload = message object + `guild_id?`, `member?`, `mentions`, `channel_type?` |
| D3 | <https://docs.discord.com/developers/topics/gateway> | `MESSAGE_CONTENT (1 << 15)` is a **privileged intent** gating `content`, `embeds`, `attachments`, `components`, `poll`; empty without it except own messages / DMs / mentions / message-context-menu targets; must be enabled in the Developer Portal; < 10,000 users self-enable, verified apps in 100+ guilds need approval; misconfiguration → close `4014` |
| D4 | <https://docs.discord.com/developers/topics/gateway#get-gateway-bot> | Get Gateway Bot returns `url`, `shards`, `session_start_limit` (`total`, `remaining`, `reset_after`, `max_concurrency`); "should not be cached for extended periods" |
| D5 | <https://docs.discord.com/developers/interactions/receiving-and-responding> | Gateway vs HTTP-webhook interactions are mutually exclusive; webhook must verify Ed25519 (`X-Signature-Ed25519` / `X-Signature-Timestamp`); initial response within **3 seconds**; 15-minute follow-up token; deferred types 5 / 6 |
| D6 | <https://docs.discord.com/developers/resources/message#create-message> | Create Message `nonce` is **at most 25 characters**; with `enforce_nonce=true` Discord checks nonce uniqueness **only within the past few minutes**, and for a same-author repeat in that window **returns the existing message instead of creating another**; no strict exactly-once message-creation guarantee |
| D7 | <https://docs.discord.com/developers/resources/message> | Message object fields: `author` (a user object), `author.bot`, `author.system`, `webhook_id` (present when the message is webhook-generated), `application_id`; `nonce` field type |
| C1 | <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/> | Stub creation ≠ instantiation; first call runs `constructor()`; **hibernation** after ~10 s idle only with no timers / in-progress `fetch()` / WebSocket API / active connections; **full eviction** ~70–140 s from the non-hibernatable idle state; eviction deferred until all outbound connections close **and** the 70–140 s window elapses; hibernation discards in-memory state; next request re-runs `constructor()` |
| C2 | <https://developers.cloudflare.com/durable-objects/best-practices/websockets/> | "Hibernation is only supported when a Durable Object acts as a WebSocket server. Outgoing WebSockets do not hibernate." "an active outbound WebSocket connection keeps the Durable Object alive and prevents eviction for up to 15 minutes per connection." (A cap on how long an active outbound connection *prevents* eviction — not a statement that the connection is closed or the object evicted at 15 minutes.) Serialized attachment max 16,384 bytes |
| C3 | <https://developers.cloudflare.com/durable-objects/api/alarms/> | One alarm per DO; **guaranteed at-least-once** execution; retried on throw with exponential backoff from 2 s, up to 6 retries; alarms persist across restarts; `constructor()` runs before `alarm()` |
| C4 | <https://developers.cloudflare.com/workers/configuration/cron-triggers/> | `triggers.crons`; `scheduled()` handler; **UTC**; minimum granularity every minute; config propagation up to ~15 min |
| C5 | <https://developers.cloudflare.com/workers/platform/limits/> | Cron Triggers **5 per account (Free) / 250 (Paid)**; Cron CPU 30 s (< 1 h interval) / 15 min (≥ 1 h), Paid; alarm handler max wall time 15 min |
| C6 | <https://developers.cloudflare.com/queues/configuration/dead-letter-queues/> | DLQ receives messages after `max_retries` is reached; default retries before DLQ = 3; DLQ messages with no consumer persist 4 days |
| C7 | <https://developers.cloudflare.com/queues/configuration/javascript-apis/> | `MessageBatch`; `ack()` / `ackAll()`; `retry({ delaySeconds })` / `retryAll(...)`; best-effort ordering; producer API carries `body` + `contentType` only — **no producer-side idempotency / dedup key**; at-least-once delivery |
| C8 | <https://developers.cloudflare.com/queues/platform/limits/> | Message ≤ 128 KB; **max retries 100**; consumer batch ≤ 100 messages / 256 KB; batch wait ≤ 60 s; `delaySeconds` ≤ 24 h; push consumer concurrency up to 250; consumer wall clock 15 min |
| C9 | <https://developers.cloudflare.com/d1/worker-api/d1-database/> | D1 is SQLite; `db.batch([...])` executes statements atomically in a single transaction; integer affinity / JS `number` lose precision beyond 2^53 — identifier columns should be `TEXT` |
| C10 | <https://developers.cloudflare.com/d1/platform/limits/> | D1 has per-query bound-parameter, SQL statement-size, rows-read/written, and per-invocation limits, and Worker CPU/time limits still apply — motivating bounded, paged writes (fan-out expansion, summary build) rather than one unbounded batch |

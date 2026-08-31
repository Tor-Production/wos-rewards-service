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
| `REDEMPTION_CLAIM_LEASE_SECONDS` | consumers, sweeper | **invocation** lease TTL (`redemptions.invocation_expires_at`); also the `retry_wait` "must be re-picked-up by" grace. **Set above the provider call timeout** so a lease does not expire mid-call ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)) |
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
  6. **if the accepted registration changed `players.state`**, the guarded **T13** reopen of
     any state-dependent (`player_ineligible`, under cap) `redemptions` failures for this
     `player_id` ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)) —
     never touching `success` / `already_redeemed` / `state_reevaluation_limit` rows. (An
     old-state attempt still `in_progress` is handled at terminalization by **T7** / **T8**,
     not here.)

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
    C->>DB: claim operation_items lease (coarse); acquire-invocation on redemptions (T1/T2)
    alt redemption already terminal (T16 / terminal)
      R-->>C: terminal outcome
      C->>DB: mirror onto operation_items (only while summary_state='none', else operation_late_results)
    else invocation acquired: current_attempt_id=aid AND current_invocation_token=itok (T1/T2)
      C->>P: redeem(PlayerRef{playerId,state}, code, idempotencyKey)
      P-->>C: success | already_redeemed | retryable | permanent
      C->>DB: guarded write WHERE current_invocation_token=itok — T4 success / T5 code+op / T6 state matches / T7 state differs -> pending / T8 cap -> state_reevaluation_limit; mirror
      Note over C,Q: retryable => T9 (clear invocation, set retry_due_at) THEN message.retry; redelivery resumes as T2
    else live invocation / not due / different attempt / terminal (T3)
      C->>Q: ack (no provider call, no message.retry, no writes)
      Note over R: sweeper (T12) re-drives with a fresh attempt_id
    end
  end
  C->>DB: finalisable? freeze + seal summary_item_snapshot (none->sealing->building), then paged layout + render
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
   - claims the `operation_items` lease (coarse dedupe)
     ([§15.1](#151-operation-item-lease-queue-dedup--accounting));
   - **acquires a per-invocation claim** on the global `redemptions` record
     ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority), **T1/T2**);
     if the row is already terminal it reuses that outcome; if a **live invocation** already
     holds it, the `retry_wait` is not yet due, or a different `attempt_id` owns it (**T3**),
     it `ack`s and stops — the sweeper (**T12**) re-drives with a fresh `attempt_id`;
   - once it holds `current_invocation_token`, calls
     `WhiteoutProvider.redeem({ playerId, state }, code, idempotencyKey)`, honouring
     `PROVIDER_RATE_LIMIT_PER_SECOND`; a `retryable` outcome ⇒ **T9** (atomically →
     `retry_wait`, clear the invocation, record `retry_due_at`) **then** `message.retry`
     ([§17](#17-retry-and-permanent-failure-classification));
   - writes the outcome **guarded on `current_invocation_token = :itok AND status =
     'in_progress'`** — **T4** success, **T5** code/operational, **T6** `player_ineligible`
     with `attempt_state = players.state`, **T7** state differs & under cap (→ `pending`),
     **T8** state differs & cap reached (→ `state_reevaluation_limit`) — then mirrors onto
     `operation_items` (only while `summary_state = 'none'`).
4. **Aggregate & summarize:** when every item is terminal
   ([§15.3](#153-completion-accounting-and-the-source-freeze)), the operation freezes its
   `operation_items` and seals an immutable `summary_item_snapshot`, then builds the summary
   by the **paged, cursor-driven, idempotent** process
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
5. **Consume** (`code-fanout-jobs`): the item lease + the per-invocation `redemptions` claim
   exactly as in [§6](#6-existing-code-processing-after-registration) — reuse a terminal
   outcome; on **T3** (live invocation / not due / different attempt) `ack` (sweeper T12
   re-drives with a fresh `attempt_id`); or call the provider under
   `current_invocation_token`, with invocation-guarded writes (**T4–T9**).
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
| Ingestion Worker (`/ingest`) | Authenticate the source; re-apply the author filter (authoritative staging gate, asserts non-production); parse; **atomically** persist `processed_events` + (validation-reply delivery row **or** registration work + outbox rows) + the guarded **T13** reopen of state-dependent `redemptions` failures on a `state` change, or the resumable state-machine shell | Stateless Worker; PK conflict ⇒ duplicate no-op |
| Fan-out expansion worker | Paginate the player snapshot into `operation_items` (with `display_label`) + outbox rows | Cursor-driven, bounded, restartable |
| Outbox dispatcher | Enqueue `pending` outbox rows; back off; mark `dead`; **atomic-reopen** (fresh `attempt_id`) while `summary_state='none'`, else flag a `repair_run` ([§14](#14-transactional-outbox)) | Cron (every minute, [fact:C4]) + inline best-effort |
| Registration consumer | Claim the coarse item lease; **acquire the per-invocation `redemptions` claim** (T1/T2); reuse a terminal outcome; **`ack`** on T3 (live invocation / not due / different attempt); redeem under `current_invocation_token`; invocation-guarded writes (T4–T9, incl. `attempt_state` vs `players.state` and the T8 cap); mirror while `summary_state='none'`; trigger the freeze + seal + build | Queue consumer; T3 never uses `message.retry`; `retryable` ⇒ T9 then `message.retry` |
| Fan-out consumer | Same as the registration consumer, for one `(player_id, code)` per job; triggers the freeze + seal + build when expansion done | Queue consumer |
| DLQ inspection consumer | Set the global row `retry_exhausted` on an exact `current_attempt_id = message.attempt_id` match when **no invocation is active**: a `retry_wait` row always qualifies (`current_invocation_token IS NULL`; the future `retry_due_at` / pickup-grace `invocation_expires_at` are not consulted), an `in_progress` row only if its `current_invocation_token` is null or `invocation_expires_at` has passed (T10); a different `attempt_id` ⇒ `dlq_stale_attempt`, a still-live invocation ⇒ `dlq_invocation_active`, both audit-only and change nothing (T11); mirror to non-terminal `operation_items` (subject to the §15.3 freeze) | Consumer of `redemption-dlq`; each DLQ message is one specific `attempt_id` |
| Operation sweeper | Force-close operations past `OPERATION_DEADLINE_SECONDS` (then **freeze + seal**); **T12** reset `redemptions` rows with an expired invocation (`in_progress`/`retry_wait` → `pending`); mirror terminal redemptions onto waiting items (freeze-guarded); **re-drive** up to `SWEEPER_REDRIVE_BATCH` stuck non-terminal, unclaimed pairs with a **fresh `attempt_id`**; **T15** guarded `state`-mismatch reopen of already-terminal `player_ineligible` rows; atomic-reopen outbox-dead items pre-seal; optional bounded `retry_exhausted` reopen | Cron |
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
| Operation sweeper | every minute | force-close operations past `deadline_at` (freeze + seal then); **T12** reset `redemptions` rows with an expired invocation (`in_progress`/`retry_wait` → `pending`); mirror terminal `redemptions` onto waiting `operation_items` (freeze-guarded); re-drive up to `SWEEPER_REDRIVE_BATCH` stuck non-terminal, unclaimed pairs with a fresh `attempt_id`; **T15** `state`-mismatch reopen; optional bounded `retry_exhausted` reopen |
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
  | { outcome: 'permanent'; reasonCode: string };             // reasonCode classifies terminality/reopen (§15.2):
                                                             //   code-dependent  : code_invalid | code_expired            (repair_run only)
                                                             //   state-dependent : player_ineligible -> T7 re-drive under cap;
                                                             //                     T8 -> reason_code 'state_reevaluation_limit' at the cap (repair_run only)
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
  ([§15.3](#153-completion-accounting-and-the-source-freeze), [§17](#17-retry-and-permanent-failure-classification)).
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
| `status` | TEXT | `pending` / `in_progress` / `retry_wait` / `success` / `already_redeemed` / `permanent_failure` / `retry_exhausted`; transitions only via the state-transition table in [§15.2](#152-global-redemption-record--the-sole-provider-call-authority); **`success` / `already_redeemed` never transition** |
| `current_attempt_id` | TEXT NULL | the durable **retry-budget identity** from the queue message body (preserved across `message.retry`); one `attempt_id` may run many sequential invocations |
| `current_invocation_token` | TEXT NULL | the **per-invocation execution claim** minted by the consumer for one delivery; set while an invocation is active, cleared before `message.retry` (T9) and on any terminal; every terminal / `retry_wait` write is guarded on `current_invocation_token = :itok` |
| `invocation_expires_at` | TEXT NULL | lease deadline for the live invocation (`REDEMPTION_CLAIM_LEASE_SECONDS`); in `retry_wait` there is **no** live invocation (`current_invocation_token IS NULL`) and this holds `retry_due_at + REDEMPTION_CLAIM_LEASE_SECONDS` purely as the sweeper's "must be re-picked-up by" hint — the DLQ path (**T10**) does **not** consult it for a `retry_wait` row |
| `retry_due_at` | TEXT NULL | set atomically with `status='retry_wait'` before `message.retry`; a redelivery may acquire a new invocation (T2) only when `now ≥ retry_due_at` |
| `attempt_state` | TEXT NULL | the `PlayerRef.state` the `current_attempt_id` is using; compared against the current `players.state` before a state-dependent terminal (T6/T7/T8) and on reopen |
| `attempt_generation` | INTEGER | audit counter, `+1` only when a **new** `attempt_id` becomes `current_attempt_id`; not a guard |
| `attempts` | INTEGER | provider-call invocations under `current_attempt_id` (`+1` per invocation granted; reset when a new `attempt_id` is granted or on reopen) |
| `reeval_count` | INTEGER | number of guarded state re-evaluations; capped by `REDEMPTION_MAX_REEVAL` |
| `provider_receipt` | TEXT NULL | optional reconciliation reference from a real provider |
| `reason_code` | TEXT NULL | for `permanent_failure` / `retry_exhausted` — incl. `state_reevaluation_limit` (T8); classifies reopen eligibility ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)) |
| `first_claimed_at`, `terminal_at`, `updated_at` | TEXT NULL | |

PK `(player_id, code)`. This row — **not** `operation_items` — is the sole authority for
whether `WhiteoutProvider.redeem` may be called for the pair. The `attempt_id` is the retry
budget; the `current_invocation_token` serializes provider calls so **two overlapping
deliveries of the same `attempt_id` cannot both call the provider** during normal lease
operation ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)).

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
| `success_count` / `already_redeemed_count` / `permanent_failure_count` / `retry_exhausted_count` / `completed_count` | INTEGER NULL | **cache only**; recomputed from **`summary_item_snapshot`** once `summary_state ≠ 'none'` (from live `operation_items` only while deciding to seal) |
| `created_at`, `updated_at` | TEXT | |

### `operation_items`

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `item_key` | TEXT | PK part — `code` (registration) or `player_id` (distribution) |
| `player_id` | TEXT | resolved pair member |
| `code` | TEXT | resolved pair member |
| `job_id` | TEXT | `registration:<operation_id>:<code>` / `distribution:<operation_id>:<player_id>` |
| `status` | TEXT | `pending` / `in_progress` / `success` / `already_redeemed` / `permanent_failure` / `retry_exhausted` (mirrors the global `redemptions` outcome) — **frozen once `operations.summary_state ≠ 'none'`** (later outcomes go to `operation_late_results`) |
| `display_label` | TEXT | the **sanitised** rendered label, captured when this row is created (`players.display_name` sanitised then, or `ID <player_id>`); **immutable** — a later `players.display_name` edit never changes it |
| `claim_token` | TEXT NULL | coarse dedupe: holds the owning `attempt_id`; a redelivered owner message resumes the lease via `claim_token = :attempt_id` |
| `claim_expires_at` | TEXT NULL | lease expiry (`ITEM_CLAIM_LEASE_SECONDS`) |
| `reason_code` | TEXT NULL | |
| `attempts` | INTEGER | |
| `updated_at` | TEXT | |

PK `(operation_id, item_key)`. The item lease is a **coarse** redelivery filter; the global
`redemptions.current_invocation_token` is the authoritative serializer for provider calls
([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)). It does **not**
authorize a provider call.

### `operation_players_snapshot` (distribution runs only; optional)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `player_id` | TEXT | PK part |

Point-in-time player boundary when a monotonic cursor filter is not used.

### `operation_late_results` (audit / history — outcomes observed after freeze)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `player_id`, `code` | TEXT | PK parts |
| `observed_at` | TEXT | PK part |
| `status` | TEXT | the terminal `redemptions` outcome that landed **after** `operations.summary_state` left `none` |
| `reason_code` | TEXT NULL | |

PK `(operation_id, player_id, code, observed_at)`. Once an operation's `summary_state ≠
'none'`, the mirror write ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority))
appends here **instead of** mutating the now-frozen `operation_items` row, so the summary
source cannot change under a paged seal. Not read by the summary build; available to
operators and a `repair_run`.

### `summary_item_snapshot` (immutable rendered inputs, sealed once)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `player_id`, `code` | TEXT | PK parts — the **stable keyset** (never reordered by status changes) |
| `status` | TEXT | the **frozen** `operation_items.status` (`still_pending` for a partial/`stale_closed` summary) |
| `reason_code` | TEXT NULL | frozen `operation_items.reason_code` |
| `display_label` | TEXT | copied verbatim from the **immutable** `operation_items.display_label` (captured at item creation) — the seal never reads `players` |
| `sort_key` | TEXT | sortable rendering order, `printf('%d\|%s\|%s', status_rank(status), player_id, code)` (`status_rank`: `success`,`already_redeemed`,`permanent_failure`,`retry_exhausted`,`still_pending`); fixed at seal time |
| `created_at` | TEXT | |

PK `(operation_id, player_id, code)`. Written by the paged **seal** pass
([§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery))
from **already-frozen** `operation_items` rows (frozen the instant `summary_state` left
`none`), in `(player_id, code)` order, `ON CONFLICT DO NOTHING`. **Immutable after seal.**
Both the layout and render passes — **and the summary counters** — read **only** this table,
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
  ≤ 128 KB, `delaySeconds` ≤ 24 h, `max_retries` up to 100 **[fact:C8]**. On a provider
  `retryable` result the consumer executes **T9** — atomically move the global row to
  `retry_wait`, clear `current_invocation_token`, record `retry_due_at`, **then**
  `message.retry({ delaySeconds })`. The redelivered body (same `attempt_id`) re-acquires an
  **invocation** via T2, so the retry budget and eventual DLQ ownership stay attached to
  that one durable `attempt_id`.
- **Contention is never a retry.** A delivery that finds a **live invocation** (any
  `attempt_id`), a `retry_wait` not yet due, a different `attempt_id`, or a terminal row is
  **T3**: it makes no provider call, `ack`s, and writes nothing. The pair is re-driven by
  the Operation sweeper (**T12**) with a **fresh `attempt_id`**. A **T3** message can never
  reach the DLQ.
- **DLQ:** `redemption-dlq` receives a message only after that `attempt_id`'s deliveries
  exhaust `max_retries` **[fact:C6]**. The inspection consumer terminalizes on an **exact
  `attempt_id` match with no invocation active** (**T10**). A `retry_wait` row always
  qualifies: **T9** already cleared `current_invocation_token`, so the retry budget is
  genuinely spent and the future `retry_due_at` / pickup-grace `invocation_expires_at` are
  irrelevant once the DLQ message itself has arrived. The lease-expiry comparison applies
  only to an `in_progress` row that still carries a `current_invocation_token`:
  ```sql
  UPDATE redemptions
     SET status = 'retry_exhausted', reason_code = 'provider_retry_exhausted',
         current_attempt_id = NULL, current_invocation_token = NULL,
         invocation_expires_at = NULL, retry_due_at = NULL,
         terminal_at = :now, updated_at = :now
   WHERE (player_id, code) = (:pid, :code)
     AND current_attempt_id = :msg_attempt_id
     AND (
           (status = 'retry_wait'  AND current_invocation_token IS NULL)
        OR (status = 'in_progress' AND (current_invocation_token IS NULL
                                        OR invocation_expires_at < :now))
         );
  ```
  If a newer attempt has taken over (`current_attempt_id <> :msg_attempt_id` — **even if
  that newer lease has since expired**) the write matches nothing and the DLQ message is
  **audit-only** `dlq_stale_attempt` (**T11**). If this exact attempt still has a **live
  invocation** (`in_progress`, `current_invocation_token IS NOT NULL`,
  `invocation_expires_at >= :now`) it is **audit-only** `dlq_invocation_active` (**T11**) —
  that invocation drives the outcome, and if it later exhausts, *its* DLQ message reaches
  **T10** with no live invocation. Both audit-only cases change nothing and `ack`. When
  **T10** does terminalize it mirrors `retry_exhausted` onto every non-terminal
  `operation_items` row (subject to the §15.3 freeze guard); the now-terminal `redemptions`
  row is skipped by the sweeper's **T12** guard, so no fresh `attempt_id` or retry budget is
  ever minted for it — reopen is `repair_run` (**T14**) only. **Business-rule (`permanent`)
  failures never enter the DLQ.**
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
    ('summarized','stale_closed')`, the `operation_items` row is already frozen
    ([§15.3](#153-completion-accounting-and-the-source-freeze)): the dispatcher records the
    outcome in `operation_late_results` (reason `outbox_dead`), raises an alert, and creates
    a `repair_run` operation stub (`type = 'repair_run'`, `trigger_ref` = origin
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

The `operation_items` lease is a **coarse** first filter for redelivered/duplicated queue
messages and the driver of completion accounting. It does **not** serialize provider calls —
that is the global `current_invocation_token` (§15.2).

- **States:** `pending` → `in_progress` (`claim_token = attempt_id`, `claim_expires_at`) →
  `success` | `already_redeemed` | `permanent_failure` | `retry_exhausted`; **`status`
  frozen once `operations.summary_state ≠ 'none'`** (later outcomes → `operation_late_results`).
- **Atomic claim-or-resume** (the message body's `attempt_id` is `:aid`):
  ```sql
  UPDATE operation_items
     SET status = 'in_progress', claim_token = :aid, claim_expires_at = :exp, updated_at = :now
   WHERE operation_id = :op AND item_key = :key
     AND (status = 'pending'
          OR (status = 'in_progress' AND claim_token = :aid)          -- my own attempt resuming
          OR (status = 'in_progress' AND claim_expires_at < :now));   -- an expired lease, steal
  ```
  Proceed only if one row changed, then go to §15.2 for the **authoritative** invocation
  claim. Two deliveries of the same `attempt_id` may both pass this coarse gate; §15.2's
  `current_invocation_token` (T3) then ensures only one calls the provider.

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
- **Two identities:**
  - **`attempt_id`** — the durable **retry-budget** identity, minted by the outbox layer,
    carried in the queue body, **unchanged by `message.retry`**
    ([§13](#13-cloudflare-queue-and-dead-letter-queue-boundaries)). One `attempt_id` runs
    one or more sequential **invocations**.
  - **`current_invocation_token`** — a **per-invocation execution claim** (`:itok`) the
    consumer mints for one delivery and holds while it calls the provider. It, plus
    `invocation_expires_at`, is what stops two overlapping deliveries of the same
    `attempt_id` from both calling the provider. `attempt_generation` is an audit counter
    only.
- **Acquire-invocation** (one upsert; grants the first invocation of a new `attempt_id`, or
  the next invocation of a due `retry_wait`, or steals a crashed invocation of the same
  `attempt_id`):
  ```sql
  INSERT INTO redemptions (player_id, code, idempotency_key, status,
                           current_attempt_id, current_invocation_token, invocation_expires_at,
                           attempt_state, attempt_generation, attempts, first_claimed_at, updated_at)
       VALUES (:pid, :code, :idk, 'in_progress', :aid, :itok, :exp, :state, 1, 1, :now, :now)
  ON CONFLICT (player_id, code) DO UPDATE SET
       status = 'in_progress',
       current_attempt_id = :aid,
       current_invocation_token = :itok,
       invocation_expires_at = :exp,
       retry_due_at = NULL,
       attempt_state = :state,
       attempt_generation = redemptions.attempt_generation
                            + (CASE WHEN redemptions.current_attempt_id = :aid THEN 0 ELSE 1 END),
       attempts = (CASE WHEN redemptions.current_attempt_id = :aid
                        THEN redemptions.attempts + 1 ELSE 1 END),  -- +1 on same-attempt resume; reset for a fresh attempt after a reopen
       updated_at = :now
     WHERE redemptions.status = 'pending'                                                     -- T1
        OR (redemptions.status = 'retry_wait'  AND redemptions.current_attempt_id = :aid
            AND redemptions.retry_due_at <= :now AND redemptions.current_invocation_token IS NULL)  -- T2: next invocation, retry due
        OR (redemptions.status = 'in_progress' AND redemptions.current_attempt_id = :aid
            AND redemptions.invocation_expires_at < :now);                                     -- T2: previous invocation crashed
  ```
  If **no** row changes, the delivery is **T3** (a live invocation holds it, or a
  `retry_wait` is not yet due, or a different `attempt_id` owns it, or the row is terminal):
  the consumer **does not call the provider**, writes nothing, and `message.ack()`s.

#### State-transition table (the single source of truth)

Every SQL guard, Queue-message field, DLQ rule, sweeper rule, scenario, and test below
conforms to this table. `A` = the caller's `attempt_id`; `X` = its fresh
`current_invocation_token`; all rows require `PK = (:pid, :code)`.

| # | From (`status`, invocation) | Trigger | Guard | To | Effect |
|---|---|---|---|---|---|
| T1 | `pending` | delivery for `A` | `status='pending'` | `in_progress` | `current_attempt_id=A` (`attempt_generation+=1` if `A` is new), `current_invocation_token=X`, `invocation_expires_at`, `attempt_state`, `attempts=1`, `retry_due_at=NULL` |
| T2 | `retry_wait` (`A`, due, no live invocation) **or** `in_progress` (`A`, invocation crashed) | redelivery of `A`'s body | `(status='retry_wait' AND current_attempt_id=A AND retry_due_at<=:now AND current_invocation_token IS NULL)` **or** `(status='in_progress' AND current_attempt_id=A AND invocation_expires_at<:now)` | `in_progress` | new `current_invocation_token=X`, `invocation_expires_at`, `attempts+=1` |
| T3 | any: **live invocation present** (any `attempt_id`), **or** `retry_wait` not yet due, **or** different `attempt_id`, **or** terminal | any delivery | none of T1/T2 match | *(unchanged)* | delivery makes **no provider call**, no writes, `message.ack()`s — **contention / duplicate suppression** |
| T4 | `in_progress` (`A`, `X`) | provider `success` / `already_redeemed` | `status='in_progress' AND current_attempt_id=A AND current_invocation_token=X` | `success` / `already_redeemed` | clear `current_attempt_id`, `current_invocation_token`, `invocation_expires_at`; `terminal_at` |
| T5 | `in_progress` (`A`, `X`) | provider `permanent`, reason ∈ {`code_invalid`,`code_expired`,`provider_bad_request`,`provider_auth_failed`} | `… AND current_invocation_token=X` | `permanent_failure` | clear attempt + invocation; `reason_code`; `terminal_at` |
| T6 | `in_progress` (`A`, `X`) | provider `permanent` = `player_ineligible`, **`attempt_state = players.state`** | `… AND current_invocation_token=X AND attempt_state=(SELECT state FROM players WHERE player_id=:pid)` | `permanent_failure` (`player_ineligible`) | clear attempt + invocation; `terminal_at` |
| T7 | `in_progress` (`A`, `X`) | provider `permanent` = `player_ineligible`, **`attempt_state ≠ players.state`**, **`reeval_count < REDEMPTION_MAX_REEVAL`** | `… AND current_invocation_token=X AND attempt_state<>(…) AND reeval_count<:max` | `pending` | clear attempt + invocation; `attempt_generation+=1`; `reeval_count+=1`; `reason_code=NULL`; `attempts=0` |
| T8 | `in_progress` (`A`, `X`) | provider `permanent` = `player_ineligible`, **`attempt_state ≠ players.state`**, **`reeval_count ≥ REDEMPTION_MAX_REEVAL`** | `… AND current_invocation_token=X AND attempt_state<>(…) AND reeval_count>=:max` | **`permanent_failure`** | clear attempt + invocation; **`reason_code='state_reevaluation_limit'`**; `terminal_at`; **operator alert**; counts as a **terminal failure**; reopen **only** via `repair_run` (T14); the obsolete `player_ineligible` result is **never** reported as applying to the current `state` |
| T9 | `in_progress` (`A`, `X`) | provider `retryable` | `… AND current_invocation_token=X` | **`retry_wait`** | **atomically** `current_invocation_token=NULL`, `retry_due_at=:now+backoff`, `invocation_expires_at=:retry_due_at + REDEMPTION_CLAIM_LEASE_SECONDS`; `attempts` unchanged. **Then** `message.retry({ delaySeconds = backoff })` |
| T10 | `retry_wait` (`A`) — always; **or** `in_progress` (`A`) with no live invocation | **DLQ message whose `attempt_id` = `A`** | `current_attempt_id=A AND ((status='retry_wait' AND current_invocation_token IS NULL) OR (status='in_progress' AND (current_invocation_token IS NULL OR invocation_expires_at<:now)))` | `retry_exhausted` | clear attempt + invocation; `reason_code='provider_retry_exhausted'`; `terminal_at`. `retry_wait` qualifies **regardless of `retry_due_at` / pickup-grace `invocation_expires_at`** (T9 already released the invocation) |
| T11 | different attempt, **or** exact `A` with a live invocation | **DLQ message whose `attempt_id` = `A`** | `current_attempt_id IS NULL OR current_attempt_id<>A` (⇒ `dlq_stale_attempt`, **even if that newer lease has since expired**) — **or** — `current_attempt_id=A AND status='in_progress' AND current_invocation_token IS NOT NULL AND invocation_expires_at>=:now` (⇒ `dlq_invocation_active`) | *(unchanged)* | audit-only; **never terminalizes**; `message.ack()`s. A live invocation drives the outcome; when it later exhausts, *its* DLQ message hits **T10** |
| T12 | `in_progress` / `retry_wait` (`A`), no live invocation, stuck | Operation sweeper | `status IN ('in_progress','retry_wait') AND (invocation_expires_at IS NULL OR invocation_expires_at<:now)` | `pending` | clear attempt + invocation; sweeper re-enqueues a **fresh `attempt_id`**. The `status IN ('in_progress','retry_wait')` guard **excludes every terminal status**, so once **T10** has set `retry_exhausted` the sweeper never re-drives the row or mints a new retry budget — reopen is `repair_run` (T14) only |
| T13 | `permanent_failure`/`player_ineligible` | valid re-registration changes `players.state` | atomic acceptance batch, `attempt_state<>:new_state AND reeval_count<:max` | `pending` | `attempt_generation+=1`; `reeval_count+=1`; `reason_code=NULL`; `terminal_at=NULL`; `attempts=0` |
| T14 | `permanent_failure` (**any** reason, incl. `state_reevaluation_limit`) / `retry_exhausted` | operator `repair_run` | — | `pending` | `attempt_generation+=1`; operator may reset `reeval_count` |
| T15 | `permanent_failure`/`player_ineligible` (already terminal, predates T7) | Operation sweeper, `attempt_state<>players.state AND reeval_count<:max AND` a non-terminal `operation_items` waits | sweeper | `pending` | as T13 |
| T16 | `success` / `already_redeemed` | anything | — | *(immutable)* | — |

#### The six required behaviours

| Situation | Path | Result |
|---|---|---|
| **Two concurrent deliveries, same `attempt_id`** | D1 wins T1/T2 (token `X`, `in_progress`). D2 finds a live invocation → **T3**: no provider call, `ack`. | Exactly one provider call. |
| **Legitimate sequential owner retry** | Provider `retryable` → **T9**: release invocation + record `retry_due_at`, *then* `message.retry`. The redelivered body (same `attempt_id`) arrives ≥ `retry_due_at` → **T2** (`attempts+=1`) → calls the provider. | Retry budget stays on `attempt_id`; no premature retry (T3 blocks any early duplicate until `retry_due_at`). |
| **Invocation crash** | `invocation_expires_at` passes with token still set. Next redelivery → **T2** (`in_progress AND invocation_expires_at<:now`). If none arrives, **T12** → `pending` + fresh `attempt_id`. | Re-driven exactly once. |
| **Execution lease expires during a provider call** | D2 steals via **T2** (token `Y`). D1's `redeem` returns; its terminal write is guarded `current_invocation_token=X` → matches nothing → **discarded**; D2's result wins. | During *normal* (non-expired) lease operation T3 prevents any second call. On the abnormal expiry case the production-provider **idempotency key** prevents double-apply; tune `REDEMPTION_CLAIM_LEASE_SECONDS` above the provider timeout. |
| **DLQ message arrives while an invocation is active** | Exact `attempt_id`, `in_progress`, live lease → **T11** `dlq_invocation_active`, audit-only, `ack`; that invocation drives `success` / `permanent` / `retry_wait`, and *its* later DLQ message hits **T10**. If instead the row is `retry_wait` (invocation already released by **T9**), the DLQ message is **T10** `retry_exhausted` immediately — a future `retry_due_at` / pickup-grace does **not** defer it, and **T12** cannot then mint a fresh `attempt_id`. | Terminalizes iff no invocation is active. |
| **Stale attempt after a newer attempt took ownership** | `current_attempt_id = B ≠ A`. A's DLQ message → **T11** `dlq_stale_attempt`. A's late provider result → terminal write guarded `current_attempt_id = A` → discarded. | The newer attempt `B` owns the outcome. |

#### Terminal-write guards

Every terminal (or `retry_wait`) write from a **consumer** (T4–T9) carries
`WHERE status = 'in_progress' AND current_attempt_id = :aid AND current_invocation_token =
:itok` (T6/T7/T8 add the `attempt_state` vs `players.state` comparison). The **DLQ**
terminal write (T10) carries `WHERE current_attempt_id = :msg_attempt_id AND ((status =
'retry_wait' AND current_invocation_token IS NULL) OR (status = 'in_progress' AND
(current_invocation_token IS NULL OR invocation_expires_at < :now)))` — an exact
`attempt_id` match **and** no invocation active. A `retry_wait` row always satisfies this
(its invocation was released by T9, so the pickup-grace `invocation_expires_at` is not
consulted); the lease-expiry comparison applies only to an `in_progress` row still holding a
`current_invocation_token`. The sweeper (T12) moves the row **only → `pending`**, never
writes a terminal status, and its `status IN ('in_progress','retry_wait')` guard skips the
`retry_exhausted` row T10 produced.

#### Crash-safe re-drive (Operation sweeper)

Every minute, bounded by `SWEEPER_REDRIVE_BATCH`, the sweeper:

- **T12:** resets `redemptions` rows in `in_progress` / `retry_wait` whose
  `invocation_expires_at` has passed (crashed invocation, or a `retry_wait` whose retried
  message never arrived **and produced no DLQ message** — a DLQ message would have hit
  **T10** first and moved the row to the terminal `retry_exhausted`, which this guard's
  `status IN ('in_progress','retry_wait')` filter skips) to `pending`
  (`current_attempt_id = NULL`, `current_invocation_token = NULL`);
- re-enqueues **one fresh job per pair** — **fresh `attempt_id`**, fresh `max_retries` — for
  every pair with a non-terminal `operation_items` row and a non-terminal `redemptions` row
  that now has `current_attempt_id IS NULL`;
- **T15:** reopens an already-terminal `permanent_failure`/`player_ineligible` row whose
  `attempt_state <> players.state` and `reeval_count < REDEMPTION_MAX_REEVAL` while a
  non-terminal `operation_items` waits (catch-up for rows that turned terminal before T7);
- mirrors any now-terminal `redemptions` outcome onto every non-terminal `operation_items`
  row for the pair (see [§15.3](#153-completion-accounting-and-the-source-freeze) for the freeze guard):
  ```sql
  UPDATE operation_items
     SET status = :mirror, reason_code = :rc, updated_at = :now
   WHERE (player_id, code) = (:pid, :code)
     AND status IN ('pending', 'in_progress')
     AND (SELECT summary_state FROM operations o WHERE o.operation_id = operation_items.operation_id) = 'none';
  -- operations whose summary_state <> 'none': append to operation_late_results instead
  ```

This single mechanism covers T3 `ack`s, invocation crashes, obsolete-state terminals, and
lost queue messages. While any `operation_items` for a pair is non-terminal and the
operation is within its deadline, the pair keeps being re-driven.

#### Terminality is per `reason_code`

| Outcome / `reason_code` | Terminality | Reopen path |
|---|---|---|
| `success`, `already_redeemed` | **immutable** (T16) | never |
| `permanent_failure` / `player_ineligible` (**state-dependent, under cap**) | terminal until the player's `state` changes | **T7** (before an obsolete-state attempt terminalizes), **T13** (atomic acceptance batch of a re-registration that changes `players.state`), or **T15** (sweeper catch-up); each guarded, `reeval_count += 1`, capped by `REDEMPTION_MAX_REEVAL` |
| `permanent_failure` / **`state_reevaluation_limit`** (state re-evaluation cap reached — **T8**) | **terminal failure** | **`repair_run` only (T14)** — never auto-reopened, never reported as the obsolete `player_ineligible` applying to the current `state`; raises an operator alert |
| `permanent_failure` / `code_invalid`, `code_expired` (**code-dependent**) | terminal | operator `repair_run` only (T14; e.g. after correcting `gift_codes.status`) |
| `permanent_failure` / `provider_bad_request`, `provider_auth_failed` (**operational**) | terminal | operator `repair_run` only (T14), after the operational cause is fixed |
| `retry_exhausted` (**operational**) | terminal for accounting | operator `repair_run` (T14); **or** a bounded sweeper auto-reopen after a cooldown when `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED = true` (capped by `REDEMPTION_MAX_REEVAL`) |

**T13 — state-change reopen** (runs inside the same atomic acceptance `db.batch()` as the
re-registration, [§5](#atomic-acceptance)):

```sql
UPDATE redemptions
   SET status = 'pending', current_attempt_id = NULL, current_invocation_token = NULL,
       invocation_expires_at = NULL, retry_due_at = NULL,
       reason_code = NULL, terminal_at = NULL,
       attempts = 0, attempt_generation = attempt_generation + 1,
       reeval_count = reeval_count + 1, updated_at = :now
 WHERE player_id = :pid
   AND status = 'permanent_failure'
   AND reason_code = 'player_ineligible'               -- state-dependent, under cap only
   AND reeval_count < :max_reeval
   AND (attempt_state IS NULL OR attempt_state <> :new_state);
```

It never matches `success` / `already_redeemed` / `state_reevaluation_limit` /
code-dependent / operational rows. The new registration operation's own `operation_items`
for the pair then drive a fresh invocation (fresh `attempt_id`) with the new `state`.
Already-`summarized` operations and their sealed `summary_item_snapshot` are **not**
retroactively changed. `MockWhiteoutProvider` is idempotent by construction; a compliant
production provider is required to be, or acceptance fails
([whiteout-provider-decision.md §5](whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider)).

#### Crash ambiguity

If a real provider performs the redemption but the Worker crashes before the guarded
terminal write, the invocation lease expires and the redelivered message re-acquires an
invocation for the same `attempt_id` (**T2**), then calls the provider again. This is why a
production `WhiteoutProvider` **must** support a stable redemption idempotency key or an
authorized reconciliation lookup
([whiteout-provider-decision.md §5](whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider));
without one, production redemption stays blocked. During *normal* (non-expired) lease
operation, T3 guarantees no two invocations of the same `attempt_id` call the provider.

### 15.3 Completion accounting and the source freeze

**While deciding whether to seal:** an operation is finalisable when
`count(operation_items.status IN ('success','already_redeemed','permanent_failure','retry_exhausted')) >= expected_count`
(and, for distribution runs, `expansion_state = 'expanded'`). `permanent_failure` here
includes `reason_code = 'state_reevaluation_limit'` (T8) — a terminal failure that lets the
operation finish.

**Source freeze — the instant `summary_state` leaves `none`:** the mirror write from a
consumer or the sweeper is guarded so it mutates `operation_items` **only while
`operations.summary_state = 'none'`**; once it is `sealing`/`building`/… a later redemption
outcome is appended to **`operation_late_results`** instead
([§12](#operation_late_results-audit--history--outcomes-observed-after-freeze),
[§15.2](#crash-safe-re-drive-operation-sweeper)). `operation_items.display_label` is
immutable from creation. So every `operation_items` row that feeds the paged seal is frozen
at one logical transition — no page can combine a status or a label from a different moment.

**After sealing:** all summary-facing counts (`applied = success + already_redeemed`,
failure counts) are recomputed **from `summary_item_snapshot`**, the same immutable version
the rendered rows come from. `already_redeemed` counts toward `applied` and is never a
failure; a `state_reevaluation_limit` row is a failure line, rendered truthfully (e.g.
"state re-check limit — manual review"), never as "ineligible".

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
becomes finalisable ([§15.3](#153-completion-accounting-and-the-source-freeze)) **or** is
force-closed at `deadline_at`, a single guarded statement moves
`summary_state: 'none' → 'sealing'` (`WHERE summary_state = 'none'` — exactly one writer
wins). **That same transition freezes the source:** from this instant, mirror writes for
this operation go to `operation_late_results`, and `operation_items.display_label` was
already immutable, so every source row is fixed as of one logical moment. Then a **paged
seal pass** (page size `SUMMARY_BUILD_PAGE_SIZE`) reads those frozen `operation_items` rows
in **`(player_id, code)` order** and — in one **bounded** `db.batch()` per page —
`INSERT … INTO summary_item_snapshot` (frozen `status` / `reason_code`, `display_label`
copied verbatim from `operation_items`, `sort_key` from `status_rank(status)`) `ON CONFLICT
(operation_id, player_id, code) DO NOTHING`, advancing `operations.snapshot_cursor` (the last
`(player_id, code)` sealed). The seal **never reads `players`**. When the last row is copied,
`summary_state: 'sealing' → 'building'` and `snapshot_sealed_at = now`. A resumed crash
re-reads only rows after `snapshot_cursor`; all inputs are already frozen, so the result is
byte-identical.

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
| All items terminal | Seal `summary_item_snapshot` (freeze at `none → sealing`) → layout pass → render pass → dispatcher delivers chunks in order → `summary_state = 'delivered'` |
| **Two concurrent deliveries, same `attempt_id`** | D1 acquires the invocation (token `X`, **T1/T2**). D2 finds a live invocation → **T3**: no provider call, no writes, `ack`. Exactly one provider call. Covered by an explicit test ([§21](#21-testing-strategy)). |
| Legitimate sequential owner retry | Provider `retryable` → **T9**: atomically clear the invocation, set `retry_due_at`, **then** `message.retry`. The redelivered body (same `attempt_id`) arrives ≥ `retry_due_at` → **T2** (new invocation token, `attempts += 1`) → calls the provider. Budget stays on `attempt_id`; a premature duplicate before `retry_due_at` is **T3**. |
| Invocation crash | `invocation_expires_at` passes with the token still set → next redelivery **T2** (`in_progress AND invocation_expires_at<:now`); if none arrives, sweeper **T12** → `pending` + fresh `attempt_id`. |
| Execution lease expires during a provider call | A redelivery steals via **T2** (token `Y`). The first invocation's terminal write is guarded `current_invocation_token = X` → discarded; `Y`'s result wins. Normal (non-expired) lease operation: **T3** prevents any second call. Expired case: production-provider **idempotency key** prevents double-apply; set `REDEMPTION_CLAIM_LEASE_SECONDS` > provider timeout. |
| DLQ message for `attempt_id` A while an `in_progress` invocation is **still live** (exact A, `current_invocation_token IS NOT NULL`, `invocation_expires_at ≥ now`) | **T11** → `dlq_invocation_active`, audit-only, `ack`. The active invocation drives the outcome; if it later exhausts, *its* DLQ message hits **T10**. |
| DLQ message for `attempt_id` A in `retry_wait` (the retry hit `max_retries` **before** `retry_due_at` + grace) | **T10** → `retry_exhausted` immediately. `retry_wait` ⇒ `current_invocation_token IS NULL`, so the future pickup-grace `invocation_expires_at` is **not** consulted; the exhausted budget is honoured and **T12** cannot later mint a fresh `attempt_id` for the now-terminal row. Explicit test in [§21](#21-testing-strategy). |
| DLQ message for `attempt_id` A, `in_progress` with no live invocation (token cleared or lease expired) | **T10** if `current_attempt_id = A` → `retry_exhausted`. **T11** `dlq_stale_attempt` if `current_attempt_id ≠ A` (a newer attempt took over, **even if that newer lease has since expired**) → no write. |
| Player changes `state` while an old-state attempt is still `in_progress` | The old attempt's `player_ineligible` hits **T7** (`attempt_state ≠ players.state`, under cap) → row → `pending`; a fresh `attempt_id` re-drives with the current `state`. **T15** (sweeper) is the catch-up for rows that turned terminal before T7. |
| State re-evaluation cap reached (`reeval_count ≥ REDEMPTION_MAX_REEVAL`, `attempt_state ≠ players.state`) | **T8**: `permanent_failure` / `state_reevaluation_limit`, invocation cleared, **operator alert**, counts as a terminal failure so the operation finishes; the obsolete `player_ineligible` result is **not** reported as current; reopen only via `repair_run` (**T14**). |
| Player re-registers with a corrected `state` after a terminal `player_ineligible` | **T13** inside the atomic acceptance batch: `permanent_failure → pending`, guarded on `attempt_state ≠ new state`, `reeval_count += 1`, capped; the new operation re-drives a fresh attempt; `success` / `already_redeemed` never reopen (T16); `state_reevaluation_limit` needs `repair_run`. |
| An `outbox_jobs` row goes `dead` **before** the seal (`summary_state='none'`) | Dispatcher **atomic-reopens** the outbox row (fresh `attempt_id`) + item row |
| An `outbox_jobs` row goes `dead` after the seal / finalization | Item outcome recorded in `operation_late_results`; alert; `repair_run` stub; finalized operation and its snapshot not mutated |
| Operation misses `deadline_at` | Sweeper → `state = 'stale_closed'`, then **`summary_state: none → sealing`** — the freeze and seal capture non-terminal items as `still_pending`; a **partial** summary is built from that immutable snapshot; later terminalizations go to `operation_late_results` — no re-render, no second summary |
| Late redemption result **or** `players.display_name` change after `summary_state ≠ 'none'` | The redemption outcome is appended to **`operation_late_results`** (the `operation_items` row is frozen); a name change touches only `players`. Neither can alter the snapshot, the layout boundaries, or the counts. |
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
| **Redemption (global)** | `redemptions (player_id, code)` | acquire-invocation upsert (**T1/T2/T3**); the durable `attempt_id` is the retry budget, the per-invocation `current_invocation_token` serializes provider calls; **every consumer terminal / `retry_wait` write guarded on `current_attempt_id = :aid AND current_invocation_token = :itok AND status='in_progress'`**; the **DLQ** write (T10) guarded on exact `attempt_id` **AND no live invocation**; state-dependent terminal adds `attempt_state` vs `players.state`; `success` / `already_redeemed` immutable (T16); T3 (contention) writes nothing here; full transition table in [§15.2](#152-global-redemption-record--the-sole-provider-call-authority) |
| Operation item | `operation_items (operation_id, item_key)` | PK + coarse `attempt_id` lease (queue-dedup + accounting only — the real serializer is the global invocation token); `status` frozen once `summary_state ≠ 'none'` |
| Outbox → Queue | `outbox_jobs.job_id` + `attempt_id` in the message body | **consumer-side** dedup (no producer key, [fact:C7]); `attempt_id` re-minted only on a reset to `pending`, never on `message.retry` |
| Summary rendered inputs | `summary_item_snapshot (operation_id, player_id, code)` (ordered by `sort_key`) | sealed once from **frozen** `operation_items` (freeze at `summary_state: none → sealing`; later outcomes → `operation_late_results`), `ON CONFLICT DO NOTHING`; immutable after seal; both build passes **and the counters** read only this |
| Discord output (per chunk) | `discord_output_deliveries.delivery_id` + deterministic `nonce`; `summary_chunk_layout (operation_id, chunk_index)` | `delivery_id` / `nonce` / content are pure functions of `(operation_id, chunk_index)` + the immutable snapshot; seal / layout / render passes resume from `snapshot_cursor` / (`summary_layout_cursor` + `summary_layout_open`) / `summary_build_cursor` with `ON CONFLICT DO NOTHING`; `enforce_nonce` bounded suppression ([fact:D6]); delivery resumes at first unsent chunk |

Queues are at-least-once **[fact:C7][fact:C8]**; every consumer is written to be safely
re-runnable.

---

## 17. Retry and permanent-failure classification

| Provider / transport signal | Class (`reason_code`) | Action | Reopen |
|---|---|---|---|
| HTTP 429, `Retry-After` present | `retryable` | **T9**: atomically → `retry_wait` (clear invocation, set `retry_due_at` from `Retry-After` / backoff), **then** `message.retry` | — |
| HTTP 5xx, connection reset, timeout | `retryable` | **T9** with exponential backoff up to `PROVIDER_MAX_RETRIES` | — |
| Provider "rate limited" / "temporarily unavailable" | `retryable` | **T9** with backoff | — |
| Redemption succeeded now | `success` | **T4** terminal, guarded on `current_invocation_token`; record `provider_receipt` if returned | **never** (T16) |
| Redemption already applied for this pair | `already_redeemed` | **T4** **terminal, success-equivalent**; no retry; counts toward `applied`; never a failure | **never** (T16) |
| Invalid / expired / disabled code | `permanent` (`code_invalid` / `code_expired`) | **T5** terminal `permanent_failure`, no retry, **never DLQ** | operator `repair_run` (T14) only |
| Player ineligible / unknown to the game | `permanent` (`player_ineligible`) — **state-dependent** | **T6** if `attempt_state = players.state`; **T7** (row → `pending`) if `attempt_state ≠ players.state` and `reeval_count < REDEMPTION_MAX_REEVAL`; **T8** (`permanent_failure` / `state_reevaluation_limit`, alert) if the cap is reached — a stale in-flight attempt never terminalizes as `player_ineligible`-for-current-state | T7 / T13 / T15 while under cap; then **`repair_run` only (T14)** — incl. `state_reevaluation_limit` |
| Bad request / auth failure | `permanent` (`provider_bad_request` / `provider_auth_failed`) — operational | **T5** terminal `permanent_failure` | operator `repair_run` (T14) only, after the cause is fixed |
| Input validation failure (bad `PLAYER_ID`) | n/a | never reaches a queue; durable validation reply instead ([§5](#invalid-message-reply)) | — |
| Owner-path attempt exhausts retries | `retry_exhausted` | message → `redemption-dlq`; the DLQ consumer sets the global row `retry_exhausted` on an exact-`attempt_id` match when **no invocation is active** — a `retry_wait` row always qualifies (T9 released the invocation; the future `retry_due_at` / pickup-grace is not consulted), an `in_progress` row only with its token cleared or lease expired (**T10**); a stale `attempt_id` ⇒ `dlq_stale_attempt`, a live `in_progress` invocation ⇒ `dlq_invocation_active`, both audit-only (**T11**); mirrored items marked `retry_exhausted` | operator `repair_run` (T14); or bounded sweeper reopen when `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED` |
| State re-evaluation cap reached | `permanent` → **`state_reevaluation_limit`** | **T8** terminal `permanent_failure`; clear invocation; **operator alert**; counts as a terminal failure so the operation finishes; rendered truthfully, never as `player_ineligible`-for-current-state | **`repair_run` only (T14)** |

Backoff, `delaySeconds`, and `PROVIDER_MAX_RETRIES` stay within Queue limits **[fact:C8]**.
T3 (contention) never consumes the retry budget ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)).

---

## 18. Discord output safety

- **Sanitisation:** display names and any echoed user input are sanitized
  (strip/escape backticks, `@`, `#`, `:` role/emoji triggers, zero-width and control
  characters; cap length). The label is sanitised and stored in
  `operation_items.display_label` **when the item row is created** and is **immutable**
  thereafter; the seal copies it verbatim and the render pass never reads `players`, so a
  later `players.display_name` change cannot alter an in-progress or delivered summary.
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
  `already_redeemed` / `retryable` / `permanent` / `retry_exhausted` / `state_reevaluation_limit`);
  invocation transitions (T1 grant / T2 resume / T3 contention-ack / T9 → `retry_wait`);
  **sweeper re-drives (T12)** with a fresh `attempt_id`; **`dlq_stale_attempt`** (T11) and
  **`dlq_invocation_active`** (T11) counts; **redemption re-evaluations** by trigger
  (T7 in-flight / T13 re-registration / T15 sweeper / T14 `repair_run`);
  **`operation_late_results` inserts** (outcomes after freeze); operations by `state`;
  operations `stale_closed`; seal / layout / render cursor lag; **summaries capped at
  `SUMMARY_MAX_CHUNKS`**; `discord_output_deliveries` by `status`; unsent-chunk age; DLQ
  depth; queue backlog; outbox backlog and `dead` count; `repair_run` count; Gateway
  reconnect / RESUME / IDENTIFY counts (ingestion tier).
- **Alerts:** DLQ depth > 0, outbox `dead` count > 0, `dlq_stale_attempt` /
  `dlq_invocation_active` rate, **`state_reevaluation_limit` recorded**,
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
  - **concurrent same-`attempt_id` deliveries (T3):** two overlapping deliveries of the same
    queue body → **exactly one** provider call; the second finds a live
    `current_invocation_token` and `ack`s without calling the provider, `message.retry`, or
    writing to `redemptions`;
  - **owner-path retry resumes the same attempt (T9 → T2):** a `retryable` result
    atomically moves the row to `retry_wait` (clears the invocation, records `retry_due_at`)
    **before** `message.retry`; the redelivered body acquires a **new invocation** for the
    same `attempt_id`, `attempts += 1`, and calls the provider again — the retry is not
    swallowed; a premature duplicate before `retry_due_at` is T3;
  - **invocation crash / lease expiry during a call:** a redelivery acquires a new
    invocation via T2 (`invocation_expires_at < now`); the crashed invocation's later
    terminal write is discarded by the `current_invocation_token` guard; if no redelivery
    comes, sweeper T12 → `pending` + fresh `attempt_id`;
  - **DLQ vs live invocation (T10/T11):** a DLQ message terminalizes `retry_exhausted` on an
    exact `attempt_id` match when no invocation is active; only an `in_progress` row with a
    non-null `current_invocation_token` and an unexpired lease is `dlq_invocation_active`
    (audit-only); a newer `attempt_id` is `dlq_stale_attempt` (audit-only) **even if that
    newer lease has since expired**;
  - **DLQ for a `retry_wait` attempt before its retry is due (T10):** **T9** schedules a
    retry (`retry_due_at` in the future, `invocation_expires_at = retry_due_at + lease`,
    `current_invocation_token` cleared); that retry reaches `max_retries` and enters the DLQ
    **before `retry_due_at` + grace**; the DLQ consumer records `retry_exhausted` (**T10**)
    on the exact `attempt_id` because `current_invocation_token IS NULL` — the future
    `retry_due_at` / pickup-grace `invocation_expires_at` must **not** divert it to
    `dlq_invocation_active`; the sweeper (**T12**) must **not** afterwards reset the
    now-terminal row or mint a fresh `attempt_id`;
  - **state race (T7) and cap (T8):** a `player_ineligible` result whose `attempt_state ≠
    players.state` returns the row to `pending` (T7) while `reeval_count <
    REDEMPTION_MAX_REEVAL`; **at the cap it terminalizes as `permanent_failure` /
    `state_reevaluation_limit`** (T8) with an alert — it does **not** stay `in_progress` and
    is **not** re-driven by T12; a `state_reevaluation_limit` row reopens only via
    `repair_run` (T14); it is rendered truthfully, never as `player_ineligible`-for-current-state;
  - **`already_redeemed`** counts toward `applied` and never as a failure in totals and
    rendered summaries;
  - **immutable summary source:** the instant `summary_state` leaves `none`, a mirror write
    goes to `operation_late_results` instead of mutating the frozen `operation_items` row;
    `display_label` is immutable from item creation; the seal never reads `players`; both
    build passes **and the counters** read only `summary_item_snapshot`; a late redemption
    result or a `players.display_name` edit cannot change layout boundaries, rendered
    content, or counts;
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
| Two operations target the same `(player_id, code)` | Risk of double provider call | One invocation holds `current_invocation_token`; others reuse the terminal outcome or **`ack`** on T3; sweeper T12 re-drives with a fresh `attempt_id`; only the token holder terminalizes; outcome mirrored to all |
| **Two concurrent deliveries of the same `attempt_id`** | Both could call the provider (T2 previously ignored the lease) | Only the first acquires `current_invocation_token`; the second is **T3** (live invocation) → `ack`, no provider call, no writes. Explicit test in [§21](#21-testing-strategy). |
| Owner-path `retryable` result | Second provider attempt could be lost | **T9**: atomically → `retry_wait`, clear invocation, record `retry_due_at`, **then** `message.retry`. The redelivery acquires a new invocation for the same `attempt_id` (T2), `attempts += 1`, calls the provider again |
| Execution lease expires during a provider call | Two invocations could overlap | Only during the *abnormal* expiry case; the stale invocation's terminal write is discarded by the `current_invocation_token` guard, and the production-provider **idempotency key** prevents double-apply. Set `REDEMPTION_CLAIM_LEASE_SECONDS` > the call timeout so normal operation never expires; then T3 blocks any second call |
| Invocation crash | Global row stuck `in_progress` | `invocation_expires_at` passes → a redelivery re-acquires via **T2**, or sweeper **T12** → `pending` + fresh `attempt_id` |
| DLQ message while an `in_progress` invocation is still live | Wrong `retry_exhausted` while work is in flight | **T11** `dlq_invocation_active` (exact `attempt_id`, non-null `current_invocation_token`, `invocation_expires_at ≥ now`) — audit-only, `ack`; the active invocation drives the outcome; if it later exhausts, *its* DLQ message hits **T10** |
| DLQ message for a `retry_wait` attempt before `retry_due_at` + grace | Old `invocation_expires_at` gate wrongly diverts it to `dlq_invocation_active`, then **T12** mints a fresh `attempt_id` and bypasses the exhausted budget | **T10** terminalizes on the exact `attempt_id` because `current_invocation_token IS NULL`; the future `retry_due_at` / pickup-grace `invocation_expires_at` is **not** consulted for a `retry_wait` row; the now-terminal `retry_exhausted` row is outside **T12**'s `status IN ('in_progress','retry_wait')` guard. Explicit test in [§21](#21-testing-strategy) |
| Stale DLQ message vs a newer attempt | Wrong `retry_exhausted` on the shared row | DLQ write is guarded on exact `attempt_id` **and** no invocation active (T10); a newer `attempt_id` — **even after its lease expires** — is **T11** `dlq_stale_attempt`, no write |
| Player changes `state` while an old-state attempt is still `in_progress` | Stale `player_ineligible` becomes the new registration's terminal | Before terminalizing, **T7** compares `attempt_state` with `players.state`; mismatch & under cap ⇒ row → `pending`, fresh attempt with current state; **T15** sweeper catch-up for pre-T7 terminals |
| State re-evaluation cap reached | Row would loop `in_progress` ↔ `pending` forever (old T8 gap) | **T8**: `permanent_failure` / `state_reevaluation_limit`, invocation cleared, **operator alert**, counts as a terminal failure so the operation finishes; T12 does **not** re-drive it; reopen only via `repair_run` (T14); never rendered as `player_ineligible`-for-current-state |
| Player re-registers with corrected `state` after a terminal `player_ineligible` | Old failure would be reused forever | **T13** in the atomic acceptance batch reopens the guarded row (`permanent_failure → pending`, `reeval_count += 1`, capped); the new operation re-drives with the new `state`; `success` / `already_redeemed` / `state_reevaluation_limit` are not touched |
| Provider redeems then Worker crashes before recording | Ambiguous redemption | The invocation lease expires; a redelivery re-acquires via **T2** and calls again. Production requires a stable idempotency key or authorized reconciliation; until then production redemption is blocked. Mock is idempotent |
| Queue backlog | Delayed redemptions | Consumers scale (push concurrency up to 250, [fact:C8]); operations bounded by `deadline_at` |
| Provider outage / rate-limit storm | Many `retryable` failures | **T9** backoff + `PROVIDER_RATE_LIMIT_PER_SECOND`; an attempt's retries exhaust → DLQ → **T10** `retry_exhausted` + mirrored items; summary lists failures |
| DLQ growth | Redemptions stuck | Alert; DLQ consumer terminalises on an exact `attempt_id` match with **no invocation active** (`retry_wait` always qualifies; `in_progress` only with the token cleared / lease expired); operator triage / `repair_run` |
| Very large player list → summary | One unbounded seal/build batch could exceed D1 limits | Paged seal + paged layout + paged render, each bounded per invocation and per `db.batch()`, cursor-resumable, capped at `SUMMARY_MAX_CHUNKS` |
| Late redemption result or `players.display_name` change after `summary_state ≠ 'none'` | A later pass could compute a different boundary / render different text / different counts | The redemption outcome goes to **`operation_late_results`** (the `operation_items` row is frozen); `display_label` is immutable from creation; both build passes **and the counters** read only `summary_item_snapshot` |
| Crash mid seal / layout / render | Partial snapshot / layout / delivery rows | Resume from `snapshot_cursor` / (`summary_layout_cursor` + `summary_layout_open`) / `summary_build_cursor`; re-derived rows byte-identical (`ON CONFLICT DO NOTHING`) |
| Duplicate queue delivery | Repeated processing attempt | Coarse `operation_items` lease (by `attempt_id`) plus the authoritative per-invocation `current_invocation_token` (T3) — at most one provider call |
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
- **Retry-budget identity vs invocation claim:** the durable **`attempt_id`** (queue body,
  preserved across `message.retry`) is the retry budget; a distinct per-invocation
  **`current_invocation_token`** + `invocation_expires_at` serializes provider calls, so two
  overlapping deliveries of the same `attempt_id` cannot both call the provider (**T3**). A
  `retryable` result executes **T9** — atomically release the invocation and record
  `retry_due_at` — *before* `message.retry`; a redelivery acquires a **new invocation** for
  the same `attempt_id` only when no invocation is live and the retry is due (**T2**).
  Consumer terminal writes are guarded on `current_invocation_token`; the DLQ write on an
  exact `attempt_id` match with **no invocation active** — a `retry_wait` row always
  qualifies (T9 released the invocation; the pickup-grace `invocation_expires_at` is not
  consulted), an `in_progress` row only with its token cleared or lease expired.
  `attempt_generation` is an audit counter. The single state-transition table **T1–T16** in
  §15.2 is the source of truth for all guards, the queue-message field, the DLQ rules, the
  sweeper rules, the scenario matrix, and the tests.
- **DLQ while an `in_progress` invocation is live:** **T11** `dlq_invocation_active`
  (audit-only) — the live invocation drives the outcome; when it later exhausts, *its* DLQ
  message hits **T10**. A stale `attempt_id` (newer attempt owns the row, **even if its
  lease has since expired**) is **T11** `dlq_stale_attempt`. A `retry_wait` row whose retry
  reached the DLQ before `retry_due_at` + grace is **T10** `retry_exhausted` immediately —
  the exhausted budget is honoured and **T12** does not re-mint an `attempt_id` for it.
- **State race and its cap:** a `player_ineligible` result whose `attempt_state ≠
  players.state` returns the row to `pending` (**T7**) while under cap; at
  `reeval_count ≥ REDEMPTION_MAX_REEVAL` it becomes a **terminal failure** —
  `permanent_failure` / **`state_reevaluation_limit`** (**T8**) — with an operator alert,
  never left `in_progress`, never re-driven, never rendered as `player_ineligible` for the
  current state; reopen only via `repair_run` (**T14**). **T13** covers a re-registration,
  **T15** the sweeper catch-up; `idempotency_key` stays stable; `success` /
  `already_redeemed` never reopen (**T16**).
- **Staging spike exception:** reachable at **both** the `DiscordEventSource` (forwards
  allow-listed bot/webhook senders) and the Ingestion Worker (authoritative gate); the
  production filter is unconditional because `SPIKE_SENDER_ALLOWLIST` is absent there.
- **Genuinely frozen summary source:** the instant `summary_state` leaves `none`,
  `operation_items` for that operation is frozen — a later redemption outcome goes to
  **`operation_late_results`**, and `display_label` was immutable from item creation. The
  paged seal copies only those frozen rows (never reads `players`); both build passes **and
  the summary counters** read only `summary_item_snapshot`. A layout page that ends
  mid-chunk persists the open-chunk accumulator (`summary_layout_open`) with
  `summary_layout_cursor` in the same `db.batch()`.
- **Discord output:** durable per-chunk `discord_output_deliveries` built by a **paged,
  crash-resumable** seal + layout + render process over the immutable snapshot, bounded per
  `db.batch()`, capped at `SUMMARY_MAX_CHUNKS`; one logical result, at-least-once delivery,
  bounded duplicate suppression; footer only in the final chunk.
- **D1 → Queue reliability:** per-item transactional outbox carrying `attempt_id`; `dead`
  rows are atomic-reopened (fresh `attempt_id`) while `summary_state='none'`, or the outcome
  is recorded in `operation_late_results` + handed to a `repair_run` once the snapshot is
  sealed / finalized (no ineffective requeue).
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
- Tuning during implementation: lease durations (`ITEM_CLAIM_LEASE_SECONDS`;
  `REDEMPTION_CLAIM_LEASE_SECONDS` — the **invocation** lease, which **must exceed the
  provider call timeout** so a lease never expires mid-call (T3 then guarantees no second
  call); `OUTPUT_CLAIM_LEASE_SECONDS`), `FANOUT_EXPANSION_PAGE_SIZE`,
  `SUMMARY_BUILD_PAGE_SIZE`, `SUMMARY_MAX_CHUNKS`, `SWEEPER_REDRIVE_BATCH`,
  `REDEMPTION_MAX_REEVAL`, the `retry_wait` backoff schedule, and the single-batch size
  threshold that triggers state-machine acceptance.
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

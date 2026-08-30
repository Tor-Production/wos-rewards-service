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
  Lease contention is separated from provider-failure retry accounting, every global
  terminal transition is guarded by claim ownership + attempt generation, and terminal
  results are re-evaluable per reason (state-dependent failures reopen when the player's
  `state` changes).
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
| `REDEMPTION_CLAIM_LEASE_SECONDS` | consumers, sweeper | global `redemptions` claim lease TTL; set comfortably above the provider-retry `delaySeconds` so the owner keeps its claim across redeliveries |
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
  6. **if the accepted registration changed `players.state`**, the guarded reopen of any
     state-dependent `redemptions` failures for this `player_id`
     ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)) — never
     touching `success` / `already_redeemed` rows.

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
    Q->>C: job {operation_id, item_key=code, job_id}
    C->>DB: claim operation_items lease (queue-dedup + accounting)
    C->>R: upsert-and-claim redemptions(player_id, code); attempt_generation += 1 on grant
    alt redemption already terminal
      R-->>C: terminal outcome (success | already_redeemed | permanent_failure | retry_exhausted)
      C->>DB: mirror outcome onto operation_items
    else claim won
      C->>DB: stamp last_attempt_token/generation/state WHERE claim_token+generation match
      C->>P: redeem(PlayerRef{playerId,state}, code, idempotencyKey)
      P-->>C: success | already_redeemed | retryable | permanent
      C->>DB: write redemptions terminal row WHERE claim_token AND attempt_generation match AND status='in_progress'; mirror onto operation_items
      Note over C,Q: retryable => message.retry + re-extend claim_expires_at (owner path only)
    else claim held elsewhere (live lease)
      C->>DB: release operation_items lease (back to pending)
      C->>Q: ack (no message.retry, no max_retries consumed)
      Note over R: Operation sweeper re-drives the pair later (fresh job)
    end
  end
  C->>DB: all items terminal? start paged summary build (layout pass + render pass, cursor-driven, idempotent)
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
3. **Consume:** each job carries `{operation_id, item_key: code, job_id}`. The consumer:
   - claims the `operation_items` lease ([§15.1](#151-operation-item-lease-queue-dedup--accounting));
   - **claims the global `redemptions` record** for `(player_id, code)`
     ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)); if it is
     already terminal it reuses that outcome without calling the provider; if the claim is
     held by a **live lease elsewhere** it **releases its `operation_items` lease, `ack`s
     the message, and stops** — the Operation sweeper re-drives the pair later (no
     `message.retry`, no `max_retries` consumed);
   - on a won claim, stamps `last_attempt_token` / `last_attempt_generation` /
     `last_attempt_state` on the global row, then calls
     `WhiteoutProvider.redeem({ playerId, state }, code, idempotencyKey)`, honouring
     `PROVIDER_RATE_LIMIT_PER_SECOND`, and on a `retryable` outcome uses
     `message.retry({ delaySeconds })` **and re-extends `claim_expires_at`**
     ([§17](#17-retry-and-permanent-failure-classification));
   - writes the `redemptions` terminal row **guarded on
     `claim_token = :tok AND attempt_generation = :gen AND status = 'in_progress'`**, then
     mirrors the outcome onto its `operation_items` row.
4. **Aggregate & summarize:** when every item is terminal
   ([§15.3](#153-completion-accounting)), the operation's summary is built by a **paged,
   cursor-driven, idempotent** process
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
5. **Consume** (`code-fanout-jobs`): claim the `operation_items` lease, then **claim the
   global `redemptions` record** for `(player_id, code)` exactly as in
   [§6](#6-existing-code-processing-after-registration) — join/reuse a terminal outcome;
   on a live lease elsewhere **release the item lease and `ack`** (sweeper re-drive, no
   retry budget); or call the provider on a won claim with generation-guarded terminal
   writes.
6. **Aggregate & summarize:** when `expansion_state = expanded` **and** all items are
   terminal, the operation's summary is built by the **paged, cursor-driven, idempotent**
   process ([§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery)):
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
| Registration consumer | Claim item lease; **claim global redemption**; reuse a terminal outcome, or **release + `ack`** on live-lease contention, or redeem on a won claim with generation-guarded terminal writes; mirror outcome; trigger summary build | Queue consumer; contention never uses `message.retry` |
| Fan-out consumer | Same as the registration consumer, for one `(player_id, code)` per job; triggers summary build when expansion done | Queue consumer |
| DLQ inspection consumer | Terminalize the global `redemptions` row `retry_exhausted` **only** when it is `in_progress`, its claim lease has expired (no owner working it), and `attempt_generation` is unchanged in the same transaction; on a live lease record `dlq_ownership_mismatch` and re-check with a bounded self `message.retry`; mirror to non-terminal `operation_items` | Consumer of `redemption-dlq`; only owner-path messages ever reach it |
| Operation sweeper | Force-close operations past `OPERATION_DEADLINE_SECONDS`; reset expired item / redemption / output-delivery leases (`in_progress → pending` only); mirror terminal redemptions onto waiting items; **re-drive** up to `SWEEPER_REDRIVE_BATCH` stuck non-terminal pairs whose global redemption is non-terminal and unleased (fresh job, fresh retry budget); atomic-reopen outbox-dead items pre-summary; optional bounded `retry_exhausted` reopen | Cron |
| Discord output builder | **Paged, cursor-driven, idempotent**: layout pass assigns `operation_items` to chunks (`summary_chunk_layout`), render pass persists `discord_output_deliveries` rows; deterministic `delivery_id` / `nonce` / content per `(operation_id, chunk_index)`; footer only in the final chunk; capped at `SUMMARY_MAX_CHUNKS` | Cron (shared `scheduled()` handler) + inline best-effort |
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
| Summary builder | every minute | advance the layout + render cursors for operations that are finalisable or in `summary_state = 'building'` ([§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery)); shares the `scheduled()` handler |
| Output delivery dispatcher | every minute | claim and send `pending` / lease-expired `discord_output_deliveries` chunks in `chunk_index` order; resume at the first unsent chunk |
| Operation sweeper | every minute | force-close operations past `deadline_at` with a partial summary; reset expired item / redemption / output-delivery leases (`in_progress → pending` only); mirror terminal `redemptions` onto waiting `operation_items`; re-drive up to `SWEEPER_REDRIVE_BATCH` stuck non-terminal, unleased pairs; optional bounded `retry_exhausted` reopen |
| Retention | hourly | delete fully-accounted `enqueued` outbox rows, `sent` delivery rows, and `summary_chunk_layout` rows for delivered operations past the retention window |
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
| `status` | TEXT | `pending` / `in_progress` / `success` / `already_redeemed` / `permanent_failure` / `retry_exhausted`; may transition `permanent_failure → pending` (guarded state-change reopen) or `permanent_failure` / `retry_exhausted → pending` (operator `repair_run`); **`success` / `already_redeemed` never transition** |
| `claim_token` | TEXT NULL | current claimant |
| `claim_expires_at` | TEXT NULL | lease expiry (`REDEMPTION_CLAIM_LEASE_SECONDS`); the owner re-extends it on every redelivery while it still holds the claim |
| `attempt_generation` | INTEGER | bumped by **every** granted claim; every terminal write is guarded on `(claim_token, attempt_generation)` |
| `attempts` | INTEGER | provider-call attempts for the current claim (reset on reopen) |
| `last_attempt_token` | TEXT NULL | claim token of the owner that made the most recent provider call — the DLQ ownership witness |
| `last_attempt_generation` | INTEGER NULL | generation of that owner |
| `last_attempt_state` | TEXT NULL | `PlayerRef.state` used by that attempt; compared on state-change reopen |
| `last_attempt_at` | TEXT NULL | timestamp of that attempt |
| `reeval_count` | INTEGER | number of guarded reopens; capped by `REDEMPTION_MAX_REEVAL` |
| `provider_receipt` | TEXT NULL | optional reconciliation reference from a real provider |
| `reason_code` | TEXT NULL | for `permanent_failure` / `retry_exhausted`; classifies reopen eligibility ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)) |
| `first_claimed_at`, `terminal_at`, `updated_at` | TEXT NULL | |

PK `(player_id, code)`. This row — **not** `operation_items` — is the sole authority for
whether `WhiteoutProvider.redeem` may be called for the pair. A message that only ever
**contended** for the claim (never won it) can never write any status here.

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
| `summary_state` | TEXT | `none` / `building` / `built` / `delivering` / `delivered` (real per-chunk state lives in `discord_output_deliveries`) |
| `summary_delivery_group` | TEXT NULL | groups this operation's summary chunk rows — deterministic, `sum:<operation_id>` |
| `summary_chunk_total` | INTEGER NULL | set when the layout pass completes; `≤ SUMMARY_MAX_CHUNKS` |
| `summary_layout_cursor` | TEXT NULL | keyset position of the layout pass over `operation_items` (resumable) |
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
| `claim_token` | TEXT NULL | lease token (queue-dedup + accounting only) |
| `claim_expires_at` | TEXT NULL | lease expiry (`ITEM_CLAIM_LEASE_SECONDS`) |
| `reason_code` | TEXT NULL | |
| `attempts` | INTEGER | |
| `updated_at` | TEXT | |

PK `(operation_id, item_key)`. The item lease dedupes queue redeliveries and drives
completion accounting; it does **not** authorize a provider call.

### `operation_players_snapshot` (distribution runs only; optional)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `player_id` | TEXT | PK part |

Point-in-time player boundary when a monotonic cursor filter is not used.

### `summary_chunk_layout` (deterministic item→chunk assignment)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `chunk_index` | INTEGER | PK part, 1-based |
| `first_item_key`, `last_item_key` | TEXT | keyset bounds of the `operation_items` window rendered into this chunk, in the fixed sort order (`status_rank` [`success`, `already_redeemed`, `permanent_failure`, `retry_exhausted`], then `player_id`, then `code`) |
| `overflow_remaining` | INTEGER NULL | on the final chunk when the summary is capped: how many items are represented by the `"+N more not listed"` line |
| `created_at` | TEXT | |

PK `(operation_id, chunk_index)`. Written in bounded pages by the layout pass; rows are a
pure function of the frozen terminal `operation_items`, so a crash-resumed layout
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
| `payload_json` | TEXT | the queue message body |
| `status` | TEXT | `pending` / `enqueued` / `dead` |
| `attempts` | INTEGER | |
| `available_at` | TEXT | backoff gate |
| `last_error` | TEXT NULL | |
| `created_at`, `updated_at` | TEXT | |

---

## 13. Cloudflare Queue and dead-letter-queue boundaries

- **Queues:** `registration-jobs`, `code-fanout-jobs`. One message per unit of work,
  carrying `{operation_id, item_key, job_id, player_id, code}` in the body. Cloudflare
  Queues exposes **no producer-side idempotency key** — deduplication is entirely
  consumer-side **[fact:C7]**. Delivery is at-least-once, so consumers must be safely
  re-runnable.
- **Batching / limits:** batch size ≤ 100 messages / 256 KB, batch wait ≤ 60 s, message
  ≤ 128 KB, `delaySeconds` ≤ 24 h, `max_retries` up to 100 **[fact:C8]**. `message.retry({
  delaySeconds })` with backoff up to `PROVIDER_MAX_RETRIES` is used **only** on the
  owner path for provider `retryable` outcomes.
- **Contention is never a retry.** When a consumer finds the global `redemptions` claim
  held by a live lease it **releases its `operation_items` lease, `ack`s the message, and
  stops**. It never calls the provider, never calls `message.retry`, and never touches the
  global row. The pair is re-driven later by the Operation sweeper as a **fresh queue
  message with a fresh `max_retries` budget**. Consequence: **every message that reaches
  `redemption-dlq` was an owner-path attempt that held the global claim** — a
  waiter/contention message can never reach the DLQ.
- **DLQ:** `redemption-dlq` receives a message only after its owner-path consumer exhausts
  `max_retries` **[fact:C6]** — so a DLQ message unambiguously means "an owner-path attempt
  is gone with its retries spent". The inspection consumer's terminal write is guarded:
  ```sql
  UPDATE redemptions
     SET status = 'retry_exhausted', reason_code = 'provider_retry_exhausted',
         claim_token = NULL, claim_expires_at = NULL, terminal_at = :now, updated_at = :now
   WHERE (player_id, code) = (:pid, :code)
     AND status = 'in_progress'                      -- current non-terminal status
     AND claim_expires_at < :now                     -- no owner is actively working it
     AND attempt_generation = :gen_read_this_txn;    -- lost to a concurrent fresh claim
  ```
  If the row instead has a **live** lease (`claim_expires_at >= now`), a consumer is
  actively re-driving it: the DLQ consumer changes nothing, records a
  `dlq_ownership_mismatch` diagnostic, and re-checks with a bounded `message.retry` on the
  **DLQ message itself** (a check loop — no provider call, bounded by
  `OPERATION_DEADLINE_SECONDS`). If the row is already terminal or `pending`, it does
  nothing. When it does terminalize it mirrors `retry_exhausted` onto every non-terminal
  `operation_items` row for the pair. A **contention/waiter** message never reaches the DLQ
  (previous bullet), so it can never terminalize the shared row. **Business-rule
  (`permanent`) failures never enter the DLQ** — they are recorded as terminal outcomes
  directly.
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
    `outbox_jobs` row to `pending` (`attempts = 0`, `available_at = now`) **and** the
    matching `operation_items` row to `pending` (`claim_token = NULL`). The guard makes the
    reset a no-op once the operation has moved on. (`operation_items` are frozen once the
    layout pass begins, so `summary_state <> 'none'` — `building` / `built` / `delivering` /
    `delivered` — takes the repair path below.)
  - **Human-triggered repair (summary already building or done).** If
    `operations.summary_state <> 'none'` **or** `operations.state IN
    ('summarized','stale_closed')`, the dispatcher records the `operation_items` row as
    `retry_exhausted` (reason `outbox_dead`) so accounting is closed, raises an alert, and
    creates a `repair_run` operation stub (`type = 'repair_run'`, `trigger_ref` = origin
    `operation_id`) listing the affected `(player_id, code)` pairs. A human triggers the
    repair, which reuses the global `redemptions` records and produces its own summary. A
    finalized operation is **never** mutated in place.
- **Recovery:** on restart the dispatcher simply re-scans `pending`. The operation sweeper
  resets rows stuck in `enqueued` with no downstream progress past a threshold back to
  `pending`. A retention job deletes fully-accounted `enqueued` rows after a fixed period.

---

## 15. Redemption serialization, aggregation, and durable summary delivery

### 15.1 Operation-item lease (queue-dedup + accounting)

Each `operation_items` row carries a short lease so a redelivered or duplicated queue
message does not run the same item body twice, and so completion accounting is stable.

- **States:** `pending` → `in_progress` (`claim_token`, `claim_expires_at`) → `success` |
  `already_redeemed` | `permanent_failure` | `retry_exhausted`.
- **Atomic claim:**
  ```sql
  UPDATE operation_items
     SET status = 'in_progress', claim_token = :tok, claim_expires_at = :exp, updated_at = :now
   WHERE operation_id = :op AND item_key = :key
     AND (status = 'pending' OR (status = 'in_progress' AND claim_expires_at < :now));
  ```
  Proceed only if one row changed. A redelivery that finds the item terminal, or
  `in_progress` with a live lease, is acked as a no-op.
- The item lease **does not authorize a provider call** — that is §15.2. It only guards the
  local item body (claim global redemption, mirror the outcome).

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
- **Upsert-and-claim (bumps the attempt generation on every grant):**
  ```sql
  INSERT INTO redemptions (player_id, code, idempotency_key, status,
                           claim_token, claim_expires_at, attempt_generation, attempts,
                           first_claimed_at, updated_at)
       VALUES (:pid, :code, :idk, 'in_progress', :tok, :exp, 1, 0, :now, :now)
  ON CONFLICT (player_id, code) DO UPDATE
       SET status = 'in_progress', claim_token = :tok, claim_expires_at = :exp,
           attempt_generation = redemptions.attempt_generation + 1, attempts = 0,
           updated_at = :now
     WHERE redemptions.status = 'pending'
        OR (redemptions.status = 'in_progress' AND redemptions.claim_expires_at < :now);
  ```

#### Three outcomes

1. **Terminal already** (`success` / `already_redeemed` / `permanent_failure` /
   `retry_exhausted`): the `ON CONFLICT` guard does not match; the consumer **does not call
   the provider**. It reads the terminal row and mirrors the outcome onto its
   `operation_items` row.
2. **Claim won** (row now `in_progress` with this `(claim_token, attempt_generation)`):
   - stamp the ownership witnesses, guarded:
     ```sql
     UPDATE redemptions
        SET last_attempt_token = :tok, last_attempt_generation = :gen,
            last_attempt_state = :state, last_attempt_at = :now, attempts = attempts + 1,
            updated_at = :now
      WHERE (player_id, code) = (:pid, :code)
        AND status = 'in_progress' AND claim_token = :tok AND attempt_generation = :gen;
     ```
   - call `redeem({ playerId, state }, code, idempotency_key)`;
   - **on a terminal result**, write it guarded on ownership + generation + status:
     ```sql
     UPDATE redemptions
        SET status = :result, reason_code = :rc, provider_receipt = :rcpt,
            claim_token = NULL, claim_expires_at = NULL, terminal_at = :now, updated_at = :now
      WHERE (player_id, code) = (:pid, :code)
        AND status = 'in_progress' AND claim_token = :tok AND attempt_generation = :gen;
     ```
     then mirror onto `operation_items`;
   - **on `retryable`**, `message.retry({ delaySeconds })` **and** re-extend
     `claim_expires_at` (guarded on the same `(claim_token, attempt_generation)`). On
     redelivery the consumer re-runs the claim step: it re-acquires its own live claim, or
     — if its lease lapsed and another consumer took over — finds contention (outcome 3) or
     a terminal row (outcome 1) and exits without further provider calls.
3. **Claim held elsewhere** (`in_progress`, live lease held by a different token):
   the consumer **releases its `operation_items` lease** (`status = 'pending'`,
   `claim_token = NULL`) and **`message.ack()`s**. It does **not** call the provider, does
   **not** call `message.retry`, and **does not write anything to the `redemptions` row**.
   Forward progress comes from the sweeper re-drive below. A message on this path can never
   reach the DLQ and can never terminalize the shared row.

#### Ownership-guarded terminal transitions

`attempt_generation` bumps on every granted claim. `last_attempt_token` /
`last_attempt_generation` / `last_attempt_state` witness the attempt that made the most
recent provider call.

- A **consumer** terminal write (`success`, `already_redeemed`, `permanent_failure`) is
  guarded `WHERE status = 'in_progress' AND claim_token = :tok AND attempt_generation =
  :gen` — the writer must still hold the exact claim it acted under.
- The **DLQ inspection consumer**'s `retry_exhausted` write is guarded `WHERE status =
  'in_progress' AND claim_expires_at < :now AND attempt_generation = :gen_read_this_txn`
  ([§13](#13-cloudflare-queue-and-dead-letter-queue-boundaries)) — an expired lease means
  no owner is working the pair, and the generation is re-read in the same transaction so a
  concurrent fresh claim wins.
- The **sweeper**'s lease-expiry recovery moves the row **only `in_progress → pending`** and
  never writes a terminal status.

A stale attempt therefore cannot overwrite a fresher claim's result, and a non-owning
(contention) message — which never held a `(claim_token, attempt_generation)` and never
reaches the DLQ — can write nothing here.

#### Crash-safe re-drive (Operation sweeper)

Every minute, bounded by `SWEEPER_REDRIVE_BATCH`, the sweeper:

- resets `redemptions` rows stuck `in_progress` past `claim_expires_at` to `pending`
  (lease recovery, `in_progress → pending` only);
- finds `(player_id, code)` pairs where some `operation_items` row is non-terminal **and**
  the global `redemptions` row is non-terminal **and unleased**
  (`claim_token IS NULL` OR `claim_expires_at < now`) — meaning nobody is working it — and
  **re-enqueues one fresh job per such pair** (fresh `max_retries` budget);
- mirrors any now-terminal `redemptions` outcome onto every non-terminal `operation_items`
  row for the pair:
  ```sql
  UPDATE operation_items
     SET status = :mirror, reason_code = :rc, updated_at = :now
   WHERE (player_id, code) = (:pid, :code)
     AND status IN ('pending', 'in_progress');
  ```

This single mechanism covers contention `ack`s, owner crashes mid-retry, and lost queue
messages. While any `operation_items` for a pair is non-terminal and the operation is within
its deadline, the pair keeps being re-driven.

#### Terminality is per `reason_code`

| Outcome / `reason_code` | Terminality | Reopen path |
|---|---|---|
| `success`, `already_redeemed` | **immutable** | never |
| `permanent_failure` / `player_ineligible` (**state-dependent**) | terminal until the player's `state` changes | **auto**: the atomic acceptance batch of a valid re-registration that changes `players.state` reopens it (SQL below); `reeval_count += 1`; capped by `REDEMPTION_MAX_REEVAL`, after which only a `repair_run` may reopen it |
| `permanent_failure` / `code_invalid`, `code_expired` (**code-dependent**) | terminal | operator `repair_run` only (e.g. after correcting `gift_codes.status`) |
| `permanent_failure` / `provider_bad_request`, `provider_auth_failed` (**operational**) | terminal | operator `repair_run` only, after the operational cause is fixed |
| `retry_exhausted` (**operational**) | terminal for accounting | operator `repair_run`; **or** a bounded sweeper auto-reopen after a cooldown when `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED = true` (capped by `REDEMPTION_MAX_REEVAL`) |

**State-change reopen** (runs inside the same atomic acceptance `db.batch()` as the
re-registration, [§5](#atomic-acceptance)):

```sql
UPDATE redemptions
   SET status = 'pending', claim_token = NULL, claim_expires_at = NULL,
       reason_code = NULL, terminal_at = NULL,
       attempts = 0, attempt_generation = attempt_generation + 1,
       reeval_count = reeval_count + 1, updated_at = :now
 WHERE player_id = :pid
   AND status = 'permanent_failure'
   AND reason_code IN ('player_ineligible')            -- explicitly state-dependent only
   AND reeval_count < :max_reeval
   AND (last_attempt_state IS NULL OR last_attempt_state <> :new_state);
```

It never matches `success` / `already_redeemed` / code-dependent / operational rows. The
new registration operation's own `operation_items` for the pair then drive a fresh claim →
a fresh provider call with the new `state`. Already-`summarized` operations are **not**
retroactively changed. `MockWhiteoutProvider` is idempotent by construction; a compliant
production provider is required to be, or acceptance fails
([whiteout-provider-decision.md §5](whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider)).

#### Crash ambiguity

If a real provider performs the redemption but the Worker crashes before the guarded
terminal write, the retried message re-enters outcome 2 (same or a fresh generation). This
is why a production `WhiteoutProvider` **must** support a stable redemption idempotency key
or an authorized reconciliation lookup
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
chunk `k` is a pure function of `(operation_id, k)` and the **frozen** terminal
`operation_items` in the fixed sort order (`status_rank` [`success`, `already_redeemed`,
`permanent_failure`, `retry_exhausted`], then `player_id`, then `code`). A crash-resumed
build therefore re-derives byte-identical rows.

1a. **Layout pass (paged, resumable).** Stream `operation_items` in the fixed sort order in
    keyset pages of `SUMMARY_BUILD_PAGE_SIZE`. Accumulate rendered byte length; when the
    running chunk would exceed `DISCORD_MESSAGE_MAX_LENGTH` minus headroom for the
    `(part N/M)` marker **and** the footer (reserved on *every* chunk boundary so
    `chunk_total` never shifts, even though the render pass writes the footer only on the
    last chunk), close the current chunk. In one
    **bounded** `db.batch()` write the completed `summary_chunk_layout(operation_id,
    chunk_index, first_item_key, last_item_key)` rows (`ON CONFLICT DO NOTHING`) **and**
    advance `operations.summary_layout_cursor` — atomically, so a crash resumes from the
    persisted cursor. If the chunk count reaches `SUMMARY_MAX_CHUNKS`, stop: the final chunk
    records `overflow_remaining` (items beyond the cap) and will render a deterministic
    `"+<overflow_remaining> more not listed"` line. On completion set
    `operations.summary_chunk_total` and `summary_state = 'building'`.
1b. **Render + persist pass (paged, resumable, idempotent).** For `chunk_index` from
    `summary_build_cursor + 1`, in pages of `SUMMARY_BUILD_PAGE_SIZE`: read that chunk's
    item window from `summary_chunk_layout` (a bounded read), render its content with the
    `(part chunk_index/summary_chunk_total)` marker and — **only when
    `chunk_index = summary_chunk_total`** — the runtime footer; `INSERT` the
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
**immediately finalisable**. The layout pass produces `summary_chunk_total = 1` in one page;
the render pass persists a **single** `discord_output_deliveries` row
(`chunk_index = chunk_total = 1`, `has_footer = 1`) with a zero-result body
(`"0 codes applied"` / `"applied to 0 players"`), delivered by the same dispatcher. The
runtime footer is present in that one chunk.

### 15.6 Scenario matrix

| Scenario | Handling |
|---|---|
| All items terminal | Layout pass → render pass → dispatcher delivers chunks in order → `summary_state = 'delivered'` |
| An item's redemption is held by a live lease elsewhere | Consumer **releases its item lease and `ack`s** — no `message.retry`, no `max_retries` consumed; the sweeper re-drives the pair (fresh job) or mirrors the outcome once the owner terminalizes |
| A **contention/waiter** message | Never calls `message.retry`, never reaches the DLQ, never writes to the global `redemptions` row |
| An **owner-path** message exhausts retries → DLQ | DLQ consumer sets the global row `retry_exhausted` **only if** `status='in_progress'`, the claim lease has expired (`claim_expires_at < now`, so no owner is working it), and `attempt_generation` is unchanged in the same transaction; a live lease ⇒ `dlq_ownership_mismatch` + bounded self re-check; already terminal / `pending` ⇒ no-op |
| Claim owner crashes mid-retry | Lease expires → sweeper resets the global row `in_progress → pending` (never terminal) → sweeper re-drives the pair with a fresh job |
| Player re-registers with a corrected `state` after `player_ineligible` | The atomic acceptance batch reopens the guarded state-dependent `redemptions` row (`permanent_failure → pending`, `attempt_generation += 1`, `reeval_count += 1`, capped by `REDEMPTION_MAX_REEVAL`); the new operation's items re-drive a fresh provider call with the new `state`; `success` / `already_redeemed` are never reopened |
| An `outbox_jobs` row goes `dead` **before** summary | Dispatcher **atomic-reopens** the outbox + item rows (guarded on `summary_state='none'`) |
| An `outbox_jobs` row goes `dead` **after** finalization | Item recorded `retry_exhausted (outbox_dead)`; alert; `repair_run` stub created; finalized operation not mutated |
| Operation misses `deadline_at` | Sweeper → `state = 'stale_closed'`; build a **partial** summary (`output_type = 'partial_summary'`: success / already_redeemed / permanent-failure / retry-exhausted / still-pending counts, labelled partial) via the same paged build, footer in the final chunk; late results update items for audit only, no second summary |
| Crash mid summary build | Resume from `summary_layout_cursor` / `summary_build_cursor`; re-derived layout / delivery rows are byte-identical (`ON CONFLICT DO NOTHING`) |
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
| **Redemption (global)** | `redemptions (player_id, code)` | upsert-and-claim with `claim_token` + lease + `attempt_generation`; **sole provider-call authority**; deterministic `idempotency_key` (stable across re-evaluations); **every terminal write guarded on `(claim_token, attempt_generation)` + `status='in_progress'`**; `success` / `already_redeemed` immutable; state-dependent `permanent_failure` reopenable on a guarded `state` change; contention messages can write nothing here |
| Operation item | `operation_items (operation_id, item_key)` | PK + short lease (queue-dedup + accounting only); mirrors the global outcome |
| Outbox → Queue | `outbox_jobs.job_id` in the message body | **consumer-side** dedup (no producer key, [fact:C7]) |
| Discord output (per chunk) | `discord_output_deliveries.delivery_id` + deterministic `nonce`; `summary_chunk_layout (operation_id, chunk_index)` | built by a **paged, cursor-driven** process; `delivery_id` / `nonce` / content are pure functions of `(operation_id, chunk_index)` + frozen items; layout & render passes resume from cursors with `ON CONFLICT DO NOTHING`; `enforce_nonce` bounded suppression ([fact:D6]); delivery resumes at first unsent chunk |

Queues are at-least-once **[fact:C7][fact:C8]**; every consumer is written to be safely
re-runnable.

---

## 17. Retry and permanent-failure classification

| Provider / transport signal | Class (`reason_code`) | Action | Reopen |
|---|---|---|---|
| HTTP 429, `Retry-After` present | `retryable` | owner path: `message.retry`, honour `Retry-After`, exponential backoff, re-extend the claim lease | — |
| HTTP 5xx, connection reset, timeout | `retryable` | owner path: retry with backoff up to `PROVIDER_MAX_RETRIES` | — |
| Provider "rate limited" / "temporarily unavailable" | `retryable` | owner path: retry with backoff | — |
| Redemption succeeded now | `success` | terminal, guarded write; record `provider_receipt` if returned | **never** |
| Redemption already applied for this pair | `already_redeemed` | **terminal, success-equivalent**; no retry; counts toward `applied`; never a failure | **never** |
| Invalid / expired / disabled code | `permanent` (`code_invalid` / `code_expired`) | terminal `permanent_failure`, no retry, **never DLQ** | operator `repair_run` only |
| Player ineligible / unknown to the game | `permanent` (`player_ineligible`) — **state-dependent** | terminal `permanent_failure` | **auto** on a valid re-registration that changes `players.state` (guarded, `reeval_count += 1`, capped by `REDEMPTION_MAX_REEVAL`; then `repair_run` only) |
| Bad request / auth failure | `permanent` (`provider_bad_request` / `provider_auth_failed`) — operational | terminal `permanent_failure` | operator `repair_run` only, after the cause is fixed |
| Input validation failure (bad `PLAYER_ID`) | n/a | never reaches a queue; durable validation reply instead ([§5](#invalid-message-reply)) | — |
| Owner-path retries exhausted | `retry_exhausted` | message → `redemption-dlq`; the global row is set `retry_exhausted` **only** by the DLQ consumer's ownership-guarded write ([§13](#13-cloudflare-queue-and-dead-letter-queue-boundaries)); mirrored items marked `retry_exhausted` | operator `repair_run`; or bounded sweeper reopen when `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED` |

Backoff, `delaySeconds`, and `PROVIDER_MAX_RETRIES` stay within Queue limits **[fact:C8]**.
Contention never consumes the retry budget ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)).

---

## 18. Discord output safety

- **Sanitisation:** display names and any echoed user input are sanitized before rendering
  (strip/escape backticks, `@`, `#`, `:` role/emoji triggers, zero-width and control
  characters; cap length). Sanitisation happens **at build time**, before the chunk content
  is persisted immutably in `discord_output_deliveries`.
- **Mention suppression:** every Create Message call sets `allowed_mentions` to an empty
  allow-list so `@everyone`, role, and user mentions never fire.
- **No silent mutation:** the service never edits or deletes a message it did not just
  create; summaries and replies are new messages only.
- **Deterministic chunking:** the builder splits on line boundaries (never mid-name),
  hard-caps each chunk below `DISCORD_MESSAGE_MAX_LENGTH`, adds `(part N/M)` continuation
  markers, and persists **every chunk (in bounded, cursor-resumable pages —
  [§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery))
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
  `already_redeemed` / `retryable` / `permanent` / `retry_exhausted`); redemption claims
  won vs joined-terminal vs contention-released; **contention re-drives** and **sweeper
  re-drives**; **`dlq_ownership_mismatch`** count; **redemption re-evaluations**
  (`reeval_count` bumps, by trigger: state-change vs `repair_run` vs auto); operations by
  `state`; operations `stale_closed`; summary build cursor lag; **summaries capped at
  `SUMMARY_MAX_CHUNKS`**; `discord_output_deliveries` by `status`; unsent-chunk age; DLQ
  depth; queue backlog; outbox backlog and `dead` count; `repair_run` count; Gateway
  reconnect / RESUME / IDENTIFY counts (ingestion tier).
- **Alerts:** DLQ depth > 0, outbox `dead` count > 0, `dlq_ownership_mismatch` rate,
  `discord_output_deliveries` stuck `pending`/`claimed` beyond a threshold, operations stuck
  in `summary_state = 'building'` beyond a threshold, operations `stale_closed` rate,
  `repair_run` created, `reeval_count` hitting `REDEMPTION_MAX_REEVAL`, ingestion tier
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
    `(player_id, code)` result in exactly one provider call; the loser joins/reuses; a
    terminal `redemptions` row is mirrored onto every waiting `operation_items` row (via
    consumer and via sweeper);
  - **contention is not a retry:** a waiter releases its item lease and `ack`s — it never
    calls `message.retry`, never consumes `max_retries`, never reaches the DLQ, and never
    writes to the global `redemptions` row; the sweeper re-drives the pair;
  - **attempt-generation guard:** a stale `(claim_token, attempt_generation)` cannot write
    any terminal status; the DLQ consumer's `retry_exhausted` write is rejected when a newer
    claim is live (`dlq_ownership_mismatch`);
  - **sweeper re-drive:** a pair with a non-terminal item and a non-terminal, unleased
    global row gets a fresh job (fresh `max_retries`); bounded by `SWEEPER_REDRIVE_BATCH`;
  - **per-reason terminality:** `success` / `already_redeemed` never reopen; a
    `player_ineligible` row reopens on a valid re-registration that changes `players.state`
    and is re-driven with the new state; `code_invalid` / operational failures do **not**
    auto-reopen; `REDEMPTION_MAX_REEVAL` cap; `idempotency_key` unchanged across reopen;
  - **`already_redeemed`** counts toward `applied` and never as a failure in totals and
    rendered summaries;
  - **paged summary build:** layout + render passes resume from `summary_layout_cursor` /
    `summary_build_cursor` after a simulated crash; chunk `delivery_id` / `nonce` / content
    are byte-identical across the resume; no single `db.batch()` exceeds a bounded row
    count; footer only in the final chunk; a summary over `SUMMARY_MAX_CHUNKS` emits a
    deterministic `"+N more not listed"` line;
  - **durable output delivery:** dispatcher resumes at the first unsent chunk after a crash;
    validation reply carries no footer; re-send within the nonce window does not duplicate;
  - **outbox `dead`:** atomic reopen before summary; `repair_run` stub after finalization;
    finalized operation never mutated in place;
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
| Two operations target the same `(player_id, code)` | Risk of double provider call | Global `redemptions` claim: one caller wins, others reuse a terminal outcome or **release + `ack`** on live-lease contention; sweeper re-drives; only the claim owner terminalizes (generation-guarded); terminal outcome mirrored to all |
| Contending waiter | Could exhaust `max_retries` → DLQ → poison the shared row | Contention is off the retry path entirely: release item lease + `ack`; the sweeper re-drives with a fresh job/budget; a waiter can never write to the global row or reach the DLQ |
| Claim owner crashes mid-retry | Global row stuck `in_progress` | Lease expires → sweeper resets `in_progress → pending` (never terminal) → sweeper re-drives the pair |
| DLQ'd owner attempt while a newer claim is live | Wrong `retry_exhausted` on the shared row | DLQ consumer terminalizes only when `status='in_progress'`, the claim lease has expired, and `attempt_generation` is unchanged in the same transaction; a live lease ⇒ `dlq_ownership_mismatch` + bounded self re-check; it never overwrites a fresher claim's result |
| Player re-registers with corrected `state` after `player_ineligible` | Old failure would be reused forever | Atomic acceptance reopens the guarded state-dependent `redemptions` row (`permanent_failure → pending`, `reeval_count += 1`, capped); the new operation re-drives it with the new `state`; `success` / `already_redeemed` never reopen |
| Provider redeems then Worker crashes before recording | Ambiguous redemption | Production requires a stable idempotency key or authorized reconciliation; until then production redemption is blocked. Mock is idempotent |
| Queue backlog | Delayed redemptions | Consumers scale (push concurrency up to 250, [fact:C8]); operations bounded by `deadline_at` |
| Provider outage / rate-limit storm | Many `retryable` failures | Owner-path backoff + `PROVIDER_RATE_LIMIT_PER_SECOND`; retries exhaust → DLQ → ownership-guarded `retry_exhausted` on the `redemptions` row and mirrored items; summary lists failures |
| DLQ growth | Redemptions stuck | Alert; DLQ inspection consumer terminalises the `redemptions` row **only when it owns the claim**; operator triage / `repair_run` |
| Very large player list → summary | One unbounded build batch could exceed D1 limits | Paged layout + render passes, bounded per invocation and per `db.batch()`, cursor-resumable, capped at `SUMMARY_MAX_CHUNKS` |
| Crash mid summary build | Partial layout / delivery rows | Resume from `summary_layout_cursor` / `summary_build_cursor`; re-derived rows byte-identical (`ON CONFLICT DO NOTHING`) |
| Duplicate queue delivery | Repeated processing attempt | Absorbed by the item lease + the global redemption claim |
| Partial fan-out (crash mid-expansion) | Some `operation_items` missing | Expansion worker resumes from `expansion_cursor`; finalisation waits for `expanded` |
| Outbox row `dead` before summary | One unit of work never enqueued | Atomic reopen of the outbox + item rows (guarded on `summary_state='none'`) |
| Outbox row `dead` after finalization | Same, but operation already summarized | Item `retry_exhausted (outbox_dead)`; alert; `repair_run` stub; no in-place mutation |
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
  sole provider-call authority; operation items join/reuse its terminal outcome.
- **Contention vs retry accounting:** lease contention is off the `message.retry` path —
  waiters release + `ack`, the sweeper re-drives with a fresh budget; every global terminal
  transition (consumer *or* DLQ) is guarded by `(claim_token, attempt_generation)`; a waiter
  can never terminalize the shared row.
- **Per-reason terminality:** `success` / `already_redeemed` immutable; `player_ineligible`
  (state-dependent) auto-reopens on a `state` change; `code_invalid` / operational failures
  and `retry_exhausted` reopen only via `repair_run` (or a bounded opt-in sweeper reopen for
  `retry_exhausted`); all capped by `REDEMPTION_MAX_REEVAL`; `idempotency_key` stays stable.
- **Staging spike exception:** reachable at **both** the `DiscordEventSource` (forwards
  allow-listed bot/webhook senders) and the Ingestion Worker (authoritative gate); the
  production filter is unconditional because `SPIKE_SENDER_ALLOWLIST` is absent there.
- **Discord output:** durable per-chunk `discord_output_deliveries` built by a **paged,
  cursor-driven, crash-resumable** layout + render process (`summary_chunk_layout`), bounded
  per `db.batch()`, capped at `SUMMARY_MAX_CHUNKS`; one logical result, at-least-once
  delivery, bounded duplicate suppression; footer only in the final chunk.
- **D1 → Queue reliability:** per-item transactional outbox; `dead` rows are atomic-reopened
  pre-summary or handed to a `repair_run` after finalization (no ineffective requeue).
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
  `REDEMPTION_CLAIM_LEASE_SECONDS` — must exceed the provider-retry `delaySeconds`,
  `OUTPUT_CLAIM_LEASE_SECONDS`), `FANOUT_EXPANSION_PAGE_SIZE`, `SUMMARY_BUILD_PAGE_SIZE`,
  `SUMMARY_MAX_CHUNKS`, `SWEEPER_REDRIVE_BATCH`, `REDEMPTION_MAX_REEVAL`, and the
  single-batch size threshold that triggers state-machine acceptance.
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

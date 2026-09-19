# Architecture — Discord ingestion and registration

- **Parent:** [architecture.md](../architecture.md) — overview, component map, cross-cutting
  invariants, phased implementation order, and the [traceability map](../architecture.md#traceability-map).
- **Status:** Draft. The ingestion boundary, the author gate, the registration contract, and the two flows that follow acceptance.

> Evidence tags carry the same meaning as in the overview: **[fact:<ref>]** (confirmed by an
> official page listed in [architecture.md §25](../architecture.md#25-official-sources)),
> **[inference]** (a design conclusion drawn from those facts), **[assumption]** (needs a spike
> or human decision).

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
  // own-application messages before creating a RegistrationMessageEvent. In STAGING only
  // listed bot/webhook senders are exempt; own-app and system messages always drop.
  // SPIKE_SENDER_ALLOWLIST senders that pass those gates are forwarded
  // with author_is_bot / author_is_system / webhook_id / application_id UNCHANGED so the
  // Ingestion Worker can validate them. They perform NO player-registration business
  // validation. Phase 3 defines this interface and implements no source adapter.
  forward(event: RegistrationMessageEvent): Promise<"accepted" | "duplicate" | "ignored">;
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

- The separately gated **spike `DiscordEventSource`** (the DO in Option 1 or a future
  spike-capable Option 2 source) does **not** drop a non-webhook bot whose `author_id` is
  allow-listed or a webhook message whose `webhook_id` is allow-listed; it forwards the event
  with all flags intact. This is the only change that lets the spike message *reach* the Worker.
  The Task 09 companion is intentionally not that harness: it has no spike allow-list input and
  drops every bot, system, webhook, and application-authored message.
- The **Ingestion Worker** remains the **authoritative staging gate**: only after the request
  passes `INGESTION_SHARED_SECRET` authentication does it re-check the same
  `SPIKE_SENDER_ALLOWLIST`, drop any bot/webhook sender not on it, and **assert
  `ENVIRONMENT === "staging"`** before consulting the list at all. Bot-authored messages
  match on `author_id`; webhook-authored messages match on `webhook_id` and cannot borrow
  the webhook author's bot id.

The allow-list can only ever hold dedicated bot-account or incoming-webhook ids. A normal
human remains classed as `normal` even if its `author_id` happens to match an entry.
System-authored and own-application messages are always ignored, including when an author
or webhook is allow-listed. Configuration rejects an allow-list containing
`DISCORD_APPLICATION_ID`. The list is never defined in the production config of either tier. See
[ADR 0001 §6](../adr/0001-discord-event-ingestion.md#6-decision-proposed-spike-gated).

### Candidate implementations (decided by [ADR 0001](../adr/0001-discord-event-ingestion.md))

| | `DurableObjectGatewaySource` (Option 1) | `CompanionGatewaySource` (Option 2, provisional) |
|---|---|---|
| Host | A Durable Object holds the outbound Gateway WebSocket | A minimal always-on process outside Cloudflare |
| Reliability basis | **Not guaranteed by docs** — outbound WebSockets do not hibernate and an active outbound connection only *prevents eviction for up to 15 minutes per connection* **[fact:C2]**; normal lifecycle/eviction timing resumes afterward **[fact:C1]** | A normal long-lived process; standard supervised-restart operations |
| Secrets it holds | Discord bot token (Worker secret) | Discord bot token + `INGESTION_SHARED_SECRET` |
| Decision | The ADR 0001 spike tests whether Option 1 is reliable enough; if it passes, Option 1 is preferred (fewer moving parts) | Provisional reference until the spike completes or is explicitly waived |

**Production-decision rule:** a production `DiscordEventSource` topology is **not selected or
enabled** until the ADR 0001 spike completes or is explicitly waived. Task 09 is an expressly
bounded exception for a usable **staging-only MVP**: it implements the provisional Option 2
companion on a user-controlled Windows host. This neither passes nor waives the 72-hour spike,
does not select Option 2 for production, and does not make Task 08C deployable. Task 08C's
local-only Durable Object integration below remains a test harness for Option 1's mechanics.
Phases 1–4
([§23](../architecture.md#23-phased-implementation-order)) build everything to the right of this boundary
against `RegistrationMessageEvent` alone.

### Task 08C local-only Durable Object integration

`LocalDiscordGatewayAdapter` is a real Durable Object class exercised by the Workers Vitest
runtime. Only `vitest.config.ts` gives it a test namespace; `wrangler.jsonc` contains no
Durable Object binding, class migration, resource identifier, route, or start trigger. The
class's fetch surface returns `404`, and the normal Worker has no path that can configure or
start it. WebSocket creation, sends, close/failure callbacks, clocks, reconnect backoff,
session-start-limit input, acceptance outcomes, durable faults, metrics, and diagnostics are
injected. Tests use fakes and local Cloudflare helpers only; no Discord token or outbound
network implementation exists.

The adapter executes Task 08A's commands in order through one serialized fence. A monotonically
increasing durable generation owns the one active physical lifecycle; callbacks and alarm work
carry that generation, and replacement invalidates it durably before another connection can
become active. Transient sockets, promises, injected functions, raw protocol state, payloads,
and message content are never stored. A validated version-2 Durable Object record contains only
opaque session material and handle reference, the durable checkpoint, generation, retry count,
pending/claimed logical schedules, a closed start disposition, session-start-limit observation,
the core's narrow IDENTIFY/outbound safety snapshot, constructor count, and low-cardinality
counters. Sanitized ignored-dispatch evidence is stored separately by sequence. Session ids and
resume URLs are available only to the persistence/transport adapter and are absent from
inspection and diagnostic shapes.

The start disposition binds lifecycle authority to durable state. `reconnect_pending` preserves
recovery intent across a crash before schedule creation, and `reconnect_scheduled` identifies the
one persisted reconnect item that its due alarm may execute. `start()` cannot bypass either state
or create a second connection. Fatal Gateway closure, any Task 08A local-policy halt, and exhausted
retry budget persist a terminal reason, remove scheduled work, and prohibit later start or
reconnect after reconstruction. Task 08C intentionally exposes no reset or operator mutation
surface; authorization and design of any future terminal reset remain outside this task.

For a target `MESSAGE_CREATE`, the only trusted in-process acceptance path begins after the
established lifecycle's deterministic core emits `accept_target_message`. The adapter itself
re-applies the guild/channel/author gate, preserves every sender field, parses the content, and
calls the existing Task 08B acceptance service. No HTTP header, body, RPC argument, Gateway
payload flag, or caller-selected acceptance class can mint that command or trusted context.
The ordering is acceptance transaction (or verified durable duplicate) → core completion →
core-emitted checkpoint command → monotonic Durable Object checkpoint write. D1 and Durable
Object storage remain separate durability domains: a commit with a lost response replays from
the old checkpoint and resolves through D1 idempotency; a checkpoint commit with a lost response
is suppressed by the equal/stale sequence rule. A staging-spike duplicate is reported as
`duplicate` only after a direct query proves exactly one finalized marker and exactly one
permanently blocked, superseded, non-dispatchable, untouched output row. Missing or malformed
evidence is rejected and leaves the checkpoint unchanged.

READY session material and its READY checkpoint are one Durable Object write before the core is
completed. Resume reconstruction uses only that durable checkpoint, while a live heartbeat uses
the core's latest received sequence. A heartbeat alarm supplies its observed monotonic execution
time to Task 08A; the persisted scheduled time remains the deadline only. Execution exactly at the
deadline is valid, while execution after it enters the existing local-policy halt without sending
or backdating outbound-rate evidence. Increasing sequence gaps are accepted without inferring
loss; target, ignored, and other replay Dispatches execute before `RESUMED`. These are project
safety rules around Discord's documented Resume behavior, not claims of contiguous or
exactly-once delivery. Live residency, missed-event reconciliation, and 72-hour behavior remain
measurements for the separately authorized spike.

### Implemented Task 09 companion scope (Option 2, staging MVP)

The `discord.js` companion requests only the Guilds, Guild Messages, and privileged Message
Content intents. It accepts events only from `DISCORD_GUILD_ID` and the registration/admin
channels for human input, and drops bot, system, webhook, application-authored, wrong-guild,
and wrong-channel messages on those routes. The separate disabled Follow route below is the
only companion exception for a configured follower webhook. For the registration channel it **forwards `content` byte-for-byte as represented by
the JS string**, even when syntax is invalid, because the Cloudflare business layer generates
the validation reply **[inference]**. For the admin channel it accepts only an allow-listed
human and exact `!wos-code CODE` syntax, normalizing surrounding/command whitespace before
forwarding the code. It authenticates both Worker requests with `INGESTION_SHARED_SECRET`, uses
a five-second per-attempt timeout and at most three attempts, and logs fixed outcome categories
only. It has no D1 access and never writes directly to Discord.

This companion is not the ADR spike sender/observer harness and deliberately does not forward
`SPIKE_SENDER_ALLOWLIST` automation. The Task 08B/08C spike acceptance path remains local-only;
the 72-hour spike is deferred.

The manual-code request has the same immutable Discord identity/scope/author/timestamp fields as
`RegistrationMessageEvent`, replacing `content` with `code`. The Worker accepts only the exact
ten-key JSON shape, at most 2 KiB, with a current RFC-3339 timestamp and a 1–64 character
`[A-Za-z0-9_-]` code. It rechecks guild, admin channel, human flags, and administrator identity
after bearer authentication. Results are deliberately limited to
`accepted | duplicate | ignored | unauthorized | unavailable`.

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
  transported as a canonical string** — see [§10](data-model-and-outbox.md#10-identifier-handling).
- If the second token is numeric, it is `STATE` (also kept as a string).
- If the second token is not numeric, `STATE` is `DEFAULT_STATE` (from environment
  configuration, never hard-coded) and the second and all remaining tokens are
  `DISPLAY_NAME`.
- `DISPLAY_NAME` is optional and may contain spaces.
- If no display name is supplied, Discord output uses `ID <PLAYER_ID>`.
- Re-registering an existing player updates the existing row (upsert), never creates a
  duplicate.
- Display names are sanitized and mentions suppressed on output
  ([§18](summary-and-delivery.md#18-discord-output-safety)).
- The bot never infers state or nickname from any Whiteout Survival endpoint. The `STATE`
  carried forward to the provider is exactly the one from this contract.

### Atomic acceptance

The Ingestion Worker never writes a bare "processed" marker before the work. It builds the
**entire write set** for the event and commits it as **one atomic D1 `db.batch()`**
**[fact:C9]**. Its plain `INSERT INTO processed_events (event_id, …)` is placed as early
as the foreign-key graph allows: first for invalid input, immediately after `operations`
for valid input. Foreign-key enforcement stays enabled. A batch error rolls the entire
write set back; one lookup of `processed_events.event_id` then distinguishes a durable
duplicate from an unrelated failure. No SQLite error-message string is used as control
flow. The deterministic operation id can make a duplicate fail on the `operations`
primary key before it reaches the marker; the same marker lookup still applies.

- **Invalid input** — the atomic unit persists, together:
  1. `processed_events` row with `status = 'accepted_invalid'` and `validation_reason`;
  2. the `discord_output_deliveries` row for the validation reply (single chunk,
     deterministic ≤ 25-char nonce, `status = 'pending'`, **no footer**).
- **Invalid input from an authenticated, allow-listed staging spike sender** — the same
  two-statement atomic unit retains deterministic evidence but creates no deliverable work:
  1. `processed_events.acceptance_class = 'staging_spike'`, immediately terminal as
     `status = 'finalized'`, `outcome = 'invalid'`, `operation_id = NULL`, and
     `finalized_at = accepted_at`; `committed_at` remains NULL;
  2. one validation-reply evidence row inserted directly as `status = 'superseded'`,
     `dispatch_eligible = 0`, `suppression_reason = 'staging_spike_sender'`, and
     `permanent_dispatch_block = 1`, with no claim, attempt, Discord message, sent timestamp,
     or due time. It is never first inserted as `pending` or `claimed`.
  A valid-looking message from that automated identity fails closed with no acceptance or
  registration work; the spike's planned `SPIKE-<seq>-<uuid>` probes are intentionally invalid.
- **Valid input** — the atomic unit persists, together:
  1. **if the accepted registration changes `players.state`**, the guarded **T13** reopen of
     any state-dependent (`player_ineligible`, under cap) `redemptions` failures for this
     `player_id` ([§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)) —
     never touching `success` / `already_redeemed` / `state_reevaluation_limit` rows. (An
     old-state attempt still `in_progress` is handled at terminalization by **T7** / **T8**,
     not here.) An `EXISTS` guard reads the old player state before the upsert.
  2. the `players` upsert; `state_updated_at = now` on insertion or an actual state change,
     otherwise the previous timestamp is retained;
  3. the `operations` row (`type = 'registration_run'`, `expansion_state = 'expanded'`)
     with `expected_count` derived from the transaction's active-code count;
  4. `processed_events` with `status = 'work_committed'`, `outcome = 'valid'` and
     `operation_id`; the expanded snapshot already meets the work-committed condition;
  5. all active-code `operation_items` through one set-based `INSERT … SELECT`;
  6. all per-item `outbox_jobs` through one set-based `INSERT … SELECT`, with a fresh
     per-acceptance attempt-run id combined with each item key.

The valid batch is **six statements for every snapshot size**, including zero. Two
invariants hold together:

- **SM-1 — membership:** an accepted registration's item codes are exactly the active
  `gift_codes` seen by the acceptance transaction; `expected_count` equals that set's
  size, and `expansion_state = 'expanded'`. Later status changes or newly inserted codes
  do not change this membership. The baseline foreign key rejects deletion of a
  referenced code; no delete cascade is assumed.
- **SM-2 — cap:** at most `MAX_REGISTRATION_SNAPSHOT_CODES = 2,000` codes are accepted.
  The operation insert always executes and uses
  `CASE WHEN active_count <= cap THEN active_count ELSE -1 END` for `expected_count`.
  Above the cap, the existing `ck_operations_expected_count_nonneg` check rejects the
  statement and the whole batch rolls back, including T13 and the player upsert.
  An existing operation with the deterministic id cannot bypass this guard. There is
  no advisory preflight count. A failure-path count may label the rejection, but both
  cap and D1 failures return the same generic `503`; that label never authorizes writes.

The former deferred registration-shell fallback is withdrawn: `gift_codes` has no
status history, and the existing player snapshot/cursor cannot reconstruct historical
code membership. `expansion_state` / `expansion_cursor` remain the distribution fan-out
mechanism ([§7](#7-new-code-fan-out-flow)). Raising the registration cap would require a
separate design and, for resumable expansion, a proposed `operation_codes_snapshot
(operation_id, code)` migration. No migration is added for Phase 3. The 2,000-row cap
bounds row count; it is not a proof of maximum write bytes or query duration, which must
be measured with representative code sizes before an authorized deployment.

**A crash cannot commit an event marker without its complete registration work or its
validation-reply/evidence row**, because each branch writes them in the same transaction.
Migration 0003 additionally makes a staging-spike marker and its associated output row
immutable through OLD-aware triggers. No later conforming dispatcher or simultaneous field
reset can turn the evidence into deliverable output.

### Invalid message reply

For a normal human, the validation reply is delivered by the **output delivery dispatcher**
([§15.4](summary-and-delivery.md#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery))
from its persisted `discord_output_deliveries` row — the same durable mechanism as
summaries (the trivial one-chunk case). It is
mention-suppressed, describes the accepted forms, and **carries no runtime footer**. A
retry resumes the unsent delivery rather than re-posting, with bounded Discord-side
duplicate suppression **[fact:D6]**.

Phase 3 persists this row only; the output dispatcher is Phase 4. The reply has four
deterministic reason variants, echoes no user input, and describes the four supported
forms. The transport responds `202 accepted` for both valid and invalid registrations;
the ingestion tier does not receive the business outcome.

For an authenticated staging-spike sender, the same deterministic reply text, hash, nonce,
delivery identity, and timestamps are retained only as evidence in the immutable suppressed
shape above. Task 08C exercises this boundary from a local-only Durable Object adapter. A
deployable Gateway transport, sender/observer harness, expected-message ledger, and live
residency measurement remain later Phase 5 work outside this acceptance boundary.

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
  I->>DB: ONE six-statement batch — guarded T13, player upsert, cap-checked operation, processed_events(work_committed), all items, all outbox rows
  Note over DB: Any error rolls back; existing processed_events marker => duplicate, otherwise unavailable
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
   and any guarded state-dependent `redemptions` reopen in one unit. Registration
   acceptance never leaves a deferred shell.
2. **Dispatch** (`registration-jobs`) — inline best-effort plus the Cron dispatcher
   ([§14](data-model-and-outbox.md#14-transactional-outbox)).
3. **Consume:** each job carries `{operation_id, item_key: code, job_id, player_id, code,
   attempt_id}`. The consumer:
   - claims the `operation_items` lease (coarse dedupe)
     ([§15.1](redemption-state-machine.md#151-operation-item-lease-queue-dedup--accounting));
   - **acquires a per-invocation claim** on the global `redemptions` record
     ([§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority), **T1/T2**);
     if the row is already terminal it reuses that outcome; if a **live invocation** already
     holds it, the `retry_wait` is not yet due, or a different `attempt_id` owns it (**T3**),
     it `ack`s and stops — the sweeper (**T12**) re-drives with a fresh `attempt_id`;
   - once it holds `current_invocation_token`, calls
     `WhiteoutProvider.redeem({ playerId, state }, code, idempotencyKey)`, honouring
     `PROVIDER_RATE_LIMIT_PER_SECOND`; a `retryable` outcome ⇒ **T9** (atomically →
     `retry_wait`, clear the invocation, record `retry_due_at`) **then** `message.retry`
     ([§17](redemption-state-machine.md#17-retry-and-permanent-failure-classification));
   - writes the outcome **guarded on `current_invocation_token = :itok AND status =
     'in_progress'`** — **T4** success, **T5** code/operational, **T6** `player_ineligible`
     with `attempt_state = players.state`, **T7** state differs & under cap (→ `pending`),
     **T8** state differs & cap reached (→ `state_reevaluation_limit`) — then mirrors onto
     `operation_items` (only while `summary_state = 'none'`).
4. **Aggregate & summarize:** when every item is terminal
   ([§15.3](summary-and-delivery.md#153-completion-accounting-and-the-source-freeze)), the operation freezes its
   `operation_items` and seals an immutable `summary_item_snapshot`, then builds the summary
   by the **paged, cursor-driven, idempotent** process
   ([§15.4](summary-and-delivery.md#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery)):
   how many codes were applied (`success` + `already_redeemed`) and which, identifying the
   player by display name or `ID <PLAYER_ID>`. The runtime footer from `AGENTS.md` appears
   **only in the final persisted chunk**.

---

## 7. New-code fan-out flow

1. **Supply** a candidate code. In Task 09 an allow-listed staging human uses
   `!wos-code CODE`, which reaches authenticated `POST /manual-code`. Automatic
   `GiftCodeSource` also accepts the separately authorized offline Follow push contract below;
   deployment discovery remains disabled
   ([§11](redemption-state-machine.md#11-whiteoutprovider-and-giftcodesource-abstractions)).
2. **Deduplicate** on `gift_codes.code` (unique). A re-seen code is a no-op.
3. **Open a `code_distribution_run` operation** through the existing `openDistribution` flow and
   fix a **stable player snapshot boundary** in `operation_players_snapshot`, copying player IDs
   and display names in the opening D1 transaction. The same batch inserts the Discord message-id
   marker in `manual_code_commands`; a duplicate event or code opens no second operation. The cap
   is 2,000 players, enforced atomically; `expected_count` is the exact accepted membership size.
4. **Bounded, restartable expansion:** the fan-out expansion worker repeatedly reads the
   next 128 snapshot members after `expansion_cursor` and, in one atomic D1
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
   **paged, cursor-driven, idempotent** process ([§15.4](summary-and-delivery.md#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery)):
   the code, the applied-player count (`success` + `already_redeemed`), and a bounded line list of display names / `ID <PLAYER_ID>` fallbacks. Output is **chunked** when it exceeds
   `DISCORD_MESSAGE_MAX_LENGTH` ([§18](summary-and-delivery.md#18-discord-output-safety)) and capped at
   `SUMMARY_MAX_CHUNKS`; the runtime footer appears **only in the final persisted chunk**.
   Zero registered players ⇒ single-chunk zero-result summary.

### Overlap is handled by the global redemption record

A `registration_run` snapshots the codes active at registration time; a
`code_distribution_run` snapshots the players registered at discovery time. These can still
**overlap for the same `(player_id, code)`** (e.g. a race between a registration and a
just-discovered code). The `redemptions` record for `(player_id, code)` is the **single
provider-call authority** ([§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)):
whichever consumer claims it first calls the provider; every other operation item for the
same pair joins or reuses that terminal outcome and never calls the provider
independently **[inference]**.


### Discord Follow intake

Task 18 implements `MESSAGE_CREATE` intake on the existing companion connection and
`POST /discovered-code` at the Worker, disabled independently in both processes. The
[recorded permission](../whiteout-provider-decision.md#7-gift-code-discovery-source-status)
covers offline staging/mock implementation only. Follow setup and bot permissions are
maintainer-reported; exact live source identities and content access are unverified.

`shared/discord-follow.ts` defines the bounded contract used independently by both processes.
The Worker authenticates with the existing ingestion bearer secret before reading the body,
then validates the original content, schema and configured source again. It accepts only JSON
(up to 2,048 UTF-8 bytes, enforced on declared and streamed length), exactly twelve fields:
`event_id`, `guild_id`, `channel_id`, `webhook_id`, `source_guild_id`, `source_channel_id`,
`source_message_id`, `message_type`, `reference_type`, `flags`, `content`, `created_at`.
All IDs are non-placeholder 17–20 digit snowflakes. Destination guild/feed, follower webhook,
and source guild/channel must equal the configured tuple. Source message ID is required.

The destination message must have default message type 0, default reference type 0 and
IS_CROSSPOST; only flag values 2 and 6 (also SUPPRESS_EMBEDS) are accepted. Other flags, including
SOURCE_MESSAGE_DELETED and forwarding snapshots, fail closed. This rejects replies, ordinary
forwards, system events, unrelated webhooks and missing provenance. `discord.js` maps
`message.reference.{guildId,channelId,messageId,type}`, `message.flags.bitfield`, `message.type`
and `message.webhookId`; an omitted Discord reference type becomes documented default 0.
Bot/name/content flags alone do not establish source identity. No webhook enumeration or
reference/history fetch is added. The [Discord message reference](https://docs.discord.com/developers/resources/message#message-reference-content-attribution)
and [Channel Follower type](https://docs.discord.com/developers/resources/webhook#webhook-object-webhook-types)
are the contract basis; installed discord.js 14.27 types/field mapping were inspected offline.

Content is at most 512 UTF-8 bytes and has exactly three LF or CRLF lines:

```text
📌 Code: TestCode18A
⏰Valid Until: September 20, 23:59 (UTC+0)
🥳 Redemption page: https://wos-giftcode.centurygame.com/
```

Only ASCII spaces/tabs at line edges, between the emoji and label, after colons, between month
and day, after the comma, and before `(UTC+0)` are harmless. At least one space/tab separates
month/day and time/timezone. Labels and English month names are case-sensitive. The code keeps
its original case and uses the existing 1–64 character `[A-Za-z0-9_-]` grammar. The exact HTTPS
URL is text only and is never fetched. Trailing/extra lines, multiple codes, alternate URLs,
controls, other timezones, explicit years, impossible dates and invalid 24-hour times are rejected.
Month/day is validated without guessing a year: February 29 is valid metadata. The normalized
expiry label has unknown year (`expiryYear: null` in the parser); no expiry timestamp or live/expired
claim is derived, and existing operation deadlines remain independent.

Creation timestamps must be valid RFC-3339 and within the inclusive five-minute age / one-minute
future-skew window already used for manual intake. Older events are ignored, including retries
that arrive after the window; accepted work remains durable. No edits/deletions are subscribed to,
no history is backfilled, and no links/references are followed. Subsequent source edits/deletions
do not retract accepted work. Missing Message Content produces an empty payload and is ignored.

Acceptance uses the shared manual/discovery D1 transaction and existing frozen player snapshot,
fanout/outbox/Queue/mock/summary pipeline. It opens no provider call at HTTP intake. The five batch
statements plus one result read are constant; the player cap remains 2,000 and downstream query
and fanout budgets are unchanged. `gift_codes.source` is `discord-follow-staging`; manual and
synthetic labels are preserved. Discovery summary context freezes the configured MVP **admin**
channel, never the feed, with existing sanitization, disabled mentions and runtime footer handling.
The [discovery ledger](data-model-and-outbox.md#discovered_code_events-migration-0006) defines
canonical-source and destination-copy deduplication. HTTP exposes only accepted/duplicate/ignored/
unauthorized/unavailable; the companion reuses its bounded timeout/retry client and fixed-category
logging. No content, code, source IDs, payloads, raw errors or secrets are logged.

### Later Follow activation checklist

This checklist is documentation, not authorization to execute it:

1. Verify and record the exact destination guild/feed, source guild/channel, and follower webhook
   relationship/type, plus bot access and Message Content intent. Inspect a real create envelope
   under separate approval; flags alone are insufficient. Keep the feed separate from registration/admin.
2. Separately approve the exact staging revision, migrations (including unapplied 0005/0006),
   deployment, companion start and controlled announcement publication. A controlled source needs
   its own explicitly approved tuple; never weaken the official-source filter to test it.
3. Keep `ENVIRONMENT=staging`, `PROVIDER_MODE=mock`, production redemption false. Enable discovery
   only in the approved companion/Worker configuration. Publish a fresh synthetic three-line code;
   observe durable acceptance, one operation, duplicate suppression and the admin summary. Real
   WOS code validity is irrelevant to this mock test.
4. Disable `CODE_DISCOVERY_ENABLED` in both processes and stop the companion after the bounded test.
   Roll back to the approved prior Worker revision if needed; do not drop the additive ledger or
   replay/delete accepted work. Disabling intake does not cancel already accepted distributions;
   any pause of existing processing/output requires its own operational decision.

Offline tests supply synthetic identities and fake Discord delivery. No expanded source permissions
are needed for implementation; live identity/access/envelope evidence remains a later gate.

### Task 19 read-only preflight and proposed controlled test — 2026-09-19

The authorized preflight was limited to one selected destination message/channel and exact
follower webhook, if supplied and accessible via documented bot GETs (at most 12 requests, no
history scan, source traversal, webhook enumeration, retry after access/rate-limit errors, or
normal-user session), plus named staging Cloudflare deployment/schema/migration metadata and
bounded aggregates. **No Discord request was made (0/12)**: the selected message link, official
source channel link and exact webhook ID were not supplied, and no existing bot authentication
was available in the task environment or expected local configuration files. No fresh event was
captured and no message was replayed into the Worker. The maintainer's invite link identifies a
server entry point, not the exact source channel or destination message.

| Claim | Evidence class and result |
|---|---|
| Destination feed | Maintainer-supplied ID, held in an ignored local manifest; `wos-code-feed` name, Follow setup and View Channel/Read Message History remain maintainer-reported, not bot-verified. The feed ID differs from the checked-in staging registration and admin IDs. |
| Official source guild/channel, follower webhook/type 2 relationship, selected message and original create envelope | Unknown. No exact message/source/webhook links or bot credentials; no webhook permission test was attempted. If Manage Webhooks is unavailable later, request only sanitized exact-webhook type/source/destination evidence from the maintainer, without changing permission or enumerating webhooks. |
| Application identity, Message Content availability and strict static shape | The checked-in application ID and companion's `GuildMessages`/`MessageContent` intent request are implementation facts, not live application identity, privileged-intent entitlement, or readable message content. No original body or timestamp was available to validate in memory. Historical REST content, if later supplied, can establish only static shape/access, never fresh `MESSAGE_CREATE` delivery or eligibility at a modified time. |
| Staging runtime, schema and work | Independently observed through named-resource authenticated Wrangler reads. Active Worker is the older mock-only, discovery-disabled Task 09 version; journal `0001`–`0004`, pending `0005`/`0006`, and bounded counts are recorded in [configuration](configuration.md#task-19-read-only-staging-preflight--2026-09-19). No database/queue mutation or deploy occurred. |
| Controlled announcement source | Maintainer previously offered to create one; existence and its separate exact guild/channel/follower tuple remain unknown. Do not substitute the official tuple or accept arbitrary webhook messages. |

This evidence does **not** establish compatibility of the real Follow envelope with the strict
`message_type=0`, `reference_type=0`, flags 2/6, exact webhook and source reference, or the
three-line parser. A message read must filter fields in memory without emitting the real code,
body, headers, raw API object/error or credential. Preserve its actual creation time. A mismatch
is a concrete finding to review, not permission to broaden the source filter. The two missing
source links, exact webhook and usable existing bot access are gates to finish Task 19's source
verification; keep issue #33 blocked until they are available.

**Later proposal, not approval or an executable runbook:**

1. Supply one selected official destination message link (or exact destination **and** official
   source channel links if none has arrived), the exact follower webhook ID and a separate
   controlled-source channel/follower tuple if created. Verify the original message's static
   metadata and three-line shape against `shared/discord-follow.ts` in memory, the current bot
   application and Message Content entitlement, exact follower type 2/source relationship, and
   then a separately approved fresh Gateway create envelope. A historical REST message cannot
   be replayed or retimestamped to pass the five-minute freshness gate.
2. Seek specific human approval for a bounded staging-only test of runtime commit
   `f6101f54d04f93e8491f7c26069205b93afa5fc1` (Task 18 merged tree
   `502b9c09fe77b9a8bbc4d8a2a4766bbd7013db11`, subject to a new build/review if main
   changes). Target only the known `wos-rewards-service-staging` Worker, its staging D1,
   registration/code-fanout Queues and redemption DLQ, the staging Discord application, the
   dedicated feed and existing admin-output channel; the exact non-secret resource inventory
   is in [configuration](configuration.md#task-09-staging-deployment-record-non-secret).
   Recheck deployment/bindings, D1 journal/schema, player count, outstanding/held work and
   queue health immediately before approval. A separate cutover approval must specify how to
   quiesce old-runtime ingress/consumers/Cron safely while retaining queued and accepted work;
   no zero-downtime old/new schema overlap has been proven. Apply **only** missing additive
   `0005` then `0006` under separate migration approval, then start the new Worker with discovery
   disabled before enabling either discovery gate. Never resume old runtime against 0005 holds.
   If safe quiescence/cutover cannot be approved, stop without migrating. No production resources
   or provider/game requests.
3. Use `ENVIRONMENT=staging`, `PROVIDER_MODE=mock`,
   `PRODUCTION_REDEMPTION_ENABLED=false`, and the fully verified *controlled* destination
   guild/feed + exact follower webhook + source guild/channel tuple in both Worker and
   companion. `CODE_DISCOVERY_ENABLED=true` is a **separate, explicit deployment/runtime gate
   in each**, not a checked-in default; leave the official tuple disabled while testing a
   separate controlled tuple, or test it in a separately approved isolated configuration.
   Preserve registration/admin routing and delivery. Confirm the selected bot can read the
   feed and the staging admin output remains bounded/sanitized with no unintended mentions.
4. With a fresh baseline snapshot (currently 1 player; maximum 2,000), authorize the maintainer
   to publish **one** synthetic three-line announcement from the controlled channel, never a
   real code. Within the five-minute create-age window, observe one accepted canonical event,
   one code/distribution operation, the frozen `N`-player snapshot, at most `N` mock pairs, and
   a bounded final admin summary with the runtime footer once. Only with separate explicit
   approval, publish/replay at most one duplicate of the same source event within that window;
   verify duplicate-event/source/code classification and zero additional work. Do not edit the
   original, backfill history or retimestamp old events.
5. Bound observation to 15 minutes from publication (the 3,600-second operation deadline is an
   outer failure guard, not an invitation to extend this test). Success requires matching live
   tuple/envelope/content access, one immutable acceptance, expected mock-only fanout and one
   delivered bounded admin summary, with no new Task 13 holds. Abort on source mismatch,
   missing content, unexpected player count, schema/binding mismatch, non-mock mode, backlog,
   access/rate-limit failure, uncertain work, duplicate opening a second operation, or missing
   output by the window. Disable discovery in **both** processes and stop the companion at
   completion or abort; do not cancel accepted work or delete/replay rows.
6. Schema-compatible fallback after 0005/0006 is the **same verified new runtime** with both
   discovery gates off, continuing its guarded consumers/output to completion. Do not roll back
   to the currently deployed old version after 0005: it lacks Task 13 hold guards and is not a
   verified schema-compatible fallback. Any alternate revision, pause of existing processing,
   restore, migration, deployment, companion login, publication or duplicate replay needs its
   own exact approval. Preserve existing accepted work and uncertainty holds.

No part of this proposal activates discovery. Checked-in Worker discovery values remain false;
the provider authorization gates in §§4/5/8 remain unchanged and #20/#21 blocked. #22 remains
open beyond this preflight, and ADR 0001's production topology spike stays deferred.

# Architecture — Data model and transactional outbox

- **Parent:** [architecture.md](../architecture.md) — overview, component map, cross-cutting
  invariants, phased implementation order, and the [traceability map](../architecture.md#traceability-map).
- **Status:** Draft. Identifier rules, the implemented D1 tables, and the committed-intent → Queue bridge.

> Evidence tags carry the same meaning as in the overview: **[fact:<ref>]** (confirmed by an
> official page listed in [architecture.md §25](../architecture.md#25-official-sources)),
> **[inference]** (a design conclusion drawn from those facts), **[assumption]** (needs a spike
> or human decision).

---

## 10. Identifier handling

- **`PLAYER_ID`** is validated on input as `^\d+$`, then **stored and transported only as a
  canonical string**: D1 column type `TEXT`, TypeScript type `string`, JSON string in every
  queue payload and interface. It is **never** parsed to a JavaScript `number` and **never**
  stored in a SQLite `INTEGER` column, because large numeric ids lose precision beyond
  2^53 and integer affinity would normalise away leading zeros **[fact:C9]**.
- **`STATE`** is digit-only input but is likewise kept as `TEXT` / `string`; no arithmetic
  is performed on it. It is carried unchanged into `PlayerRef.state`
  ([§11](redemption-state-machine.md#11-whiteoutprovider-and-giftcodesource-abstractions)).
- **Canonicalisation rule (to finalise in implementation):** trim surrounding whitespace;
  reject empty; preserve the remaining digit string verbatim.
- Every key, foreign key, queue payload field, `operation_items.item_key`, redemption
  `idempotency_key`, and idempotency check in this document uses string identifiers.

---

## 12. D1 data model

> **Implemented.** `migrations/0001_initial_schema.sql` creates the original twelve-table
> baseline below; additive migrations are summarized at the end of this section, including
> Task 09's thirteenth table. The schema is applied inside the Workers runtime and verified by
> `test/migrations.test.ts`; the column lists in this section are the contract that suite
> asserts against, column by column. All identifier columns are `TEXT`
> ([§10](#10-identifier-handling)). Migrations 0001–0004 were applied to the isolated staging D1
> resource under the 2026-09-15 deployment/migration approval; production remains absent — see
> [the repository docs index](../README.md#current-state).

### Implemented schema (migration 0001)

What the migration adds on top of the column lists below.

**Conventions.** Every timestamp is `TEXT` holding ISO-8601 UTC, written by the
application: there are deliberately no SQL timestamp defaults, because
`CURRENT_TIMESTAMP` renders `YYYY-MM-DD HH:MM:SS` and would neither sort nor compare
against ISO-8601. Boolean-like columns are `INTEGER` constrained to `0`/`1`. Counters are
`INTEGER NOT NULL DEFAULT 0` with a non-negative check. There are no triggers, no views, no
`AUTOINCREMENT`. Column order in the migration follows the order of the tables below, so
`PRAGMA table_info` ordering is itself part of the tested contract (130 columns).

**Named checks.** Every `CHECK` is named `ck_<table>_<rule>`, so SQLite reports
`CHECK constraint failed: ck_dod_footer_placement` and a test can assert *which* rule fired.
The constrained rules are: the documented status / type / state enum domains; non-negative
counters; `chunk_index >= 1`, `chunk_total >= 1` and `chunk_index <= chunk_total`;
`has_footer IN (0,1)` **plus** the footer-placement rule
(`has_footer = 1` only when `chunk_index = chunk_total` and `output_type <> 'validation_reply'`,
[§15.4](summary-and-delivery.md#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery));
`length(nonce) BETWEEN 1 AND 25` (Discord's ceiling **[fact:D6]** plus a non-empty floor,
since the nonce is derived deterministically from `delivery_id` and an empty one would
silently disable `enforce_nonce` suppression); and digits-only, non-empty `player_id` and
`state` on `players`. The **T1–T16** transitions of
[§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)
are deliberately **not** encoded: only the flat status domains are constrained, so no
documented intermediate state can be blocked.

**Baseline foreign keys — 16 constraints, 17 `PRAGMA foreign_key_list` rows, no cascades.**
`processed_events → operations`; `redemptions → players, gift_codes`;
`operation_items → operations, players, gift_codes`;
`operation_players_snapshot → operations, players`;
`operation_late_results → operations, players, gift_codes`;
`summary_item_snapshot → operations`; `summary_chunk_layout → operations`;
`discord_output_deliveries → processed_events, operations` (both nullable, so a summary with
no event and a reply with no operation are both valid); and the composite
`outbox_jobs (operation_id, item_key) → operation_items (operation_id, item_key)`, which
emits the seventeenth row and is the strongest guarantee here — an outbox job cannot exist
without the domain row it was committed with ([§14](#14-transactional-outbox)). Every key
uses SQLite's default `ON DELETE NO ACTION ON UPDATE NO ACTION`.

**Write ordering this imposes.** D1 enforces foreign keys by default and `db.batch()`
executes sequentially inside one transaction, so **within a batch, parents must be inserted
before children**: `players` / `gift_codes` → `operations` → `operation_items` →
`outbox_jobs`, and `processed_events` → `discord_output_deliveries`.
`PRAGMA defer_foreign_keys = on` is the in-transaction escape hatch if a future flow needs
another order.

**Indexes — 14, each tied to a documented access pattern.**

| Index | Columns | Serves |
|---|---|---|
| `idx_gift_codes_status_code` | `gift_codes (status, code)` | [§6](discord-ingestion-and-registration.md#6-existing-code-processing-after-registration) snapshot of active codes in a fixed order |
| `idx_processed_events_status_accepted_at` | `processed_events (status, accepted_at)` | sweeper re-drive of events stuck at `accepted_valid` |
| `idx_redemptions_status_invocation_expires_at` | `redemptions (status, invocation_expires_at)` | [§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority) crash-safe re-drive (**T12**); also covers `retry_wait`, whose `invocation_expires_at` is the documented pickup hint |
| `idx_operations_state_deadline_at` | `operations (state, deadline_at)` | [§9](operations-and-reliability.md#9-scheduled-cron-components-and-the-trigger-budget) operation sweeper / force-close |
| `idx_operations_summary_state_updated_at` | `operations (summary_state, updated_at)` | summary builder and output dispatcher picking operations mid-pipeline |
| `idx_operations_trigger` | `operations (trigger_kind, trigger_ref)` | [§16](../architecture.md#16-idempotency) "does an operation already exist for this trigger?"; repair lookup by origin |
| `idx_operation_items_operation_player_code` | `operation_items (operation_id, player_id, code)` | [§15.4](summary-and-delivery.md#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery) paged seal in `(player_id, code)` order — the PK is `(operation_id, item_key)`, a different order |
| `idx_operation_items_operation_status_claim` | `operation_items (operation_id, status, claim_expires_at)` | [§15.1](redemption-state-machine.md#151-operation-item-lease-queue-dedup--accounting) item-lease sweep and [§15.3](summary-and-delivery.md#153-completion-accounting-and-the-source-freeze) completion accounting |
| `idx_operation_items_player_code` | `operation_items (player_id, code)` | [§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority) mirror write from a terminal redemption to the owning item(s) |
| `idx_summary_item_snapshot_sort` | `summary_item_snapshot (operation_id, sort_key)` | layout and render passes reading `ORDER BY sort_key`, resuming after `summary_layout_cursor` |
| `idx_discord_output_deliveries_group_chunk` | `discord_output_deliveries (delivery_group, chunk_index)` | dispatcher sending a group in `chunk_index` order, resuming at the first non-`sent` row |
| `idx_discord_output_deliveries_status_claim` | `discord_output_deliveries (status, claim_expires_at)` | dispatcher claim: `pending`, or `claimed` with an expired lease |
| `idx_outbox_jobs_status_available_at` | `outbox_jobs (status, available_at)` | [§14](#14-transactional-outbox) Cron dispatcher scan |
| `idx_outbox_jobs_operation_item` | `outbox_jobs (operation_id, item_key)` | [§14](#14-transactional-outbox) atomic reopen and the sweeper's reset of stuck `enqueued` rows |

`players`, `operation_players_snapshot`, `operation_late_results` and
`summary_chunk_layout` carry no extra index: every documented read of them is
`WHERE operation_id = ?` (or `player_id` order), which the primary key already serves.
Migration 0004's `manual_code_commands` needs no additional index because every runtime lookup
uses its `event_id` primary key; its optional `operation_id` foreign key is the seventeenth
constraint (eighteenth `PRAGMA foreign_key_list` row across the fully migrated schema).

**Five decisions resolved during implementation.**

1. `summary_chunk_layout.first_sort_key` / `last_sort_key` are **nullable**, with a paired
   "both or neither" check. [§15.5](summary-and-delivery.md#155-zero-result-operations)
   documents a zero-result operation that seals zero snapshot rows and still yields
   `summary_chunk_total = 1`, so that single chunk genuinely has no sort-key bounds.
2. `discord_output_deliveries.content` is **`NOT NULL`**: the stored-text form is the
   documented default, and the `content_hash`-only variant noted below would be a separate
   decision with its own migration.
3. `nonce` is bounded to **1–25** characters, not merely `<= 25`.
4. In migration 0001 there are **no unique constraints or unique indexes other than the
   primary keys**. Migration 0003 later adds one partial unique evidence index,
   `uq_staging_spike_output_event`, so an accepted staging-spike event can retain exactly
   one suppressed output row.
   [§15.4](summary-and-delivery.md#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery)
   specifies *targeted* upserts (`ON CONFLICT (operation_id, player_id, code) DO NOTHING`,
   `ON CONFLICT (delivery_id) DO NOTHING`), and in SQLite a targeted `DO NOTHING` aborts on a
   conflict against any **other** unique index — which would break the crash-resumed seal and
   render passes that deliberately re-insert identical rows. Every uniqueness property that
   might have been added (`idempotency_key`, `job_id`, `(delivery_group, chunk_index)`,
   `outbox_jobs (operation_id, item_key)`) is already functionally determined by a primary
   key, so nothing is lost.
5. `operation_late_results` has **no** foreign key to `redemptions (player_id, code)`. The
   post-seal outbox-dead path records `status = 'retry_exhausted'` with
   `reason_code = 'outbox_dead'`
   ([§22](operations-and-reliability.md#22-failure-modes-and-recovery)) for a unit of work
   that never reached a consumer, so no `redemptions` row need exist.

`processed_events.output_delivery_group` is `NOT NULL`: it is deterministic per event and
must be written for valid events too. `redemptions.updated_at` and
`discord_output_deliveries.created_at` / `updated_at` stay **nullable** because the tables
below mark them `TEXT NULL`.

### `players`

| Column | Type | Notes |
|---|---|---|
| `player_id` | TEXT PK | canonical digit string |
| `state` | TEXT | digit string; from input or `DEFAULT_STATE` |
| `state_updated_at` | TEXT NULL | set when an upsert changes `state`; triggers the guarded redemption reopen ([§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)) |
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

### `manual_code_commands` (migration 0004; staging MVP only)

| Column | Type | Notes |
|---|---|---|
| `event_id` | TEXT PK | Discord message id and durable command-idempotency key; digit string, 1–20 characters |
| `guild_id`, `channel_id`, `author_id` | TEXT | exact accepted Discord scope and human administrator identity; digit strings, 1–20 characters |
| `code` | TEXT | normalized 1–64 character `[A-Za-z0-9_-]` gift code submitted by the companion |
| `status` | TEXT | transient in-batch `pending`, terminal `accepted`, or terminal `duplicate_code` |
| `operation_id` | TEXT NULL FK → `operations.operation_id` | populated only for `accepted`; duplicate codes create no operation |
| `discord_created_at` | TEXT | timestamp supplied from the Discord message |
| `accepted_at` | TEXT | Worker receipt/acceptance timestamp |
| `acceptance_id` | TEXT | fresh batch-generation fence; prevents a duplicate event from borrowing another attempt's writes |

The row is created and terminalized in the same atomic D1 batch that conditionally inserts the
gift code, existing `code_distribution_run`, and immutable player snapshot. Therefore `pending`
is never a committed steady state. A repeated `event_id` cannot authorize any batch member;
a different message for an existing code commits `duplicate_code` without opening work.

### `discovered_code_events` (migration 0006)

One additive table records bounded Follow provenance. `event_id` is the destination message primary
key. `guild_id`, `channel_id`, `webhook_id` and `source_guild_id`, `source_channel_id`,
`source_message_id` retain the accepted transport identity. All IDs have bounded digit checks.
`code` keeps case and the 64-character safe grammar; `expiry_label` is at most 40 characters with
unknown year by contract, not an expiry timestamp. Raw message bodies are not stored.
`discord_created_at` retains the original destination timestamp, `accepted_at` the intake time and
`acceptance_id` a fresh transaction fence. `operation_id` is a nullable FK populated only for accepted
work; `canonical_event_id` is a nullable self-FK populated only for duplicate source copies.

A partial unique index on `(source_guild_id, source_channel_id, source_message_id)` where
`canonical_event_id IS NULL` claims each canonical source exactly once. The insert chooses
`pending` for a new canonical source or `duplicate_source` with its first event reference for a new
destination copy. Both destination events are durably claimed, including copies with changed content.
A copy's code/label records its submitted bounded candidate, not new acceptance; its status and
canonical link identify the unchanged first provenance. A canonical row ends as `accepted` or
`duplicate_code`; `pending` exists only inside the atomic transaction. Terminal rows are immutable
under the update trigger. Replay never replaces first metadata or creates work for a changed code.

The shared distribution batch contains ledger insertion, guarded globally unique `gift_codes`
insertion, operation opening, the at-most-2,000-player snapshot and ledger finalization. D1 batch
atomicity serializes concurrent event/source/code races, including manual commands. Only the new
acceptance fence that owns the first code provenance may open work. A final result read reports
accepted/duplicate-event/duplicate-source/duplicate-code truthfully. Failure rolls back the ledger,
code, operation and snapshot together. No second redemption engine, provider or HTTP Queue send is
introduced. Existing manual/synthetic metadata and Task 13 uncertainty holds remain unchanged.

Tests apply 0006 to populated 0005 with manual provenance and an uncertainty hold, verify constraints
and foreign keys, and prove journal replay is a no-op. Remote migration is not part of this task.

### Community JSON state and observations (migration 0007; disabled)

`community_json_source_state` holds the one exact source ID, the durable next-request time,
60-second claim token/lease, permanent access-denial stop, conditional ETag, last source-claimed
`updatedAt`, and at most one validated pending snapshot. Claim acquisition advances the
1,800-second request gate before HTTP. A changed snapshot is persisted once and reconciled one
code per scheduled invocation; a failed batch leaves it pending for a fenced retry without an
early repeat request. The first successful snapshot inserts baseline observations in one D1
transaction and opens no distribution.

`community_json_code_observations` is keyed by source and normalized code. It preserves first
source timestamps, first local observation, baseline flag, and the original operation reference;
its trigger rejects changes to first provenance. `source_active` and `withdrawn_at` track
this source's current eligibility without deleting the row. New-code observation, global
`gift_codes` claim, distribution operation and frozen player membership commit atomically.
Existing `gift_codes` uniqueness deduplicates Follow/manual/community orderings without
rewriting the first source. Accepted Follow/manual duplicate rows also retain independent
eligibility, including a later sighting of a withdrawn community-first code.

Source withdrawal does not delete code, redemption, item, operation or summary ledgers.
When no other accepted source remains, it disables the community-first global code, ends
unexpanded community fanout, and terminalizes only mutable pending items for that code and
their exact jobs. In-flight, held, terminal and frozen state is untouched. Reappearance
restores source eligibility but does not create a second distribution operation.
`0007` was applied to staging during Task 24's bounded smoke. The source is disabled again;
there are no community observations or operations from that attempt.

### `processed_events` (event-acceptance state machine)

| Column | Type | Notes |
|---|---|---|
| `event_id` | TEXT PK | Discord message id; the atomic marker |
| `kind` | TEXT | `registration` |
| `acceptance_class` | TEXT | migration 0003: `normal` (safe default/backfill) / `staging_spike`; immutable after insertion |
| `status` | TEXT | `accepted_invalid` / `accepted_valid` / `work_committed` / `finalized` |
| `outcome` | TEXT NULL | `invalid` / `valid` |
| `operation_id` | TEXT NULL | set in the same atomic unit for valid acceptance (`work_committed` for the fully expanded Phase 3 registration snapshot) |
| `validation_reason` | TEXT NULL | set in the same atomic unit for normal `accepted_invalid` and terminal `staging_spike` evidence |
| `output_delivery_group` | TEXT | deterministic `evt:<event_id>` for every event; groups `discord_output_deliveries` rows for the validation reply when invalid |
| `received_at`, `accepted_at`, `committed_at`, `finalized_at` | TEXT NULL | lifecycle timestamps |

The row is **only ever inserted in the same `db.batch()`** as the validation-reply delivery
row (invalid) or the registration work + outbox rows (valid). No earlier bare insert
exists. After a failed batch, an existing `processed_events.event_id` identifies a duplicate
delivery; the whole failed batch has rolled back and the event is acknowledged. With no
marker, the failure is rejected, never silently treated as a duplicate. Phase 3 writes
`work_committed` directly for valid registrations because their membership is completely
expanded in that transaction. It never creates an `accepted_valid` registration shell.

An authenticated, allow-listed staging bot/webhook with invalid spike syntax is inserted
directly as `acceptance_class = 'staging_spike'`, `status = 'finalized'`,
`outcome = 'invalid'`, `operation_id = NULL`, `committed_at = NULL`, and
`finalized_at = accepted_at`. It retains `received_at`, `accepted_at`,
`validation_reason`, and `output_delivery_group`. OLD-aware migration-0003 triggers reject
changing or deleting the marker; every pre-0003 row is backfilled/defaulted to `normal`.

### `redemptions` (global provider-call authority)

| Column | Type | Notes |
|---|---|---|
| `player_id` | TEXT | PK part |
| `code` | TEXT | PK part |
| `idempotency_key` | TEXT | deterministic, stable per pair — e.g. `redeem:v1:<player_id>:<code>`; **kept stable across re-evaluations** so a compliant provider still dedupes a genuine prior `success` |
| `status` | TEXT | `pending` / `in_progress` / `retry_wait` / `success` / `already_redeemed` / `permanent_failure` / `retry_exhausted`; transitions only via the state-transition table in [§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority); **`success` / `already_redeemed` never transition** |
| `current_attempt_id` | TEXT NULL | the durable **retry-budget identity** from the queue message body (preserved across `message.retry`); one `attempt_id` may run many sequential invocations |
| `current_invocation_token` | TEXT NULL | the **per-invocation execution claim** minted by the consumer for one delivery; set while an invocation is active, cleared before `message.retry` (T9) and on any terminal; every terminal / `retry_wait` write is guarded on `current_invocation_token = :itok` |
| `invocation_expires_at` | TEXT NULL | lease deadline for the live invocation (`REDEMPTION_CLAIM_LEASE_SECONDS`); in `retry_wait` there is **no** live invocation (`current_invocation_token IS NULL`) and this holds `retry_due_at + REDEMPTION_CLAIM_LEASE_SECONDS` purely as the sweeper's "must be re-picked-up by" hint — the DLQ path (**T10**) does **not** consult it for a `retry_wait` row |
| `retry_due_at` | TEXT NULL | set atomically with `status='retry_wait'` before `message.retry`; a redelivery may acquire a new invocation (T2) only when `now ≥ retry_due_at` |
| `attempt_state` | TEXT NULL | the `PlayerRef.state` the `current_attempt_id` is using; compared against the current `players.state` before a state-dependent terminal (T6/T7/T8) and on reopen |
| `attempt_generation` | INTEGER | audit counter, `+1` only when a **new** `attempt_id` becomes `current_attempt_id`; not a guard |
| `attempts` | INTEGER | provider-call invocations under `current_attempt_id` (`+1` per invocation granted; reset when a new `attempt_id` is granted or on reopen) |
| `reeval_count` | INTEGER | number of guarded state re-evaluations; capped by `REDEMPTION_MAX_REEVAL` |
| `provider_receipt` | TEXT NULL | optional reconciliation reference from a real provider |
| `reason_code` | TEXT NULL | for `permanent_failure` / `retry_exhausted` — incl. `state_reevaluation_limit` (T8); classifies reopen eligibility ([§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)) |
| `first_claimed_at`, `terminal_at`, `updated_at` | TEXT NULL | |

PK `(player_id, code)`. This row — **not** `operation_items` — is the sole authority for
whether `WhiteoutProvider.redeem` may be called for the pair. The `attempt_id` is the retry
budget; the `current_invocation_token` serializes provider calls so **two overlapping
deliveries of the same `attempt_id` cannot both call the provider** during normal lease
operation ([§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)).

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
| `expansion_cursor` | TEXT NULL | distribution runs: last `player_id` expanded, fixed sort order; registration snapshots are inserted completely and leave this NULL |
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
([§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)). It does **not**
authorize a provider call.

### `operation_players_snapshot` (distribution runs only; optional)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `player_id` | TEXT | PK part |

Point-in-time player boundary when a monotonic cursor filter is not used. It is created by
the baseline migration even though it is optional for some distribution implementations, so
the complete documented schema is available.

### `operation_late_results` (audit / history — outcomes observed after freeze)

| Column | Type | Notes |
|---|---|---|
| `operation_id` | TEXT | PK part |
| `player_id`, `code` | TEXT | PK parts |
| `observed_at` | TEXT | PK part |
| `status` | TEXT | the terminal `redemptions` outcome that landed **after** `operations.summary_state` left `none` |
| `reason_code` | TEXT NULL | |

PK `(operation_id, player_id, code, observed_at)`. Once an operation's `summary_state ≠
'none'`, the mirror write ([§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority))
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
([§15.4](summary-and-delivery.md#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery))
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
| `available_at` | TEXT NULL | Phase 4 due time; NULL on staging-spike evidence and never an authority to bypass permanent guards |
| `last_error`, `blocked_at`, `alerted_at` | TEXT NULL | Phase 4 retry/attention state; staging-spike evidence sets only `blocked_at = accepted_at` |
| `dispatch_eligible` | INTEGER | migration 0003 boolean; existing/normal output defaults to 1, spike evidence is 0 |
| `suppression_reason` | TEXT NULL | `staging_spike_sender` only for retained spike evidence |
| `suppressed_at` | TEXT NULL | acceptance timestamp for spike evidence |
| `permanent_dispatch_block` | INTEGER | migration 0003 boolean; existing/normal output defaults to 0, spike evidence is 1 |

All chunks of a logical message are built and persisted **before any are sent**. The
dispatcher sends them in `chunk_index` order and resumes at the first non-`sent` row. Its
selection and claim both require `dispatch_eligible = 1`,
`permanent_dispatch_block = 0`, and NULL suppression metadata.

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

## 14. Transactional outbox

**Decision:** a per-item transactional outbox bridges the gap between a committed D1 intent
and a Queue enqueue. This design is **intended to prevent loss between the committed D1
intent and eventual Queue enqueue, subject to the documented platform guarantees and the
recovery process below** — it is not an absolute "no loss" claim.

**Implemented Phase 3 boundary:** local producers implement `pending → enqueued`,
backed-off `pending`, and terminal `dead` marking. Both recovery paths below, their
alerts, Queue consumers/DLQ, and sweepers are later-phase work. No Phase 3 path leaves
`dead`, calls a provider, or delivers a Discord message.

- **Atomic write:** each page of domain rows is written together with its per-item
  `outbox_jobs` rows in a single `db.batch()` (atomic, all-or-nothing) **[fact:C9]** — the
  same unit as the `processed_events` marker for registration acceptance
  ([§5](discord-ingestion-and-registration.md#atomic-acceptance)). Large fan-out is written a bounded page at a time
  ([§7](discord-ingestion-and-registration.md#7-new-code-fan-out-flow)), never one unbounded batch.
- **Identity:** `job_id` is per unit of work
  (`registration:<operation_id>:<code>` / `distribution:<operation_id>:<player_id>`) and is
  carried in the queue message body alongside `operation_id`, `item_key`, `player_id`,
  `code`. The **consumer** uses it as the application-level dedup key (no producer key
  exists, [fact:C7]).
- **Dispatch:** (a) inline best-effort `queue.sendBatch()` immediately after a page commits,
  marking sent rows `enqueued`; (b) authoritative Cron dispatcher (every minute,
  [fact:C4]) scanning `status='pending' AND available_at <= now`, enqueuing, marking
  `enqueued`, and on failure setting `available_at` with exponential backoff and
  incrementing `attempts`. After `OUTBOX_DISPATCH_MAX_ATTEMPTS` the row is marked `dead`;
  alerting is deferred. Phase 3 routes registration and distribution rows to their
  respective producer bindings but only acceptance creates registration rows.
- **`dead` handling — no ineffective requeue.** A `dead` outbox row means enqueue has not
  been durably confirmed; send/mark ambiguity means the queue may already hold a message.
  The dispatcher resolves it by one of two explicit paths,
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
    ([§15.3](summary-and-delivery.md#153-completion-accounting-and-the-source-freeze)): the dispatcher records the
    outcome in `operation_late_results` (reason `outbox_dead`), raises an alert, and creates
    a `repair_run` operation stub (`type = 'repair_run'`, `trigger_ref` = origin
    `operation_id`) listing the affected `(player_id, code)` pairs. A human triggers the
    repair, which reuses the global `redemptions` records and produces its own summary
    (its own snapshot). A finalized operation and its snapshot are **never** mutated in
    place.
- **Recovery:** on restart the dispatcher simply re-scans `pending`. The operation sweeper
  resets rows stuck in `enqueued` with no downstream progress past a threshold back to
  `pending`. A retention job deletes fully-accounted `enqueued` rows after a fixed period.

### Phase 3 dispatch bounds and concurrency

Both dispatch paths use the same deterministic pack/send/mark implementation. A scheduled
scan reads at most 90 due `pending` rows in `(available_at, job_id)` order. Inline dispatch
reads at most 90 due rows for the new operation with `attempts = 0`; it does not select
rows already backed off by a competing scheduled run. Both paths send at most eight chunks, one
awaited `sendBatch()` at a time. Surplus chunks stay pending without consuming an attempt.

Cloudflare Queues uses decimal bytes: messages are limited to 128,000 bytes and batches
to 100 messages or 256,000 bytes, with up to approximately 100 bytes of internal metadata
per message ([official Queue limits](https://developers.cloudflare.com/queues/platform/limits/)).
The packer charges compact JSON UTF-8 body bytes plus 100 bytes per message and caps each
charged body at 96,000 bytes, each batch at 192,000 bytes and 90 messages. This estimates
the body and reserves envelope headroom; it does not measure the complete platform
envelope. A malformed or wrong-shape payload becomes `dead` / `payload_invalid`; an
oversized payload becomes `dead` / `payload_too_large`. Neither consumes an attempt.
Queue send failures use only `queue_send_failed`, never exception text, with deterministic
backoff `min(60 × 2^(attempts - 1), 3600)` seconds and `dead` at the configured cap.

All sends settle before bulk marking. All marks require `status = 'pending'` and the selected `(job_id, attempt_id)` generation;
retry marks compare the observed attempt count before writing the fixed next count.
Exhausted marks require the cap threshold and preserve any higher counter. A stale
failure cannot regress a newer retry count or backoff, and
no marking resurrects a `dead` or `enqueued` row. With no outbox claim column, overlapping
dispatchers may send duplicates. A crash after send but before mark has the same effect;
consumers absorb these through their item/global-redemption guards.

Marking groups use a closed set of `(status, attempts, last_error)` outcomes, with at most
90 ids per SQL update and at most 100 bound parameters per statement. For `r` rows,
`g = min(group_limit, r)` and `k = 90`, the exact worst-case update count is
`g + floor((r - g) / k)` (zero for zero rows). With a five-attempt cap, scheduled dispatch
has at most eight groups; initial inline dispatch has at most four.

The four platform limits are separate
([D1 limits](https://developers.cloudflare.com/d1/platform/limits/),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)):

| Limit | Phase 3 bound |
|---|---|
| D1 queries: Free-plan floor 50; self-imposed budget 40 | Valid ingestion ≤ 11 statements; invalid acceptance 2; failed valid acceptance ≤ 8; scheduled dispatch ≤ 9 |
| Internal-service subrequests: Free-plan floor 1,000 | Ingestion ≤ 19 and scheduled dispatch ≤ 17, conservatively counting every D1 statement plus Queue call |
| Regular subrequests: Free-plan floor 50 | Exactly 0; implemented ingestion/outbox paths make no `fetch()` calls |
| Simultaneous open connections: 6 | At most 1 Queue send in flight per invocation |

The Free-plan Cron CPU allowance is 10 ms. Sequential I/O wait does not itself consume
CPU time; local tests do not establish production CPU or latency. Measure dispatch with
representative payloads when a stack is first authorized and provisioned.


### Implemented additive Phase 4 migration (0002)

`0001_initial_schema.sql` and root instruction files remain byte-for-byte unchanged.
Migration 0002 adds:

- `operations.summary_context`, `repair_authorized_at`, `frozen_at`, plus frozen distribution
  snapshot names and bounded `summary_item_snapshot.code_label` for rendering.
- Redemption `budget_generation`, `provider_invocations`, captured limit, current terminal
  generation pointer, monotonic observation timestamp, and last-attempt generation fence.
- Immutable `terminal_observations` and per-generation/item `terminal_receipts`, indexed for
  unfinished traversal and missing-receipt lookup.
- `scheduler_progress` for separate round-robin lanes and recovery turns, `dispatch_control`
  for durable output serialization/cooldown, and output due/error/block/attention fields.

Existing audit `attempts` remain unchanged. Migration charges `MIN(attempts,4)` into the
new logical budget, creates observations for existing terminal outcomes, and leaves
invocation ownership unchanged. A recorded migration is not executed twice; reapplication
uses D1's migration journal, not raw repeated `ALTER TABLE` execution. Tests cover a populated
baseline upgrade, unchanged frozen rows, foreign keys, and no fresh retry allowance.

Legacy Phase 3 operations lack destination/header context, especially zero-item runs.
The migration leaves that missing context explicit (`NULL`) instead of inventing historical
labels or channels; they are not rendered until a human supplies verified immutable
context. No real staging database exists, so this affects retained synthetic local data.
Previously frozen snapshots remain untouched. Legacy distribution membership cannot acquire
historical names from today's players; a human must resolve that missing historical context
before using such a pre-Phase-4 synthetic run.

Outbox re-drive rotates a physical attempt and preserves the logical budget. Marks bind
observed job/attempt tuples via bounded `VALUES` rows, so an old send result cannot mark a
reopened attempt. Dead jobs before freeze may reopen atomically; after freeze they produce
a one-pair parked `repair_run` and late audit. `openRepairRun` can create a parked one-pair operation for a human-selected failed redemption; its request ID makes retries idempotent. `authorizeRepair` is an internal human-selected
helper, never a public endpoint or a scheduler action. It creates fresh work only after
explicit authorization and cannot reset a successful redemption.

### Implemented additive Phase 5 safety migration (0003)

`0003_phase5_spike_output_suppression.sql` adds `processed_events.acceptance_class` and the
four output suppression fields described above. Safe defaults preserve every existing row
as `normal`, dispatch eligible, and not permanently blocked; no existing status or timestamp
is rewritten.

Stable D1-compatible triggers enforce insertion of complete staging-spike terminal shapes,
make the marker and its output evidence update/delete-immutable based on `OLD` state, reject
attaching spike-only metadata to a normal row, reject relinking a normal output to a spike
event, and reject a dispatchable output newly associated with a spike event. A simultaneous
UPDATE that clears every suppression field still sees the protected OLD association and
aborts. The partial unique index permits exactly one suppressed evidence output per spike
event. Tests inspect the trigger definitions in `sqlite_schema`, exercise each forbidden
mutation, upgrade representative Phase 4 rows, inject a failing migration statement to
prove atomic DDL/data/ledger rollback, reapply safely through the migration journal, and run
`PRAGMA foreign_key_check`.

### Implemented additive Task 09 staging-MVP migration (0004)

`0004_live_staging_manual_commands.sql` adds only `manual_code_commands`; it does not alter or
rewrite an existing table. The table's named checks constrain Discord identifiers, code syntax,
status, and the status/operation result shape. Its nullable operation foreign key has no cascade.
The focused upgrade test inserts a representative player into a migration-0003 database, applies
0004 through the D1 migration journal, verifies that row is unchanged and the new table has the
exact expected columns, and confirms that invalid code and orphan-operation inserts are rejected
without leaving ledger rows. It also confirms `PRAGMA foreign_key_check` is empty and that
reapplication is a journal no-op. It does not inject a failing 0004 migration, so the separate 0003
atomic migration-rollback test is not evidence for 0004 rollback. These tests use local storage.
The same migration is applied to staging D1; a remote ledger check reported no pending migrations,
and the later narrow staging smoke populated only its expected synthetic player/code path.

### Implemented additive Task 13 uncertainty migration (0005)

`redemptions.dispatch_hold_token`, `dispatch_hold_generation` and `dispatch_hold_at`
record possible dispatch authority before the provider call. They prevent fresh grants,
state reevaluation, budget resets and generic repair. Their values are local evidence,
never provider receipts. The effective uncertain state uses the existing physical
`permanent_failure` status plus reserved `outcome_uncertain` reason across redemptions,
operation items, observations, late audits and summary snapshots. Consumers must interpret
both fields; `permanent_failure` alone is not a truthful failure count.

`operations.uncertain_count` is nullable until sealing and recomputed from the frozen
snapshot. It is separate from definite failures, applied outcomes and unfinished work.
Existing CHECK domains, foreign keys, ledger history and receipts are unchanged.

Upgrade from 0004 retains legacy `in_progress`, `retry_wait`, and charged `pending`
rows with a hold using their existing invocation token (or the literal local marker `legacy-unattributed` if absent), current
budget generation and last update timestamp. It does not assert success, failure, a new
invocation or a receipt, and does not change existing statuses, counters or observations.
This conservative legacy hold is not inferred to be replay-safe from environment mode.
Old retry-wait could originate in the former timeout handler, and charged pending work
could originate in expired-grant recovery; neither proves a safe retry. Other legacy rows
and terminal history remain unchanged, without retrospective outcome reconstruction.
Reapplication through the D1 migration journal is a no-op. The migration is additive; no populated table is rebuilt or dropped.
Apply it before activating the new runtime under a separately authorized deployment gate;
older runtime code must not run against held work because it does not enforce these guards.

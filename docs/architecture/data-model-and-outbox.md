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

> **Implemented.** `migrations/0001_initial_schema.sql` is the baseline migration and
> creates every table below. It is applied inside the Workers runtime and verified by
> `test/migrations.test.ts`; the column lists in this section are the contract that suite
> asserts against, column by column. All identifier columns are `TEXT`
> ([§10](#10-identifier-handling)). No Cloudflare D1 resource has been provisioned and no
> remote migration has been applied — see [the repository docs index](../README.md#current-state).

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

**Foreign keys — 16 constraints, 17 `PRAGMA foreign_key_list` rows, no cascades.**
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

**Five decisions resolved during implementation.**

1. `summary_chunk_layout.first_sort_key` / `last_sort_key` are **nullable**, with a paired
   "both or neither" check. [§15.5](summary-and-delivery.md#155-zero-result-operations)
   documents a zero-result operation that seals zero snapshot rows and still yields
   `summary_chunk_total = 1`, so that single chunk genuinely has no sort-key bounds.
2. `discord_output_deliveries.content` is **`NOT NULL`**: the stored-text form is the
   documented default, and the `content_hash`-only variant noted below would be a separate
   decision with its own migration.
3. `nonce` is bounded to **1–25** characters, not merely `<= 25`.
4. There are **no unique constraints or unique indexes other than the primary keys**.
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

## 14. Transactional outbox

**Decision:** a per-item transactional outbox bridges the gap between a committed D1 intent
and a Queue enqueue. This design is **intended to prevent loss between the committed D1
intent and eventual Queue enqueue, subject to the documented platform guarantees and the
recovery process below** — it is not an absolute "no loss" claim.

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

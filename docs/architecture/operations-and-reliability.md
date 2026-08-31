# Architecture — Operations, observability, testing, and recovery

- **Parent:** [architecture.md](../architecture.md) — overview, component map, cross-cutting
  invariants, phased implementation order, and the [traceability map](../architecture.md#traceability-map).
- **Status:** Draft. Scheduled work, stack separation, logging and alerting, the test matrix, and the failure/scenario catalogues.

> Evidence tags carry the same meaning as in the overview: **[fact:<ref>]** (confirmed by an
> official page listed in [architecture.md §25](../architecture.md#25-official-sources)),
> **[inference]** (a design conclusion drawn from those facts), **[assumption]** (needs a spike
> or human decision).

---

## 9. Scheduled (Cron) components and the trigger budget

Cloudflare allows **5 Cron Triggers per account on Free, 250 on Paid** **[fact:C5]**, and
minimum granularity is one minute **[fact:C4]**. The design keeps the scheduled surface
small and, where practical, multiplexes work into a single `scheduled()` handler that
dispatches by current UTC minute.

| Scheduled job | Cadence | Work |
|---|---|---|
| Outbox dispatcher | every minute | enqueue `pending` `outbox_jobs`; back off; mark `dead`; atomic-reopen pre-summary or flag a repair after finalization ([§14](data-model-and-outbox.md#14-transactional-outbox)) |
| Summary builder | every minute | advance the seal / layout / render cursors (`snapshot_cursor`, `summary_layout_cursor` + `summary_layout_open`, `summary_build_cursor`) for operations that are finalisable or in `summary_state ∈ {sealing, building}` ([§15.4](summary-and-delivery.md#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery)); shares the `scheduled()` handler |
| Output delivery dispatcher | every minute | claim and send `pending` / lease-expired `discord_output_deliveries` chunks in `chunk_index` order; resume at the first unsent chunk |
| Operation sweeper | every minute | force-close operations past `deadline_at` (freeze + seal then); **T12** reset `redemptions` rows with an expired invocation (`in_progress`/`retry_wait` → `pending`); mirror terminal `redemptions` onto waiting `operation_items` (freeze-guarded); re-drive up to `SWEEPER_REDRIVE_BATCH` stuck non-terminal, unclaimed pairs with a fresh `attempt_id`; **T15** `state`-mismatch reopen; optional bounded `retry_exhausted` reopen |
| Retention | hourly | delete fully-accounted `enqueued` outbox rows, `sent` delivery rows, and `summary_chunk_layout` / `summary_item_snapshot` rows for delivered operations past the retention window |
| Code-discovery scheduler | configurable | poll the authorized `GiftCodeSource` when `CODE_DISCOVERY_ENABLED=true`; **no-op until a source is authorized** |

Durable Object **alarms** ([fact:C3]) are an implementation option for per-operation timers
if Option 1 is chosen or if per-operation precision is needed; they do not consume the Cron
Trigger budget.

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
  Markdown checks apply — see [§24](open-decisions-and-risks.md#24-unresolved-decisions-and-risks).)

---

## 22. Failure modes and recovery

| Failure | Effect | Recovery |
|---|---|---|
| `DiscordEventSource` down | Live `MESSAGE_CREATE` events missed while down | Supervised restart; on reconnect, Discord replays only within session/Resume limits [fact:D1]; missed events need bounded REST catch-up or manual re-send ([§24](open-decisions-and-risks.md#24-unresolved-decisions-and-risks)) |
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

## 15.6 Scenario matrix

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

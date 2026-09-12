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

The one-minute handler always reserves each lane independently; a failed lane cannot
spend another lane's reservation. Work is awaited sequentially. Page cursors use durable
round-robin operation ordering, so expansion and summary do not share one slot.

| Lane | D1 statements, including failures | Work per tick |
|---|---|---|
| Expansion | 6 | one operation, up to 128 snapshot members |
| Outbox | 10 | one fair operation, up to 90 rows; at most eight sequential `sendBatch` calls |
| Recovery | 8 | close at most 128 deadlines; run terminal-item reuse every other minute, and rotate observation mirror / one stuck pair / one dead outbox repair through the intervening minutes |
| Summary | 6 | one operation: freeze, seal page, layout page, or render one chunk |
| Output | 9 | one ordered chunk, including claim, cooldown, result and completion recovery; zero requests unless a synthetic transport is injected |
| **Complete scheduled handler** | **39** | at most eight Queue sends and one injected output request; no provider calls |

Queue consumers process at most two messages per invocation, reserving 16 D1 statements
per message (**32 total**), with at most two mock provider invocations. The DLQ reserves
eight per message (**16 total**) and makes no provider call. Excess messages are retried
without accessing D1. Binding count is capped at 100 on every runtime statement, including
batch members; failed attempts consume the same reservation. Sequential awaited I/O keeps
one service connection active at a time in healthy execution. Budgets are application
limits, not claims about production CPU latency or at-most-once external effects.

The outbox read is bounded to 90 rows and 9,000,000 source bytes, allowing one larger
legacy row alone so it can be classified. Existing Queue packing remains 96,000 charged
bytes per message / 192,000 per batch. Seal and terminal pages use at most 128 rows and
262,144 cumulative source bytes, or one larger legacy row alone; row identifiers carry
mutation pages without duplicating large codes into JSON parameters. Seal uses fixed-size
code hashes for sort keys and persists bounded display code labels. Layout reads at most
128 bounded display rows, render at most 256 (minimum line length prevents more from
fitting a 2,000-character chunk); output response reads stop at 16,384 bytes. Expansion
uses 128 bounded registration names and synthetic codes capped at 128 UTF-8 bytes.

At the default 3,600-second deadline a 2,000-player distribution needs **16 expansion
passes**, while outbox dispatch needs 23 passes of 90. The deterministic healthy envelope
is 90 mock redemptions within 45 seconds after each minute's dispatch. An isolated maximum
operation finishes redemption accounting before 24 minutes; two competing maximum
operations each finish before 47 minutes under round-robin scheduling. This is an explicit
mock service envelope, not a guarantee under arbitrary backlog, provider latency or retry
rates. More competition or a deliberately short deadline closes incomplete work truthfully
as `stale_closed`; unexpanded snapshot members appear as unfinished. The deadline covers
redemption accounting, not eventual summary delivery while transport is disabled.

Terminal-result reuse processes 128 items on every other minute. An isolated accepted
registration containing 2,000 pairs whose outcomes are already terminal therefore needs 16
reuse pages and completes its item accounting by minute 31, before the default deadline.
Observation mirroring, stuck-pair redrive and dead-outbox handling each run every sixth
minute in the intervening slots. Their cursors remain independent, so none can consume the
reuse reservation or another recovery class's turn.

Retention, discovery, adaptive provider rate limiting and operational dashboards remain
later work. Required correctness recovery above is implemented now. Operator repairs are
parked and never auto-authorized or selected by a consumer before explicit authorization.

### Local-only Gateway alarm and restart proof

Task 08C uses the one platform alarm per Durable Object as a persisted multiplexer for first and
regular heartbeats, delayed handshakes, reconnect backoff, and the Hello watchdog. Each logical
item has a stable id, generation, logical deadline, wall-clock alarm time, and `pending` or
`claimed` status. The constructor uses `blockConcurrencyWhile` only for the short versioned-state
hydration, checks an existing platform alarm before setting one, and never holds the block across
WebSocket- or D1-style I/O. After due work, the adapter persists and schedules the earliest
remaining item. Late delivery is counted separately; protocol deadlines use their logical time
and never assume exact platform timing.

Cloudflare documents one alarm, at-least-once execution, persistence across restarts, and
constructor-before-alarm ordering **[fact:C3]**. Idempotency and conservative ambiguity handling
are project policy: a due item is durably claimed before its effect; repeated delivery after
completion finds no item, while a claim surviving an indeterminate handler is never re-sent. The
adapter atomically completes that item while advancing the generation, closes any still-known
socket best-effort, and schedules recovery on a replacement lifecycle. The durable session,
checkpoint, retry/IDENTIFY safety state, logical work, metrics, and constructor count survive
local re-instantiation. Cloudflare's local `evictDurableObject(..., { webSockets: "close" })`
also verifies constructor re-entry, retained checkpoint/session, and an unchanged existing alarm.
After local eviction, delivery of an orphaned lifecycle alarm fences that vanished generation and
uses the same persisted scheduler to establish a replacement Resume lifecycle.
This local behavior is not evidence that an outbound Gateway WebSocket remains resident in a
deployed Durable Object; outbound WebSockets do not hibernate and only defer eviction for a
documented bounded interval **[fact:C1][fact:C2]**.

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

### Staging-spike reconciliation, abort, and cleanup invariants

Migration 0003 is still applied locally only in the current repository state. After a
reviewed staging migration and before any future spike traffic, run the following read-only
queries; repeat them during the run, after any abort, at completion, and after cleanup.
Every count must be zero. `?1` in the dispatcher query is the current ISO-8601 timestamp.

```sql
-- Zero spike markers outside their finalized terminal shape.
SELECT COUNT(*) AS unsafe_spike_markers
FROM processed_events
WHERE acceptance_class = 'staging_spike'
  AND NOT (
    status = 'finalized'
    AND outcome = 'invalid'
    AND operation_id IS NULL
    AND validation_reason IS NOT NULL
    AND output_delivery_group <> ''
    AND received_at IS NOT NULL
    AND accepted_at IS NOT NULL
    AND committed_at IS NULL
    AND finalized_at IS accepted_at
  );
```

```sql
-- Zero missing or malformed spike output-evidence rows.
SELECT COUNT(*) AS unsafe_spike_outputs
FROM processed_events e
LEFT JOIN discord_output_deliveries d ON d.event_id = e.event_id
WHERE e.acceptance_class = 'staging_spike'
  AND (
    d.delivery_id IS NULL
    OR NOT (
      d.delivery_group = e.output_delivery_group
      AND d.operation_id IS NULL
      AND d.output_type = 'validation_reply'
      AND d.chunk_index = 1
      AND d.chunk_total = 1
      AND d.content <> ''
      AND d.content_hash <> ''
      AND d.nonce <> ''
      AND d.has_footer = 0
      AND d.status = 'superseded'
      AND d.dispatch_eligible = 0
      AND d.suppression_reason = 'staging_spike_sender'
      AND d.suppressed_at IS e.accepted_at
      AND d.permanent_dispatch_block = 1
      AND d.blocked_at IS e.accepted_at
      AND d.claim_token IS NULL
      AND d.claim_expires_at IS NULL
      AND d.attempts = 0
      AND d.discord_message_id IS NULL
      AND d.sent_at IS NULL
      AND d.available_at IS NULL
      AND d.last_error IS NULL
      AND d.alerted_at IS NULL
      AND d.created_at IS e.accepted_at
      AND d.updated_at IS e.accepted_at
    )
  );
```

```sql
-- Zero spike rows matching the dispatcher's complete selection predicate.
SELECT COUNT(*) AS dispatchable_spike_outputs
FROM discord_output_deliveries d
JOIN processed_events e ON e.event_id = d.event_id
LEFT JOIN operations o ON o.operation_id = d.operation_id
WHERE e.acceptance_class = 'staging_spike'
  AND d.status IN ('pending', 'claimed')
  AND d.blocked_at IS NULL
  AND d.dispatch_eligible = 1
  AND d.permanent_dispatch_block = 0
  AND d.suppression_reason IS NULL
  AND d.suppressed_at IS NULL
  AND COALESCE(d.available_at, d.created_at) <= ?1
  AND (d.status = 'pending' OR d.claim_expires_at < ?1)
  AND (d.operation_id IS NULL OR o.summary_state IN ('built', 'delivering'))
  AND NOT EXISTS (
    SELECT 1
    FROM discord_output_deliveries prior
    WHERE prior.delivery_group = d.delivery_group
      AND prior.chunk_index < d.chunk_index
      AND prior.status <> 'sent'
  );
```

```sql
-- Zero spike outputs with any claim, attempt, Discord id, or sent timestamp.
SELECT COUNT(*) AS delivered_or_attempted_spike_outputs
FROM discord_output_deliveries d
JOIN processed_events e ON e.event_id = d.event_id
WHERE e.acceptance_class = 'staging_spike'
  AND (
    d.claim_token IS NOT NULL
    OR d.claim_expires_at IS NOT NULL
    OR d.attempts <> 0
    OR d.discord_message_id IS NOT NULL
    OR d.sent_at IS NOT NULL
  );
```

For the expected-message ledger, bind every accepted expected event id as a `VALUES` row
(extend the placeholder list without embedding message content). This query must return
zero rows; it proves exactly one marker and one associated output-evidence row per id. Run
the same query after duplicate delivery attempts—the result must remain empty.

```sql
WITH expected(event_id) AS (VALUES (?1), (?2), (?3))
SELECT x.event_id,
       CASE WHEN e.event_id IS NULL THEN 0 ELSE 1 END AS marker_count,
       COUNT(d.delivery_id) AS output_count
FROM expected x
LEFT JOIN processed_events e
  ON e.event_id = x.event_id AND e.acceptance_class = 'staging_spike'
LEFT JOIN discord_output_deliveries d ON d.event_id = e.event_id
GROUP BY x.event_id, e.event_id
HAVING (CASE WHEN e.event_id IS NULL THEN 0 ELSE 1 END) <> 1
    OR COUNT(d.delivery_id) <> 1;
```

Any non-zero safety count or returned ledger row is an immediate abort condition before
deployment, during the eventual spike, after an aborted run, at completion, and after
cleanup. Cleanup may remove only separately authorized temporary spike infrastructure and
configuration; it must retain these database rows. Migration-0003 delete/update triggers
prevent cleanup from removing or re-enabling the evidence. No query above writes data.

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
  lifecycle/constructor, connection-generation, heartbeat/ACK, schedule/late/stale-alarm,
  reconnect / RESUME / IDENTIFY, outbound-gate pressure, checkpoint, acceptance/duplicate,
  and stale-callback counts (ingestion tier). Task 08C exposes only closed categories and
  counts; it excludes message/sender/guild/channel ids, raw payload/content, session material,
  URLs, headers, credentials, exception text, and stack traces.
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
    invalid-input batch commits marker + validation-reply delivery row together; valid
    registration captures complete active-code membership in six statements and writes
    `work_committed` directly. Test immutable membership through code status changes and
    new codes, rollback above the 2,000-code cap (including a colliding operation id),
    and rollback of prior T13/player writes on an unrelated failure. A duplicate rolls
    the whole batch back and is identified structurally by its durable marker;
  - **global redemption serialization:** two operations referencing the same
    `(player_id, code)` result in exactly one provider call; the loser reuses the terminal
    outcome; a terminal `redemptions` row is mirrored onto every waiting `operation_items`
    row (via consumer and via sweeper). A provider-terminal write atomically records its
    observation, accounts for its initiating item, and runs the operation freeze guard;
    crashing immediately after that transaction cannot leave the initiating operation
    unaccounted. A validated physical message whose outbox attempt is superseded before its
    claim transaction cannot mutate the item, acquire an invocation grant, or call the
    provider;
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
    a normal validation reply carries no footer; re-send within the nonce window does not
    duplicate; selection and claim both exclude staging-spike suppression metadata and
    require the eligibility/permanent-block guards; a synthetic transport sends a normal
    row while immutable spike evidence remains untouched;
  - **outbox dispatch (Phase 3):** decimal-byte and message-count packing with metadata
    charged, sequential sends, bounded SQL marking, deterministic retry backoff and
    `dead` marking; malformed/oversized payloads are terminal without consuming attempts;
    stale failure writes cannot regress attempts/backoff. Verify independent D1-query,
    internal-subrequest and in-flight limits, and zero external `fetch()` calls;
  - **outbox `dead` recovery (Phase 4 and later):** atomic reopen (fresh `attempt_id`)
    while `summary_state='none'`; `repair_run` stub once the snapshot is sealed / finalized;
    finalized operation and its snapshot never mutated in place. Phase 3 tests that
    `dead` rows remain untouched, since it implements neither recovery path;
  - **author filtering:** bot-, system-, webhook-, and own-application-authored messages are
    dropped in production by **both** the `DiscordEventSource` and the Worker; in staging the
    source forwards `SPIKE_SENDER_ALLOWLIST` senders and the authenticated Worker re-checks
    the appropriate bot-author or webhook id; humans remain normal even on an id match; with
    the list unset (production config) both filters are strict. Migration/acceptance tests
    prove exact terminal evidence, OLD-aware rejection, atomic rollback, duplicates, and no
    operation/outbox/Queue/provider/Discord/network side effect;
  - **local Durable Object Gateway adapter:** real local namespace/storage/alarm execution,
    true local eviction, short constructor hydration, retained alarm/session/checkpoint and
    constructor evidence; serialized command ordering; one generation-fenced connection;
    stale callbacks; pending/claimed alarm crash recovery; exact READY persistence; target
    acceptance before checkpoint; ignored evidence before checkpoint; non-contiguous and replay
    sequences; lost acceptance/checkpoint acknowledgements; retry and IDENTIFY safety across
    reconstruction; exact staging-spike duplicate evidence; normal-human behavior; closed
    diagnostics and command serialization. The deterministic protocol suites retain the full
    Hello/heartbeat/ACK, outbound-rate, close/Invalid Session, Resume replay, and malformed-input
    matrix. Every transport is fake and unmatched outbound network remains blocked;
  - item-lease concurrency (two workers, one winner; expired-lease steal);
  - zero-result operation finalisation; bounded-expansion resume from cursor.
- **Provider:** `MockWhiteoutProvider` in every automated test and in staging.
- **Runtime:** tests run under a Workers-compatible test runner; integration tests where
  available (local D1, local Queues).
- **Pre-finish gate:** run formatting, type checking, unit tests, and available integration
  tests, including shuffled test order, plus the local Wrangler dry-run build. The
  implemented checks are listed in [the current-state table](../README.md#current-state).
  Local tests and dry runs do not provision resources or validate deployed performance.

---

### Phase 4 requirement-to-test matrix

| Requirement | Deterministic local evidence |
|---|---|
| Atomic logical budget across duplicate physical sends | `phase4.test.ts`: two physical IDs alternate at eligible times; exactly four provider calls, one exhaustion observation; recovery does not replenish; fourth-call success remains immutable |
| Concurrency, retry release, stale writes and DLQ | same suite: latched concurrent invocations, T9/T2 due-time retry, stale invocation result, stale/new attempt DLQ, live invocation and future retry-wait handling |
| T7/T8/T13/T15 and operator reopening | state changes with zero/nonzero caps, baseline T13 tests, T15 after the final grant, missing legacy leases, parked repair authorization; successful outcomes cannot reopen |
| Late terminal-result reuse | completed observation traversal, insertion behind a cursor, state reopening between selection and mutation, frozen-source audit, and no extra successful provider call |
| Accepted maximum snapshot and fairness | `phase4-throughput.test.ts`: 2,000 players, one and two operations, all expansion/accounting before their default deadline under the stated clock/service envelope |
| Snapshot stability and deliberate timeout | `phase4.test.ts`: membership/name changes, rollback at 2,001 players, unexpanded members frozen as unfinished at a short deadline |
| Summary restart / immutable rendering | concurrent passes, crashes before/after a D1 page transaction, Unicode at 500 characters, overflow counts, zero-result registration/distribution, final-only footer |
| Durable output / bounded nonce suppression | synthetic 429/5xx/4xx, shared cooldown, exhausted attempts, crash after response before sent mark, stable nonce inside and outside a synthetic suppression window |
| End-to-end local processing | real local Queue producer binding plus Workers Queue harness, accepted registration → consumer ack → sealed summary → synthetic transport → finalized event; unmatched outbound network is blocked |
| Complete-handler budgets | combined scheduled failure and healthy paths, every throughput Cron and two-message consumer invocation measured, binding cap, original outbox send/mark budget suites retained |
| Review regressions F1–F4 | `phase4-review-regressions.test.ts`: superseded outbox authority at the claim boundary; crash after a terminal commit; 128 older blocked delivery groups ahead of an eligible group; and all 2,000 already-terminal late joiners reconciled before the default deadline with zero provider calls |
| Migration compatibility | unchanged baseline suite on a baseline-only binding; `phase4-upgrade.test.ts` populates 0001 then upgrades and reapplies, preserving audit counts and terminal records; local Wrangler upgrade/reapplication plus FK checks |

## 22. Failure modes and recovery

| Failure | Effect | Recovery |
|---|---|---|
| `DiscordEventSource` down | Live `MESSAGE_CREATE` events missed while down | Supervised restart; on reconnect, Discord replays only within session/Resume limits [fact:D1]; missed events need bounded REST catch-up or manual re-send ([§24](open-decisions-and-risks.md#24-unresolved-decisions-and-risks)) |
| Local Gateway alarm handler becomes indeterminate after claiming work | Repeating a send or reconnect would be unsafe | Persist the claim first; on reconstruction, complete the item and advance the connection generation in one durable state write, never repeat the ambiguous effect, then reconnect on a fenced lifecycle. This is project policy layered over Cloudflare's at-least-once alarm guarantee [fact:C3]. |
| D1 acceptance commits but its adapter completion or later DO checkpoint does not | Durable evidence exists while Resume starts from the previous checkpoint | Acceptance-first ordering leaves the DO checkpoint unchanged; replay re-enters Task 08B idempotency, verifies exact spike evidence when applicable, and only then advances monotonically. No cross-store atomicity is claimed. |
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

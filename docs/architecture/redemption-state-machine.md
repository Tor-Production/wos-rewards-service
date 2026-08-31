# Architecture — Redemption state machine and retries

- **Parent:** [architecture.md](../architecture.md) — overview, component map, cross-cutting
  invariants, phased implementation order, and the [traceability map](../architecture.md#traceability-map).
- **Status:** Draft. The provider abstractions, the Queue/DLQ boundary, and the **T1–T16** transition table that governs every provider call.

> Evidence tags carry the same meaning as in the overview: **[fact:<ref>]** (confirmed by an
> official page listed in [architecture.md §25](../architecture.md#25-official-sources)),
> **[inference]** (a design conclusion drawn from those facts), **[assumption]** (needs a spike
> or human decision).

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
  ([§15.3](summary-and-delivery.md#153-completion-accounting-and-the-source-freeze), [§17](#17-retry-and-permanent-failure-classification)).
- Error mapping is a table owned by the adapter (provider signal → outcome + `reasonCode`);
  see [whiteout-provider-decision.md §6](../whiteout-provider-decision.md#6-provider-rate-limits-and-error-mapping).
- All Whiteout Survival access goes through `WhiteoutProvider`, serialized per
  `(player_id, code)` by the global `redemptions` record. Real redemption stays disabled
  until an authorized provider and its API contract are documented and approved.

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
  `operation_items` row (subject to the [§15.3](summary-and-delivery.md#153-completion-accounting-and-the-source-freeze) freeze guard); the now-terminal `redemptions`
  row is skipped by the sweeper's **T12** guard, so no fresh `attempt_id` or retry budget is
  ever minted for it — reopen is `repair_run` (**T14**) only. **Business-rule (`permanent`)
  failures never enter the DLQ.**
- Discord output delivery does **not** use a queue or DLQ: it is a Cron + inline dispatcher
  over `discord_output_deliveries` rows, with `attempts` and an alert after
  `OUTPUT_DISPATCH_MAX_ATTEMPTS`.

---

## 15.1 Operation-item lease (queue-dedup + accounting)

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

---

## 15.2 Global redemption record — the sole provider-call authority

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

### State-transition table (the single source of truth)

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

### The six required behaviours

| Situation | Path | Result |
|---|---|---|
| **Two concurrent deliveries, same `attempt_id`** | D1 wins T1/T2 (token `X`, `in_progress`). D2 finds a live invocation → **T3**: no provider call, `ack`. | Exactly one provider call. |
| **Legitimate sequential owner retry** | Provider `retryable` → **T9**: release invocation + record `retry_due_at`, *then* `message.retry`. The redelivered body (same `attempt_id`) arrives ≥ `retry_due_at` → **T2** (`attempts+=1`) → calls the provider. | Retry budget stays on `attempt_id`; no premature retry (T3 blocks any early duplicate until `retry_due_at`). |
| **Invocation crash** | `invocation_expires_at` passes with token still set. Next redelivery → **T2** (`in_progress AND invocation_expires_at<:now`). If none arrives, **T12** → `pending` + fresh `attempt_id`. | Re-driven exactly once. |
| **Execution lease expires during a provider call** | D2 steals via **T2** (token `Y`). D1's `redeem` returns; its terminal write is guarded `current_invocation_token=X` → matches nothing → **discarded**; D2's result wins. | During *normal* (non-expired) lease operation T3 prevents any second call. On the abnormal expiry case the production-provider **idempotency key** prevents double-apply; tune `REDEMPTION_CLAIM_LEASE_SECONDS` above the provider timeout. |
| **DLQ message arrives while an invocation is active** | Exact `attempt_id`, `in_progress`, live lease → **T11** `dlq_invocation_active`, audit-only, `ack`; that invocation drives `success` / `permanent` / `retry_wait`, and *its* later DLQ message hits **T10**. If instead the row is `retry_wait` (invocation already released by **T9**), the DLQ message is **T10** `retry_exhausted` immediately — a future `retry_due_at` / pickup-grace does **not** defer it, and **T12** cannot then mint a fresh `attempt_id`. | Terminalizes iff no invocation is active. |
| **Stale attempt after a newer attempt took ownership** | `current_attempt_id = B ≠ A`. A's DLQ message → **T11** `dlq_stale_attempt`. A's late provider result → terminal write guarded `current_attempt_id = A` → discarded. | The newer attempt `B` owns the outcome. |

### Terminal-write guards

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

### Crash-safe re-drive (Operation sweeper)

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
  row for the pair (see [§15.3](summary-and-delivery.md#153-completion-accounting-and-the-source-freeze) for the freeze guard):
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

### Terminality is per `reason_code`

| Outcome / `reason_code` | Terminality | Reopen path |
|---|---|---|
| `success`, `already_redeemed` | **immutable** (T16) | never |
| `permanent_failure` / `player_ineligible` (**state-dependent, under cap**) | terminal until the player's `state` changes | **T7** (before an obsolete-state attempt terminalizes), **T13** (atomic acceptance batch of a re-registration that changes `players.state`), or **T15** (sweeper catch-up); each guarded, `reeval_count += 1`, capped by `REDEMPTION_MAX_REEVAL` |
| `permanent_failure` / **`state_reevaluation_limit`** (state re-evaluation cap reached — **T8**) | **terminal failure** | **`repair_run` only (T14)** — never auto-reopened, never reported as the obsolete `player_ineligible` applying to the current `state`; raises an operator alert |
| `permanent_failure` / `code_invalid`, `code_expired` (**code-dependent**) | terminal | operator `repair_run` only (T14; e.g. after correcting `gift_codes.status`) |
| `permanent_failure` / `provider_bad_request`, `provider_auth_failed` (**operational**) | terminal | operator `repair_run` only (T14), after the operational cause is fixed |
| `retry_exhausted` (**operational**) | terminal for accounting | operator `repair_run` (T14); **or** a bounded sweeper auto-reopen after a cooldown when `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED = true` (capped by `REDEMPTION_MAX_REEVAL`) |

**T13 — state-change reopen** (runs inside the same atomic acceptance `db.batch()` as the
re-registration, [§5](discord-ingestion-and-registration.md#atomic-acceptance)):

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
([whiteout-provider-decision.md §5](../whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider)).

### Crash ambiguity

If a real provider performs the redemption but the Worker crashes before the guarded
terminal write, the invocation lease expires and the redelivered message re-acquires an
invocation for the same `attempt_id` (**T2**), then calls the provider again. This is why a
production `WhiteoutProvider` **must** support a stable redemption idempotency key or an
authorized reconciliation lookup
([whiteout-provider-decision.md §5](../whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider));
without one, production redemption stays blocked. During *normal* (non-expired) lease
operation, T3 guarantees no two invocations of the same `attempt_id` call the provider.

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
| Input validation failure (bad `PLAYER_ID`) | n/a | never reaches a queue; durable validation reply instead ([§5](discord-ingestion-and-registration.md#invalid-message-reply)) | — |
| Owner-path attempt exhausts retries | `retry_exhausted` | message → `redemption-dlq`; the DLQ consumer sets the global row `retry_exhausted` on an exact-`attempt_id` match when **no invocation is active** — a `retry_wait` row always qualifies (T9 released the invocation; the future `retry_due_at` / pickup-grace is not consulted), an `in_progress` row only with its token cleared or lease expired (**T10**); a stale `attempt_id` ⇒ `dlq_stale_attempt`, a live `in_progress` invocation ⇒ `dlq_invocation_active`, both audit-only (**T11**); mirrored items marked `retry_exhausted` | operator `repair_run` (T14); or bounded sweeper reopen when `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED` |
| State re-evaluation cap reached | `permanent` → **`state_reevaluation_limit`** | **T8** terminal `permanent_failure`; clear invocation; **operator alert**; counts as a terminal failure so the operation finishes; rendered truthfully, never as `player_ineligible`-for-current-state | **`repair_run` only (T14)** |

Backoff, `delaySeconds`, and `PROVIDER_MAX_RETRIES` stay within Queue limits **[fact:C8]**.
T3 (contention) never consumes the retry budget ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)).

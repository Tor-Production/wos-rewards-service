# Architecture — Redemption state machine and retries

- **Parent:** [architecture.md](../architecture.md) — overview, component map, cross-cutting
  invariants, phased implementation order, and the [traceability map](../architecture.md#traceability-map).
- **Status:** Draft. The provider abstractions, the Queue/DLQ boundary, and the **T1–T17** transition table that governs every provider call.

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
  | { outcome: 'uncertain'; reasonCode: 'outcome_uncertain' } // application cannot be established
  | { outcome: 'retryable'; reasonCode: string }              // authoritative non-application / proven safe retry
  | { outcome: 'permanent'; reasonCode: string };             // reasonCode classifies terminality/reopen (§15.2):
                                                             //   code-dependent  : code_invalid | code_expired            (repair_run only)
                                                             //   state-dependent : player_ineligible -> T7 re-drive under cap;
                                                             //                     T8 -> reason_code 'state_reevaluation_limit' at the cap (repair_run only)
                                                             //   operational     : provider_bad_request | provider_auth_failed (repair_run only)

interface WhiteoutProvider {
  // Apply ONE gift code to ONE player. `idempotencyKey` is the stable per-(player,code)
  // key from the global redemptions record. It does not prove upstream deduplication.
  // Unknown application must return uncertain; retryable requires evidence of safety.
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
  **invocation** via T2, so DLQ ownership stays attached to that durable `attempt_id`. Each physical message has its own platform retry counter; duplicate producer sends do **not** share it.
- **Contention is never a retry.** A delivery that finds a **live invocation** (any
  `attempt_id`), a `retry_wait` not yet due, a different `attempt_id`, or a terminal row is
  **T3**: it makes no provider call, `ack`s, and writes nothing. The pair is re-driven by
  the Operation sweeper (**T12**) with a **fresh `attempt_id`**. A **T3** message can never
  reach the DLQ.
- **DLQ:** `redemption-dlq` receives a message after one physical message exhausts `max_retries` **[fact:C6]**. The inspection consumer terminalizes on an **exact
  `attempt_id` match with no invocation active** (**T10**). A `retry_wait` row always
  qualifies: **T9** already cleared `current_invocation_token`, so its platform retry path is exhausted and the future `retry_due_at` / pickup-grace `invocation_expires_at` are
  irrelevant once the DLQ message itself has arrived. The lease-expiry comparison applies
  only to an `in_progress` row that still carries a `current_invocation_token`:
  ```sql
  UPDATE redemptions
     SET status = CASE WHEN dispatch_hold_token IS NOT NULL THEN 'permanent_failure' ELSE 'retry_exhausted' END,
         reason_code = CASE WHEN dispatch_hold_token IS NOT NULL THEN 'outcome_uncertain' ELSE 'provider_retry_exhausted' END,
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
- Discord output delivery does **not** use a queue or DLQ: it is a Cron dispatcher
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
  the next invocation of a due `retry_wait`, or resumes an unmodified mock invocation of the same
  `attempt_id` after process loss):
  The consumer first inserts a missing `pending` row and claims the eligible operation
  item in the same D1 batch. The authoritative update then includes all of:
  ```sql
  UPDATE redemptions AS r
     SET status='in_progress', current_attempt_id=:aid,
         current_invocation_token=:token, invocation_expires_at=:expiry,
         provider_invocations=provider_invocations+1,
         dispatch_hold_token=CASE WHEN :safe_mock THEN NULL ELSE :token END,
         dispatch_hold_generation=CASE WHEN :safe_mock THEN NULL ELSE budget_generation END,
         dispatch_hold_at=CASE WHEN :safe_mock THEN NULL ELSE :now END
   WHERE player_id=:pid AND code=:code
     AND dispatch_hold_token IS NULL
     AND provider_invocations<provider_invocation_limit
     AND (
       (status='pending' AND (last_attempt_id IS NULL OR last_attempt_id<>:aid
                             OR last_attempt_budget_generation=budget_generation))
       OR (status='retry_wait' AND current_attempt_id=:aid
           AND current_invocation_token IS NULL AND retry_due_at<=:now)
       OR (status='in_progress' AND current_attempt_id=:aid AND invocation_expires_at<:now)
     )
     AND EXISTS (/* matching mutable operation item, eligible lease, deadline > :now */)
  RETURNING attempt_state, provider_invocations, provider_invocation_limit;
  ```
  This is a guard illustration; `src/redemption/consumer.ts` also atomically captures
  player state, lease and audit fields. Only the returned row authorizes a provider call.
  A zero-row result is T3 unless it independently meets the exhausted-budget guard, in
  which case T12b records exhaustion without calling the provider.

### Durable uncertainty hold (Task 13)

Migration 0005 adds `dispatch_hold_token`, `dispatch_hold_generation` and
`dispatch_hold_at` to the authoritative pair row. T1/T2 atomically write this evidence
with the invocation grant **before** calling the provider. Every new grant and every
reset/reopen requires no hold. The token identifies a possible dispatch, not an upstream
receipt. Existing attempt identity, budget generation and charged invocation count retain
its context. A crash between the grant and transmission is conservatively ambiguous.

Only the exact unmodified `MockWhiteoutProvider.redeem` implementation is exempt from
pre-dispatch holds: it is network-free and has no external reward side effects, including
across instances. `isReplaySafeMock` checks the actual implementation, not `providerMode`;
subclasses and replaced methods are conservative. Explicit `retryable` results from any
provider release the hold under the exact invocation/generation guard and retain the
existing bounded retry budget. A provider must establish non-application or safe replay
before returning that result; HTTP errors alone cannot do so.

Timeouts, thrown exceptions and explicit `uncertain` results finalize local accounting as
physical `permanent_failure` with reserved `reason_code='outcome_uncertain'`, retaining
the hold. This is an **effective uncertain state**, not a definitive failure. The same
physical encoding is used in items, observations, late audits and frozen snapshots to
preserve the existing SQLite CHECK constraints. Summary accounting treats it separately.
No upstream receipt is fabricated. The result/observation/item transaction commits before
ack; if it fails, the grant's hold remains durable. Redelivery can recover persistence but
cannot obtain a new grant.

Expired held invocations take **T17**, regardless of remaining budget: Queue redelivery,
DLQ or the sweeper records uncertainty without a provider call or outbox reset. Sweeper
selection includes held grants whose originating operation has already frozen/expired,
then existing observation reuse writes late audits. Active or finalized holds suppress
ordinary recovery and generic repair, including previously parked repairs. New registration
and distribution items can reuse the uncertainty observation; they cannot reopen the pair.
Held work does not loop through enqueue/retry cycles, and other pairs retain fair service.

**Late-result policy:** an exact attempt, invocation token and captured budget generation
may save a conclusive result while the physical row is still `in_progress`, even after its
lease expires, provided timeout/recovery has not finalized uncertainty. This clears the
provisional hold, preserves any real receipt, and uses the existing freeze/audit rules.
Once uncertainty is finalized, late promise results are ignored; there is no background
persistence callback or automatic hold resolution. The original request may still finish.
Stale tokens/generations and immutable success rows cannot be overwritten. Cancellation
or any local write cannot undo an applied game reward.

No hold-clearing command/API, lookup, or replay override exists. A later separately
authorized reconciliation workflow must establish authoritative pair-specific evidence,
fence the exact held invocation/generation, preserve prior observations and frozen outputs,
and prove safety before permitting any new submission. Generic T14 repair is insufficient.

### State-transition table (the single source of truth)

Every SQL guard, Queue-message field, DLQ rule, sweeper rule, scenario, and test below
conforms to this table. `A` = the caller's `attempt_id`; `X` = its fresh
`current_invocation_token`; all rows require `PK = (:pid, :code)`.
T1/T2 and T12–T15 require `dispatch_hold_token IS NULL`. T4–T9 require the
captured `budget_generation` as well as attempt/token identity. A held expired invocation
takes T17 instead of T2/T10/T12, and a handled uncertain result takes T17 directly.

| # | From (`status`, invocation) | Trigger | Guard | To | Effect |
|---|---|---|---|---|---|
| T1 | `pending` | delivery for `A` | `status='pending'` and logical budget remains; message matches current outbox generation | `in_progress` | `current_attempt_id=A` (`attempt_generation+=1` if `A` is new), `current_invocation_token=X`, `invocation_expires_at`, `attempt_state`, `attempts=1`, `retry_due_at=NULL`; atomically increment `provider_invocations` |
| T2 | `retry_wait` (`A`, due, no live invocation) **or** `in_progress` (`A`, invocation crashed) | redelivery of `A`'s body | `(status='retry_wait' AND current_attempt_id=A AND retry_due_at<=:now AND current_invocation_token IS NULL)` **or** `(status='in_progress' AND current_attempt_id=A AND invocation_expires_at<:now)` | `in_progress` | new `current_invocation_token=X`, `invocation_expires_at`, `attempts+=1`; require `provider_invocations < provider_invocation_limit` and increment it atomically |
| T3 | any: **live invocation present** (any `attempt_id`), **or** `retry_wait` not yet due, **or** different `attempt_id`, **or** terminal | any delivery | none of T1/T2 match | *(unchanged)* | delivery makes **no provider call**, no writes, `message.ack()`s — **contention / duplicate suppression** |
| T4 | `in_progress` (`A`, `X`) | provider `success` / `already_redeemed` | `status='in_progress' AND current_attempt_id=A AND current_invocation_token=X` | `success` / `already_redeemed` | clear `current_attempt_id`, `current_invocation_token`, `invocation_expires_at`; `terminal_at` |
| T5 | `in_progress` (`A`, `X`) | provider `permanent`, reason ∈ {`code_invalid`,`code_expired`,`provider_bad_request`,`provider_auth_failed`} | `… AND current_invocation_token=X` | `permanent_failure` | clear attempt + invocation; `reason_code`; `terminal_at` |
| T6 | `in_progress` (`A`, `X`) | provider `permanent` = `player_ineligible`, **`attempt_state = players.state`** | `… AND current_invocation_token=X AND attempt_state=(SELECT state FROM players WHERE player_id=:pid)` | `permanent_failure` (`player_ineligible`) | clear attempt + invocation; `terminal_at` |
| T7 | `in_progress` (`A`, `X`) | provider `permanent` = `player_ineligible`, **`attempt_state ≠ players.state`**, **`reeval_count < REDEMPTION_MAX_REEVAL`** | `… AND current_invocation_token=X AND attempt_state<>(…) AND reeval_count<:max` | `pending` | clear attempt + invocation; `attempt_generation+=1`; `reeval_count+=1`; `reason_code=NULL`; `attempts=0`; increment `budget_generation`, reset `provider_invocations=0`, capture the configured limit, clear current terminal pointer |
| T8 | `in_progress` (`A`, `X`) | provider `permanent` = `player_ineligible`, **`attempt_state ≠ players.state`**, **`reeval_count ≥ REDEMPTION_MAX_REEVAL`** | `… AND current_invocation_token=X AND attempt_state<>(…) AND reeval_count>=:max` | **`permanent_failure`** | clear attempt + invocation; **`reason_code='state_reevaluation_limit'`**; `terminal_at`; **operator alert**; counts as a **terminal failure**; reopen **only** via `repair_run` (T14); the obsolete `player_ineligible` result is **never** reported as applying to the current `state` |
| T9a | `in_progress` (`A`, `X`) | provider `retryable`, budget remains | `… AND current_invocation_token=X` | **`retry_wait`** | **atomically** `current_invocation_token=NULL`, `retry_due_at=:now+backoff`, `invocation_expires_at=:retry_due_at + REDEMPTION_CLAIM_LEASE_SECONDS`; `attempts` unchanged. **Then** `message.retry({ delaySeconds = backoff })` |
| T9b | `in_progress` (`A`, `X`) | final granted invocation returns `retryable` | exact invocation token; `provider_invocations = provider_invocation_limit` | `retry_exhausted` | clear attempt/invocation, publish one terminal observation and account exhaustion; `ack`; a DLQ message is not required |
| T10 | `retry_wait` (`A`) — always; **or** `in_progress` (`A`) with no live invocation | **DLQ message whose `attempt_id` = `A`** | `current_attempt_id=A AND ((status='retry_wait' AND current_invocation_token IS NULL) OR (status='in_progress' AND (current_invocation_token IS NULL OR invocation_expires_at<:now)))` | `retry_exhausted` | clear attempt + invocation; `reason_code='provider_retry_exhausted'`; `terminal_at`. `retry_wait` qualifies **regardless of `retry_due_at` / pickup-grace `invocation_expires_at`** (T9 already released the invocation) |
| T11 | different attempt, **or** exact `A` with a live invocation | **DLQ message whose `attempt_id` = `A`** | `current_attempt_id IS NULL OR current_attempt_id<>A` (⇒ `dlq_stale_attempt`, **even if that newer lease has since expired**) — **or** — `current_attempt_id=A AND status='in_progress' AND current_invocation_token IS NOT NULL AND invocation_expires_at>=:now` (⇒ `dlq_invocation_active`) | *(unchanged)* | audit-only; **never terminalizes**; `message.ack()`s. A live invocation drives the outcome; when it later exhausts, *its* DLQ message hits **T10** |
| T12a | `in_progress` / `retry_wait` (`A`), no live invocation, stuck | Operation sweeper | `status IN ('in_progress','retry_wait') AND (invocation_expires_at IS NULL OR invocation_expires_at<:now)` | `pending` (only while logical budget remains) | preserve `budget_generation`, `provider_invocations`, and its limit; clear attempt + invocation; sweeper re-enqueues a **fresh `attempt_id`**. The `status IN ('in_progress','retry_wait')` guard **excludes every terminal status**, so once **T10** has set `retry_exhausted` the sweeper never re-drives the row or mints a new retry budget — reopen is `repair_run` (T14) only |
| T12b | eligible expired `in_progress` / `retry_wait`, or pending recovery | final grant was charged and no live invocation remains | same authority guard; `provider_invocations >= provider_invocation_limit` | `retry_exhausted` | publish exhaustion observation without provider call, fresh attempt, or fresh budget |
| T13 | `permanent_failure`/`player_ineligible` | valid re-registration changes `players.state` | atomic acceptance batch, `attempt_state<>:new_state AND reeval_count<:max` | `pending` | `attempt_generation+=1`; `reeval_count+=1`; `reason_code=NULL`; `terminal_at=NULL`; `attempts=0`; increment `budget_generation`, reset `provider_invocations=0`, capture the configured limit, clear current terminal pointer |
| T14 | `permanent_failure` (**any** reason, incl. `state_reevaluation_limit`) / `retry_exhausted` | operator `repair_run` | — | `pending` | `attempt_generation+=1`; operator may reset `reeval_count`; increment `budget_generation`, reset `provider_invocations=0`, capture the configured limit, clear current terminal pointer |
| T15 | `permanent_failure`/`player_ineligible` (already terminal, predates T7) | Operation sweeper, `attempt_state<>players.state AND reeval_count<:max AND` a non-terminal `operation_items` waits | sweeper | `pending` | as T13; increment `budget_generation`, reset `provider_invocations=0`, capture the configured limit, clear current terminal pointer |
| T16 | `success` / `already_redeemed` | anything | — | *(immutable)* | — |
| T17 | `in_progress` with held dispatch, or an explicit uncertain result | timeout, exception, uncertain result, expired held grant | exact token/generation for consumer result; expired held row for recovery; exact attempt for DLQ | effective `uncertain` (`permanent_failure` / `outcome_uncertain`) | preserve hold and budget, publish observation, close local accounting, no replay or repair reset |

### Logical invocation authority and terminal reconciliation (Phase 4)

A generation has a default limit of **four grants including the initial call**. T1/T2
atomically test `provider_invocations < provider_invocation_limit` and increment the
counter in the same guarded D1 update that returns the invocation token. Only a returned
grant permits a provider call. A grant lost to a crash is never refunded. The counter is
independent of physical message retries and of `attempts`, which remains attempt audit.
T3 produces no mutations or provider calls; eligible exhaustion is instead T9b/T12b.
T10 may exhaust earlier when one matching physical message reaches the DLQ; T11 is audit
only. T12a rotates `attempt_id` without replenishment. Only capped state reevaluations
T7/T13/T15 and explicitly authorized T14 create a new generation. Successful rows remain
immutable; retry-exhausted and state-cap failures require T14. T9 and T12 in older prose
refer to their explicitly split a/b transitions above.

Each terminal write atomically creates an immutable observation identified by
`(player_id, code, budget_generation)`. `current_terminal_generation` identifies the
applicable observation. The observation carries outcome, reason, attempted state and a
monotonic observation timestamp. The provider-result transaction also accounts for the
initiating item and runs its operation freeze guard, so a crash after the terminal commit
cannot strand that item. A guarded page applies at most 128 additional recipients and
writes per-item receipts in the same transaction; frozen or expired operations receive an
idempotent late-result audit instead. A reopening invalidates the old pointer immediately.
`player_ineligible` also requires that the attempted state still matches the current
player state. Returning to an older state never revives an older generation.

`mirror_cursor` / `mirror_complete` describe one traversal, **not a subscription**. The
independent item-driven reuse lane finds missing receipts even after mirroring completed,
and finds items inserted behind a live cursor. Both lanes revalidate applicability inside
the mutation transaction. A zero-row traversal marks complete; hitting a row/byte page
boundary merely advances the cursor. Obsolete observations remain historical and cannot
complete current items. Receipts record `applied` or `audited`; `superseded` is reserved for
future retention auditing and is not needed to reuse a current result.

### The six required behaviours

| Situation | Path | Result |
|---|---|---|
| **Two concurrent deliveries, same `attempt_id`** | D1 wins T1/T2 (token `X`, `in_progress`). D2 finds a live invocation → **T3**: no provider call, `ack`. | Exactly one provider call. |
| **Legitimate sequential owner retry** | Provider `retryable` → **T9**: release invocation + record `retry_due_at`, *then* `message.retry`. The redelivered body (same `attempt_id`) arrives ≥ `retry_due_at` → **T2** (`attempts+=1`) → calls the provider. | Retry budget stays on `attempt_id`; no premature retry (T3 blocks any early duplicate until `retry_due_at`). |
| **Invocation crash (unmodified mock only)** | `invocation_expires_at` passes with token still set. Next redelivery → **T2** (`in_progress AND invocation_expires_at<:now`). If none arrives, **T12** → `pending` + fresh `attempt_id`. | Re-driven exactly once. |
| **Execution lease expires during a potentially applying call** | The dispatch hold denies T2; T17 records uncertainty. A late exact result may settle only before that finalization. | No second unsafe provider call; stale results are discarded. |
| **DLQ message arrives while an invocation is active** | Exact `attempt_id`, `in_progress`, live lease → **T11** `dlq_invocation_active`, audit-only, `ack`; that invocation drives `success` / `permanent` / `retry_wait`, and *its* later DLQ message hits **T10**. If instead the row is `retry_wait` (invocation already released by **T9**), the DLQ message is **T10** `retry_exhausted` immediately — a future `retry_due_at` / pickup-grace does **not** defer it, and **T12** cannot then mint a fresh `attempt_id`. | Terminalizes iff no invocation is active. |
| **Stale attempt after a newer attempt took ownership** | `current_attempt_id = B ≠ A`. A's DLQ message → **T11** `dlq_stale_attempt`. A's late provider result → terminal write guarded `current_attempt_id = A` → discarded. | The newer attempt `B` owns the outcome. |

### Terminal-write guards

Every terminal (or `retry_wait`) write from a **consumer** (T4–T9) carries
`WHERE status = 'in_progress' AND current_attempt_id = :aid AND current_invocation_token =
:itok AND budget_generation = :captured_generation` (T6/T7/T8 add the `attempt_state` vs `players.state` comparison). The **DLQ**
terminal write (T10) carries `WHERE current_attempt_id = :msg_attempt_id AND ((status =
'retry_wait' AND current_invocation_token IS NULL) OR (status = 'in_progress' AND
(current_invocation_token IS NULL OR invocation_expires_at < :now)))` — an exact
`attempt_id` match **and** no invocation active. A `retry_wait` row always satisfies this
(its invocation was released by T9, so the pickup-grace `invocation_expires_at` is not
consulted); the lease-expiry comparison applies only to an `in_progress` row still holding a
`current_invocation_token`. Held expiry records T17 uncertainty. Unheld sweeper T12a
returns to `pending`; T12b records safe exhaustion. Its `status IN ('in_progress','retry_wait')` guard skips the
`retry_exhausted` row T10 produced.

The T1/T2 claim transaction also revalidates that the message's exact `job_id`,
`attempt_id`, operation, item and route still identify the current outbox row. Validation
before the transaction is only structural. If T12 supersedes that attempt between
validation and claim, all claim statements affect zero rows and T3 acknowledges the stale
physical message without a mutation or provider call.

### Crash-safe re-drive (Operation sweeper)

The recovery reservation runs terminal-item reuse every other minute. Observation mirror,
stuck-pair redrive and dead-outbox handling rotate through the intervening minutes, so each
of those classes runs every sixth minute. The stuck-pair class processes one pair per turn:

- **T17:** finalizes expired held grants as uncertainty, including after operation freeze;
- **T12:** resets unheld `redemptions` rows in `in_progress` / `retry_wait` whose
  `invocation_expires_at` has passed (crashed invocation, or a `retry_wait` whose retried
  message never arrived **and produced no DLQ message** — a DLQ message would have hit
  **T10** first and moved the row to the terminal `retry_exhausted`, which this guard's
  `status IN ('in_progress','retry_wait')` filter skips) to `pending`
  (`current_attempt_id = NULL`, `current_invocation_token = NULL`);
- re-enqueues **one fresh job per pair** — **fresh `attempt_id`**, fresh physical-message retry counters but the same logical budget — for
  every pair with a non-terminal `operation_items` row and a non-terminal `redemptions` row
  that now has `current_attempt_id IS NULL`;
- **T15:** reopens an already-terminal `permanent_failure`/`player_ineligible` row whose
  `attempt_state <> players.state` and `reeval_count < REDEMPTION_MAX_REEVAL` while a
  non-terminal `operation_items` waits (catch-up for rows that turned terminal before T7);
- the separate observation and item-reuse classes mirror applicable current terminal
  observations in bounded pages, using generation/state checks and receipts inside the
  same D1 transaction. Frozen/expired recipients receive late audits instead.

These classes cover T3 acknowledgements, invocation crashes, obsolete-state terminals,
and lost messages without replenishing an exhausted budget. Complete scheduling and
fairness bounds are specified in [§9](operations-and-reliability.md#9-scheduled-cron-components-and-the-trigger-budget).

### Terminality is per `reason_code`

| Outcome / `reason_code` | Terminality | Reopen path |
|---|---|---|
| `success`, `already_redeemed` | **immutable** (T16) | never |
| `permanent_failure` / `player_ineligible` (**state-dependent, under cap**) | terminal until the player's `state` changes | **T7** (before an obsolete-state attempt terminalizes), **T13** (atomic acceptance batch of a re-registration that changes `players.state`), or **T15** (sweeper catch-up); each guarded, `reeval_count += 1`, capped by `REDEMPTION_MAX_REEVAL` |
| `permanent_failure` / **`state_reevaluation_limit`** (state re-evaluation cap reached — **T8**) | **terminal failure** | **`repair_run` only (T14)** — never auto-reopened, never reported as the obsolete `player_ineligible` applying to the current `state`; raises an operator alert |
| `permanent_failure` / `code_invalid`, `code_expired` (**code-dependent**) | terminal | operator `repair_run` only (T14; e.g. after correcting `gift_codes.status`) |
| `permanent_failure` / `provider_bad_request`, `provider_auth_failed` (**operational**) | terminal | operator `repair_run` only (T14), after the operational cause is fixed |
| `permanent_failure` / `outcome_uncertain` (effective uncertain) | verification required; separate from failure/applied counts | no runtime reopening; separately authorized future reconciliation only |
| `retry_exhausted` (**operational**) | terminal for accounting | operator `repair_run` (T14) only |

**T13 — state-change reopen** (runs inside the same atomic acceptance `db.batch()` as the
re-registration, [§5](discord-ingestion-and-registration.md#atomic-acceptance)):

```sql
UPDATE redemptions
   SET status = 'pending', current_attempt_id = NULL, current_invocation_token = NULL,
       invocation_expires_at = NULL, retry_due_at = NULL,
       reason_code = NULL, terminal_at = NULL,
       attempts = 0, attempt_generation = attempt_generation + 1,
       reeval_count = reeval_count + 1, updated_at = :now,
       budget_generation=budget_generation+1, provider_invocations=0,
       provider_invocation_limit=:configured_limit, current_terminal_generation=NULL
 WHERE player_id = :pid
   AND dispatch_hold_token IS NULL
   AND status = 'permanent_failure'
   AND reason_code = 'player_ineligible'               -- state-dependent, under cap only
   AND reeval_count < :max_reeval
   AND (attempt_state IS NULL OR attempt_state <> :new_state)
   AND EXISTS (SELECT 1 FROM players p WHERE p.player_id=:pid AND p.state<>:new_state);
```

It never matches `success` / `already_redeemed` / `state_reevaluation_limit` /
code-dependent / operational rows. The new registration operation's own `operation_items`
for the pair then drive a fresh invocation (fresh `attempt_id`) with the new `state`.
Already-`summarized` operations and their sealed `summary_item_snapshot` are **not**
retroactively changed. `MockWhiteoutProvider` is idempotent by construction; a compliant
production provider is required to be, or acceptance fails
([whiteout-provider-decision.md §5](../whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider)).

### Crash ambiguity

A possibly applied request whose response is lost remains held. Lease expiry never proves
non-application and does not permit another submission. The additive dispatch evidence
covers process loss before and after transmission; only the network-free mock exemption
may replay after process loss. The hold provides local containment, not upstream outcome
evidence. Production activation and authorized reconciliation contracts remain blocked by
[the provider decision](../whiteout-provider-decision.md#5-acceptance-criteria-for-a-production-provider).

---

## 17. Retry and permanent-failure classification

| Provider / transport signal | Class (`reason_code`) | Action | Reopen |
|---|---|---|---|
| Contract-confirmed non-applied HTTP 429, `Retry-After` present | `retryable` | **T9**: atomically → `retry_wait` (clear invocation, set `retry_due_at` from `Retry-After` / backoff), **then** `message.retry` | — |
| HTTP 5xx, connection reset, timeout, exception or lost response without conclusive evidence | `uncertain` (`outcome_uncertain`) | T17 durable hold; verification needed | no runtime replay |
| Provider contract establishes safely retryable "rate limited" / "temporarily unavailable" | `retryable` | **T9** with backoff | — |
| Redemption succeeded now | `success` | **T4** terminal, guarded on `current_invocation_token`; record `provider_receipt` if returned | **never** (T16) |
| Redemption already applied for this pair | `already_redeemed` | **T4** **terminal, success-equivalent**; no retry; counts toward `applied`; never a failure | **never** (T16) |
| Invalid / expired / disabled code | `permanent` (`code_invalid` / `code_expired`) | **T5** terminal `permanent_failure`, no retry, **never DLQ** | operator `repair_run` (T14) only |
| Player ineligible / unknown to the game | `permanent` (`player_ineligible`) — **state-dependent** | **T6** if `attempt_state = players.state`; **T7** (row → `pending`) if `attempt_state ≠ players.state` and `reeval_count < REDEMPTION_MAX_REEVAL`; **T8** (`permanent_failure` / `state_reevaluation_limit`, alert) if the cap is reached — a stale in-flight attempt never terminalizes as `player_ineligible`-for-current-state | T7 / T13 / T15 while under cap; then **`repair_run` only (T14)** — incl. `state_reevaluation_limit` |
| Bad request / auth failure | `permanent` (`provider_bad_request` / `provider_auth_failed`) — operational | **T5** terminal `permanent_failure` | operator `repair_run` (T14) only, after the cause is fixed |
| Input validation failure (bad `PLAYER_ID`) | n/a | never reaches a queue; durable validation reply instead ([§5](discord-ingestion-and-registration.md#invalid-message-reply)) | — |
| Owner-path attempt exhausts retries | `retry_exhausted` | message → `redemption-dlq`; the DLQ consumer sets the global row `retry_exhausted` on an exact-`attempt_id` match when **no invocation is active** — a `retry_wait` row always qualifies (T9 released the invocation; the future `retry_due_at` / pickup-grace is not consulted), an `in_progress` row only with its token cleared or lease expired (**T10**); a stale `attempt_id` ⇒ `dlq_stale_attempt`, a live `in_progress` invocation ⇒ `dlq_invocation_active`, both audit-only (**T11**); mirrored items marked `retry_exhausted` | operator `repair_run` (T14) only |
| State re-evaluation cap reached | `permanent` → **`state_reevaluation_limit`** | **T8** terminal `permanent_failure`; clear invocation; **operator alert**; counts as a terminal failure so the operation finishes; rendered truthfully, never as `player_ineligible`-for-current-state | **`repair_run` only (T14)** |

Backoff, `delaySeconds`, and `PROVIDER_MAX_RETRIES` stay within Queue limits **[fact:C8]**.
T3 (contention) never consumes the retry budget ([§15.2](#152-global-redemption-record--the-sole-provider-call-authority)).

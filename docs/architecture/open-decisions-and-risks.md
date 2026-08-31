# Architecture — Open decisions and risks

- **Parent:** [architecture.md](../architecture.md) — overview, component map, cross-cutting
  invariants, phased implementation order, and the [traceability map](../architecture.md#traceability-map).
- **Status:** Draft. What is settled, what is still open, and the known risks. Nothing here is resolved by this document.

> Evidence tags carry the same meaning as in the overview: **[fact:<ref>]** (confirmed by an
> official page listed in [architecture.md §25](../architecture.md#25-official-sources)),
> **[inference]** (a design conclusion drawn from those facts), **[assumption]** (needs a spike
> or human decision).

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
  [§15.2](redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority) is the source of truth for all guards, the queue-message field, the DLQ rules, the
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

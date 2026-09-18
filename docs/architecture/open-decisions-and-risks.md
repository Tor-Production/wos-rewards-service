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

- **Ingestion outcome framing:** ADR 0001 stays **Proposed** and Option 1 is not rejected.
  Task 09 expressly uses the Option 2 companion as a staging-only MVP on a user-controlled
  Windows host while deferring the 72-hour Option 1 spike. That implementation is not a spike
  pass, waiver, production selection, or production reliability claim.
- **Slash commands:** documented only in ADR 0001 (Option 3 / fallback), not as a secondary
  path here.
- **Event acceptance:** atomic (`processed_events` marker only in the same batch as the
  work or the validation-reply delivery row). Phase 3 uses six set-based statements for
  valid registrations and writes `work_committed` directly, with all active-code
  membership durable. The existing schema cannot resume a historical-code registration
  shell, so that fallback is withdrawn. Parent rows precede the marker where required
  by foreign keys; the event's delivery group is deterministically `evt:<event_id>`.
- **Registration identifiers:** digit strings are preserved verbatim, including leading
  zeros; player ids are capped at 32 digits and states at 16. Names are capped at 64
  Unicode code points, rendered labels at 80; missing names render as `ID ` plus player id.
- **Registration snapshot cap:** 2,000 active codes, enforced inside the acceptance
  transaction with the existing operation `expected_count >= 0` constraint. Above the
  cap, the insert attempts `expected_count = -1`, rolling back every event write and
  returning `503`. This needs no migration. Raising the cap requires a separate design;
  resumable registration expansion would need durable code membership such as a future
  `operation_codes_snapshot` table. The implemented Phase 4 distribution fan-out remains
  cursor-based.
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
  The Worker classifies only after authentication, requires exact `staging`, distinguishes
  bot author ids from webhook ids, and never classifies a human as a spike sender. Invalid
  probes atomically retain an immediately finalized `staging_spike` marker and one
  validation-reply evidence row born superseded, dispatch-ineligible, and permanently
  blocked. OLD-aware D1 triggers make both rows immutable and prevent insert/relink escape;
  dispatcher selection and claim repeat all suppression guards.
- **Local Option 1 mechanics:** Task 08C supplies a real local-test Durable Object wrapper over
  Task 08A, with versioned state, generation fencing, one-alarm scheduling, conservative claimed
  alarm recovery, and a trusted in-process route into Task 08B. Its namespace exists only in
  Vitest/Miniflare; this resolves local integration mechanics, not the ingestion-topology choice.
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
  bounded duplicate suppression; footer only in the final chunk. Task 09 adds the real API-v10
  transport behind an explicit staging flag and bot-token presence; safe defaults perform no
  request and tests inject fake fetch.
- **Manual staging code intake:** exact authenticated `POST /manual-code` request, human admin
  checks in companion and Worker, 64-character ASCII grammar, five-minute age bound, and an
  additive `manual_code_commands` ledger keyed by Discord message id. The command opens the
  existing distribution path atomically; it is not automatic discovery.
- **D1 → Queue reliability:** per-item transactional outbox carrying `attempt_id`; `dead`
  rows are atomic-reopened (fresh `attempt_id`) while `summary_state='none'`, or the outcome
  is recorded in `operation_late_results` + handed to a `repair_run` once the snapshot is
  sealed / finalized (no ineffective requeue). Phase 3 implements sending, backoff and
  `dead` marking only; those recovery paths and alerts remain deferred.
- **`nonce` / `enforce_nonce`:** confirmed — `nonce` ≤ 25 chars; `enforce_nonce` checks
  uniqueness within the past few minutes and returns the existing message for a same-author
  repeat **[fact:D6]**.
- **`already_redeemed`:** explicit success-equivalent terminal outcome; counts toward
  `applied`, never a failure.

### Open

- Task 10's [provider evidence and gate record](../whiteout-provider-decision.md#10-task-10-public-evidence--2026-09-17):
  no acceptable authorized contract was found in examined public sources. The human maintainer
  accepted the exact narrow amendment on 2026-09-18, but upstream operator authorization, a
  versioned authorized contract and separate approval of any isolated offline slice remain
  necessary under §4. The broader stage A–D proposal remains pending. Production activation
  separately requires applicable credentials, explicit activation approval and all §5 evidence.

- Whether a permanently hosted Cloudflare Gateway client (Option 1) is reliable enough —
  the ADR 0001 spike decides.
- Where a production companion runs if Option 2 ultimately stands (Task 09 fixes only the MVP
  location: a foreground process on the user-controlled Windows host).
- Tuning during implementation: lease durations (`ITEM_CLAIM_LEASE_SECONDS`;
  `REDEMPTION_CLAIM_LEASE_SECONDS` — the **invocation** lease, which **must exceed the
  provider call timeout** so a lease never expires mid-call (T3 then guarantees no second
  call); `OUTPUT_CLAIM_LEASE_SECONDS`), `FANOUT_EXPANSION_PAGE_SIZE`,
  `SUMMARY_BUILD_PAGE_SIZE`, `SUMMARY_MAX_CHUNKS`, `SWEEPER_REDRIVE_BATCH`,
  `REDEMPTION_MAX_REEVAL`, and the `retry_wait` backoff schedule.
- Whether `repair_run` is fully automated later or stays human-triggered; whether
  `REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED` is ever enabled in production.
- Missed-event backfill: bounded REST catch-up vs manual re-send only.
- The gift-code discovery source and its contract — not authorized.

### Risks

- The Free-plan Cron CPU allowance is 10 ms. The outbox scan and sends are bounded, but
  local functional checks do not establish deployed CPU, D1 query duration, or latency;
  measure representative payloads when provisioning is authorized. Sequential sends
  can require up to eight serial round trips per dispatch.
- The registration cap bounds code count, not total write bytes. More than 2,000 active
  codes are refused with no acceptance writes until an operator resolves the cause or
  a separately reviewed design raises the cap.
- Compact JSON UTF-8 size plus a 100-byte per-message charge is a conservative Queue
  body estimate with reserved headroom, not an exact envelope measurement. Any platform
  rejection still follows bounded send-failure backoff and eventual `dead` marking.
- The narrow 2026-09-17 staging smoke sent one registration and one synthetic manual code, then
  replayed the code once to exercise durable deduplication. The registration and code-fanout Queues,
  D1 state, `MockWhiteoutProvider`, and Discord delivery completed with one registration summary,
  one distribution summary, no duplicate operation, and no observed backlog, retry, DLQ message,
  Worker error, or exceeded-resource event. This single low-volume smoke does not establish
  throughput, Queue or end-to-end latency, retry timing, sustained CPU behavior, or billing.
- Privileged `MESSAGE_CONTENT` intent could gate future scaling (approval needed above
  ~100 guilds / 10,000 users) **[fact:D3]**; mitigation: stay small or plan verification
  early.
- If Option 2 stands, the companion is a single point of failure for live ingestion;
  the MVP has no service manager, health check, or persistent catch-up buffer. Mitigation today:
  foreground operation, bounded immediate retries, atomic accept + PK conflict, and manual re-send.
  Supervision/health checks and a bounded backfill decision remain later work.
- Cloudflare hibernation/eviction timings (~10 s / ~70–140 s idle; 15-minute cap on how
  long an active outbound connection *prevents* eviction) are documented but operational
  **[fact:C1][fact:C2]**; the spike must observe actual behaviour and must not be read as a
  platform guarantee.
- The immutable staging-spike acceptance boundary and local-only Durable Object adapter are
  implemented and integrated locally, but they do not prove Gateway residency or live event
  delivery. A deployable binding/transport, poster, observer, expected-message ledger,
  provisioning, and live 72-hour spike remain separate, explicitly authorized work. Local
  eviction proves the test runtime reconstructs stored state; it cannot establish deployed
  outbound-WebSocket survival, alarm latency, CPU duration, Discord replay coverage, or
  reconciliation timing. Retained spike rows must survive cleanup and every documented
  reconciliation count must remain zero.
- Discord documents no exactly-once message creation; a summary chunk or validation reply
  re-sent outside the few-minute `enforce_nonce` window can duplicate **[fact:D6]** —
  mitigated, not eliminated.
- At-least-once delivery with no producer dedup key **[fact:C7]** ⇒ duplicate work unless
  the item lease and the global redemption claim are implemented exactly.
- Task 10 established that a consumer timeout does not cancel a provider call and that local
  terminal reconciliation is not upstream reconciliation. The merged Task 13 containment now
  records a pre-dispatch hold and finalizes ambiguous timeout, crash, and lost-result paths as
  uncertainty without automatic replay. That local guard does not prove whether the upstream
  action applied, clear the hold, or supply provider idempotency/reconciliation; production
  redemption therefore stays blocked.
- Mock and future real results would share player/code identities without provider provenance.
  See the canonical
  [compatibility assessment](../whiteout-provider-decision.md#11-contract-readiness-and-implementation-compatibility)
  and [isolated-stack recommendation](../whiteout-provider-decision.md#12-minimum-mock-to-real-isolation-recommendation)
  before considering a real test; a fresh code or receipt prefix is insufficient isolation.
- The gift-code source and real provider remaining unauthorized block automatic discovery and
  real redemption. Task 09 supplies a manual staging code only to `MockWhiteoutProvider`.

# Architecture — Summary construction and Discord delivery

- **Parent:** [architecture.md](../architecture.md) — overview, component map, cross-cutting
  invariants, phased implementation order, and the [traceability map](../architecture.md#traceability-map).
- **Status:** Draft. The source freeze, the paged seal → layout → render pipeline, and Discord output safety.

> Evidence tags carry the same meaning as in the overview: **[fact:<ref>]** (confirmed by an
> official page listed in [architecture.md §25](../architecture.md#25-official-sources)),
> **[inference]** (a design conclusion drawn from those facts), **[assumption]** (needs a spike
> or human decision).

---

## 15.3 Completion accounting and the source freeze

**While deciding whether to seal:** an operation is finalisable when
`count(operation_items.status IN ('success','already_redeemed','permanent_failure','retry_exhausted')) >= expected_count`
(and, for distribution runs, `expansion_state = 'expanded'`). `permanent_failure` here
includes `reason_code = 'state_reevaluation_limit'` (T8) — a terminal failure that lets the
operation finish.

**Source freeze — the instant `summary_state` leaves `none`:** the mirror write from a
consumer or the sweeper is guarded so it mutates `operation_items` **only while
`operations.summary_state = 'none'`**; once it is `sealing`/`building`/… a later redemption
outcome is appended to **`operation_late_results`** instead
([§12](data-model-and-outbox.md#operation_late_results-audit--history--outcomes-observed-after-freeze),
[§15.2](redemption-state-machine.md#crash-safe-re-drive-operation-sweeper)). `operation_items.display_label` is
immutable from creation. So every `operation_items` row that feeds the paged seal is frozen
at one logical transition — no page can combine a status or a label from a different moment.

**After sealing:** all summary-facing counts (`applied = success + already_redeemed`,
failure counts) are recomputed **from `summary_item_snapshot`**, the same immutable version
the rendered rows come from. `already_redeemed` counts toward `applied` and is never a
failure; a `state_reevaluation_limit` row is a failure line, rendered truthfully (e.g.
"state re-check limit — manual review"), never as "ineligible".

---

## 15.4 Deterministic, bounded, crash-resumable summary build and per-chunk delivery

A single nonce/message id cannot represent a chunked summary, and the chunk count grows with
the player list, so the build is **paged like fan-out expansion** — never one unbounded
Worker invocation or `db.batch()`. Summaries and invalid-input replies share the same
durable per-message model; a validation reply is the trivial one-chunk case.

**Deterministic identity (independent of build order).** For an operation, the summary's
`delivery_group = "sum:" + operation_id`. Chunk `k` has
`delivery_id = "out:" + delivery_group + ":" + k` and
`nonce = base62(hash(delivery_id))[:25]` (≤ 25 chars **[fact:D6]**). The rendered content of
chunk `k` is a pure function of `(operation_id, k)` and the **immutable
`summary_item_snapshot`** (ordered by `sort_key`) — never `operation_items` or `players`
after the seal.

**Seal (the atomic transition that freezes every rendered input).** When an operation
becomes finalisable ([§15.3](#153-completion-accounting-and-the-source-freeze)) **or** is
force-closed at `deadline_at`, a single guarded statement moves
`summary_state: 'none' → 'sealing'` (`WHERE summary_state = 'none'` — exactly one writer
wins). **That same transition freezes the source:** from this instant, mirror writes for
this operation go to `operation_late_results`, and `operation_items.display_label` was
already immutable, so every source row is fixed as of one logical moment. Then a **paged
seal pass** (page size `SUMMARY_BUILD_PAGE_SIZE`) reads those frozen `operation_items` rows
in **`(player_id, code)` order** and — in one **bounded** `db.batch()` per page —
`INSERT … INTO summary_item_snapshot` (frozen `status` / `reason_code`, `display_label`
copied verbatim from `operation_items`, `sort_key` from `status_rank(status)`) `ON CONFLICT
(operation_id, player_id, code) DO NOTHING`, advancing `operations.snapshot_cursor` (the last
`(player_id, code)` sealed). The seal **never reads `players`**. When the last row is copied,
`summary_state: 'sealing' → 'building'` and `snapshot_sealed_at = now`. A resumed crash
re-reads only rows after `snapshot_cursor`; all inputs are already frozen, so the result is
byte-identical.

1a. **Layout pass (paged, resumable).** Read `summary_item_snapshot` `ORDER BY sort_key` in
    pages of `SUMMARY_BUILD_PAGE_SIZE`, resuming after `operations.summary_layout_cursor`.
    Fold each row into the open chunk, tracking `{first_sort_key, bytes, chunk_index}`
    (`operations.summary_layout_open`); when adding a row would exceed
    `DISCORD_MESSAGE_MAX_LENGTH` minus headroom for the `(part N/M)` marker **and** the
    footer (reserved on *every* chunk boundary so `chunk_total` never shifts), seal the open
    chunk. In one **bounded** `db.batch()` write the newly-sealed
    `summary_chunk_layout(operation_id, chunk_index, first_sort_key, last_sort_key)` rows
    (`ON CONFLICT DO NOTHING`) **and** `summary_layout_cursor = last sort_key read` **and**
    `summary_layout_open = {current open chunk}` — atomically, so a crash resumes with the
    partial chunk intact (no lost items, no reprocessing: the cursor always advances by a
    whole page and the open-chunk accumulator carries the remainder). If `chunk_index`
    reaches `SUMMARY_MAX_CHUNKS`, stop: the final chunk records `overflow_remaining`
    (snapshot rows beyond the cap) and will render a deterministic
    `"+<overflow_remaining> more not listed"` line. When the last snapshot row is folded,
    seal the final open chunk and set `operations.summary_chunk_total`
    (`summary_state` stays `'building'` — it covers both the layout and render passes).
1b. **Render + persist pass (paged, resumable, idempotent).** For `chunk_index` from
    `summary_build_cursor + 1`, in pages of `SUMMARY_BUILD_PAGE_SIZE`: read that chunk's
    `first_sort_key..last_sort_key` window from `summary_item_snapshot` (a bounded read),
    render its content with the `(part chunk_index/summary_chunk_total)` marker and — **only
    when `chunk_index = summary_chunk_total`** — the runtime footer; `INSERT` the
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

---

## 15.5 Zero-result operations

If a `registration_run` snapshot has **zero active codes**, or a `code_distribution_run`
snapshot has **zero registered players**, `expected_count = 0` and the operation is
**immediately finalisable**. The seal pass writes zero `summary_item_snapshot` rows; the
layout pass produces `summary_chunk_total = 1` in one page; the render pass persists a
**single** `discord_output_deliveries` row (`chunk_index = chunk_total = 1`,
`has_footer = 1`) with a zero-result body (`"0 codes applied"` / `"applied to 0 players"`),
delivered by the same dispatcher. The runtime footer is present in that one chunk.

---

## 18. Discord output safety

- **Sanitisation:** display names and any echoed user input are sanitized
  (strip/escape backticks, `@`, `#`, `:` role/emoji triggers, zero-width and control
  characters; cap length). The label is sanitised and stored in
  `operation_items.display_label` **when the item row is created** and is **immutable**
  thereafter; the seal copies it verbatim and the render pass never reads `players`, so a
  later `players.display_name` change cannot alter an in-progress or delivered summary.
- **Mention suppression:** every Create Message call sets `allowed_mentions` to an empty
  allow-list so `@everyone`, role, and user mentions never fire.
- **No silent mutation:** the service never edits or deletes a message it did not just
  create; summaries and replies are new messages only.
- **Deterministic chunking:** the layout pass splits on `summary_item_snapshot` row
  boundaries (never mid-item), hard-caps each chunk below `DISCORD_MESSAGE_MAX_LENGTH`, adds
  `(part N/M)` continuation markers, and persists **every chunk (in bounded, cursor-resumable
  pages — [§15.4](#154-deterministic-bounded-crash-resumable-summary-build-and-per-chunk-delivery))
  before any is sent**. Each chunk has its own deterministic ≤ 25-char nonce and its own
  delivery state.
- **Footer scope:** the runtime footer defined in `AGENTS.md` is present **only in the final
  persisted chunk** (`chunk_index = chunk_total`) of a summary or partial summary emitted
  after gift-code processing. It is never in an earlier chunk, never in a
  `validation_reply`, and never in logs, docs, commit messages, or PR descriptions. This
  document does not reproduce the footer string; the authoritative text lives in `AGENTS.md`.

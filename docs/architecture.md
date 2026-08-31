# Architecture — Whiteout Survival Rewards Service

- **Status:** Draft
- **Date:** 2026-08-30
- **Owner:** wos-rewards-service maintainers
- **Supersedes:** none
- **Related:** [ADR 0001 — Discord event ingestion](adr/0001-discord-event-ingestion.md) (**Proposed**), [Whiteout provider decision](whiteout-provider-decision.md)

> Evidence in this document is tagged **[fact:<ref>]** (confirmed by an official
> documentation page listed in [§25](#25-official-sources)), **[inference]** (a design
> conclusion drawn from those facts), or **[assumption]** (needs a spike or human decision).
>
> Two further distinctions are carried by status rather than by tag, and are equally binding:
> a **proposed decision** is recorded but not accepted — the ingestion topology in
> [§2](#2-system-context-and-deployment-topology) is provisional until
> [ADR 0001](adr/0001-discord-event-ingestion.md) (**Proposed**) is settled by its spike; an
> **unresolved decision** is one nothing in this document set decides, listed under *Open* in
> [architecture/open-decisions-and-risks.md](architecture/open-decisions-and-risks.md). Neither
> may be read as settled, and no document may silently resolve one.

**This document is the overview.** Detailed material lives in focused documents under
[`docs/architecture/`](architecture/) — see the [Document map](#document-map) below, and
[`docs/README.md`](README.md) for current state and per-phase routing. The section numbers
kept here (§1, §2, §8, §16, §23, §25) are the original ones; the gaps are the sections that
moved, and every one of them is listed in the [Traceability map](#traceability-map). Numbering
was deliberately not rewritten, so every `§N` reference in this repository still resolves.

---

## Document map

Canonical links. Each subject has exactly one owning document; this overview summarizes and
links, and never restates a normative rule that another document owns.

| Document | Owns | Load it when you need |
|---|---|---|
| **This document** | Scope and goals (§1), system context and deployment topology (§2), component boundaries (§8), cross-cutting idempotency invariants (§16), the phased implementation order (§23), and the official-sources table (§25) that every `[fact:<ref>]` tag resolves against | Orientation; which component does what; what phase you are in; where an evidence tag comes from |
| [architecture/configuration.md](architecture/configuration.md) | §4 — every non-secret variable and every secret, **names only** | Wiring a stack; looking up what a variable controls |
| [architecture/discord-ingestion-and-registration.md](architecture/discord-ingestion-and-registration.md) | §3 `DiscordEventSource` and the author gate, §5 registration flow and atomic acceptance, §6 existing-code processing, §7 new-code fan-out | Anything from a Discord message up to the point work is enqueued |
| [architecture/data-model-and-outbox.md](architecture/data-model-and-outbox.md) | §10 identifier handling, §12 the preliminary D1 tables, §14 the transactional outbox | Schema and migrations; the committed-intent → Queue bridge |
| [architecture/redemption-state-machine.md](architecture/redemption-state-machine.md) | §11 `WhiteoutProvider` / `GiftCodeSource`, §13 Queue and DLQ boundaries, §15.1 the item lease, §15.2 the global redemption record and the **T1–T16** state-transition table, §17 retry and permanent-failure classification | Any provider call, retry, DLQ, or serialization question |
| [architecture/summary-and-delivery.md](architecture/summary-and-delivery.md) | §15.3 completion accounting and the source freeze, §15.4 the seal → layout → render → deliver pipeline, §15.5 zero-result operations, §18 Discord output safety and footer placement | Building or sending a Discord summary or validation reply |
| [architecture/operations-and-reliability.md](architecture/operations-and-reliability.md) | §9 scheduled components, §19 staging/production separation, §20 observability, §21 testing strategy, §22 failure modes and recovery, §15.6 the scenario matrix | Cron, alerting, tests, and what happens when something breaks |
| [architecture/open-decisions-and-risks.md](architecture/open-decisions-and-risks.md) | §24 — Resolved, Open, and Risks | Checking whether something is decided before you assume it |
| [adr/0001-discord-event-ingestion.md](adr/0001-discord-event-ingestion.md) | The ingestion-transport decision (**Proposed**) and its spike design | Running or judging the spike; picking the adapter |
| [whiteout-provider-decision.md](whiteout-provider-decision.md) | What Whiteout Survival access is authorized, the mock contract, and the gate on production redemption (**BLOCKED**) | Anything touching a provider or gift-code discovery |
| [README.md](README.md) | Current state and per-phase documentation routing | Starting any task |

Rules that live in exactly one place: the **T1–T16** transition table is
[§15.2](architecture/redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)
and nothing else re-tabulates it; **footer placement** is
[§18](architecture/summary-and-delivery.md#18-discord-output-safety) and the **footer text**
is `AGENTS.md`, reproduced nowhere; the **author filter** and `SPIKE_SENDER_ALLOWLIST`
behaviour is [§3](architecture/discord-ingestion-and-registration.md#author-filtering); the
**official sources** table is §25 of this document.

---

## 1. Scope, goals, non-goals

### In scope

- A Discord bot that registers Whiteout Survival players from plain messages in **one
  configured registration channel** and processes gift codes for them.
- Cloudflare Workers + Durable Objects + D1 + Queues as the backend runtime, TypeScript
  strict mode, staging-first.
- `MockWhiteoutProvider` as the default gift-code redemption provider in development,
  automated tests, and staging.
- A stable ingestion boundary (`DiscordEventSource`) so the rest of the system does not
  depend on how the Discord Gateway connection is hosted.

### Goals

- Idempotent handling of every Discord event, player registration, gift code, and
  redemption attempt.
- **Atomic acceptance:** a Discord event is never marked accepted without either its
  registration work or its validation response also becoming durable in the same unit (or
  remaining resumable through an explicit state machine).
- **Global redemption serialization:** at most one `WhiteoutProvider.redeem` call is
  in flight per `(player_id, code)` pair, regardless of how many operations reference it.
  One owner-path retry stays attached to one durable `attempt_id` across redelivery; lease
  contention is separate from provider-failure retry accounting; every global terminal
  transition is guarded by the exact `attempt_id`; and terminal results are re-evaluable
  per reason (state-dependent failures reopen when the player's `state` changes, including
  a guarded check before a stale in-flight attempt can terminalize).
- **One logical summary per operation with at-least-once Discord delivery and bounded
  duplicate suppression.** Every user-facing Discord message (operation summary or
  invalid-input reply) is built deterministically, persisted per chunk, and delivered
  through the same durable mechanism; duplicates remain possible outside Discord's
  few-minute nonce window **[fact:D6]**.
- Clear staging/production separation with no shared secrets, databases, or queues.
- No dependency on undocumented Whiteout Survival endpoints, scraping, cookies, session
  credentials, CAPTCHA bypass, or anti-bot bypass.

### Non-goals

- Production gift-code redemption (blocked — see
  [whiteout-provider-decision.md](whiteout-provider-decision.md)).
- A finalized gift-code discovery source (represented as an abstraction only).
- Discord self-bot behaviour or automation of a normal Discord user account.
- Slash-command / interactions UX as the primary registration path (evaluated only as ADR
  0001 Option 3 / fallback).
- Multi-guild scale-out, a web dashboard, analytics, or historical reporting.
- Choosing where a non-Cloudflare companion process runs (infra decision, deferred).

---

## 2. System context and deployment topology

> **PROVISIONAL — pending [ADR 0001](adr/0001-discord-event-ingestion.md) spike.**
> The ingestion tier below shows **Option 2 (external companion Gateway client)** as the
> provisional reference topology because official platform documentation does **not**
> establish a reliability guarantee for a permanently hosted Cloudflare Gateway client
> **[fact:C1][fact:C2]**. ADR 0001 is **Proposed**; a time-boxed spike decides between
> Option 1 (Durable Object Gateway client) and Option 2. Everything to the right of the
> `DiscordEventSource` boundary is identical for either outcome.

```mermaid
flowchart LR
  subgraph DISCORD["Discord"]
    GW["Discord Gateway (MESSAGE_CREATE)"]
    REST["Discord REST API (Create Message)"]
  end

  subgraph ING_TIER["Ingestion tier — PROVISIONAL"]
    SRC["DiscordEventSource<br/>Option 1: Durable Object | Option 2: external companion"]
  end

  subgraph CF["Cloudflare backend — implementation-agnostic"]
    ING["Ingestion Worker /ingest<br/>atomic accept or resumable state machine"]
    D1[("D1: players, gift_codes, redemptions (global claim + generation),<br/>processed_events (state machine), operations, operation_items,<br/>summary_chunk_layout, discord_output_deliveries, outbox_jobs")]
    DISP["Outbox dispatcher (Cron + inline)"]
    Q1[["Queue: registration-jobs"]]
    Q2[["Queue: code-fanout-jobs"]]
    DLQ[["Queue: redemption-dlq"]]
    RC["Registration consumer"]
    FC["Fan-out consumer"]
    DLC["DLQ inspection consumer"]
    SWEEP["Operation sweeper (Cron)"]
    OUTD["Output delivery dispatcher (Cron + inline)"]
    OUT["Discord output builder"]
    PROV["WhiteoutProvider adapter (Mock by default)"]
    GCS["GiftCodeSource adapter (not authorized)"]
  end

  GW --> SRC
  SRC -->|"authenticated HTTPS: RegistrationMessageEvent"| ING
  ING --> D1
  D1 --> DISP
  DISP --> Q1
  DISP --> Q2
  Q1 --> RC
  Q2 --> FC
  RC -->|"claim redemptions(player_id,code)"| D1
  FC -->|"claim redemptions(player_id,code)"| D1
  RC --> PROV
  FC --> PROV
  Q1 -. "exhausted retries" .-> DLQ
  Q2 -. "exhausted retries" .-> DLQ
  DLQ --> DLC --> D1
  SWEEP --> D1
  RC --> OUT
  FC --> OUT
  SWEEP --> OUT
  OUT --> D1
  D1 --> OUTD
  OUTD --> REST
  GCS --> D1
```

### Deployment stacks

Two fully separate stacks, `staging` and `production`, selected by the `ENVIRONMENT`
variable. Each stack has its own D1 database, its own three Queues, its own Durable Object
namespace (if Option 1 is chosen), its own Discord application + bot token, its own Cron
Triggers, and its own secret set. No resource, name, or secret is shared between stacks.
See [§19](architecture/operations-and-reliability.md#19-staging-and-production-separation).

### Trust boundaries

- **Discord ↔ ingestion tier:** the Discord bot token authenticates the Gateway
  connection. Only `MESSAGE_CREATE` events for the configured guild + registration channel,
  authored by a **non-bot, non-system, non-webhook** user, are relevant
  ([§5](architecture/discord-ingestion-and-registration.md#5-discord-registration-flow)).
- **Ingestion tier ↔ Cloudflare backend:** the ingestion tier authenticates to the
  Ingestion Worker with `INGESTION_SHARED_SECRET` (Option 2) or is in-process (Option 1).
  The ingestion tier is **untrusted for business logic** — it may not decide whether a
  registration is valid.
- **Cloudflare backend ↔ Whiteout Survival:** all access goes through the
  `WhiteoutProvider` interface, serialized per `(player_id, code)` by the global
  `redemptions` record. No other component talks to the game.

---

## 8. Component responsibilities

| Component | Responsibility | Notes |
|---|---|---|
| `DiscordEventSource` | Hold the Gateway connection; filter to guild+channel; drop bot/system/webhook/own-app messages (production) — forward `SPIKE_SENDER_ALLOWLIST` senders unchanged (staging); POST `RegistrationMessageEvent` | Companion **or** DO, per ADR 0001; no business logic |
| Ingestion Worker (`/ingest`) | Authenticate the source; re-apply the author filter (authoritative staging gate, asserts non-production); parse; **atomically** persist `processed_events` + (validation-reply delivery row **or** registration work + outbox rows) + the guarded **T13** reopen of state-dependent `redemptions` failures on a `state` change, or the resumable state-machine shell | Stateless Worker; PK conflict ⇒ duplicate no-op |
| Fan-out expansion worker | Paginate the player snapshot into `operation_items` (with `display_label`) + outbox rows | Cursor-driven, bounded, restartable |
| Outbox dispatcher | Enqueue `pending` outbox rows; back off; mark `dead`; **atomic-reopen** (fresh `attempt_id`) while `summary_state='none'`, else flag a `repair_run` ([§14](architecture/data-model-and-outbox.md#14-transactional-outbox)) | Cron (every minute, [fact:C4]) + inline best-effort |
| Registration consumer | Claim the coarse item lease; **acquire the per-invocation `redemptions` claim** (T1/T2); reuse a terminal outcome; **`ack`** on T3 (live invocation / not due / different attempt); redeem under `current_invocation_token`; invocation-guarded writes (T4–T9, incl. `attempt_state` vs `players.state` and the T8 cap); mirror while `summary_state='none'`; trigger the freeze + seal + build | Queue consumer; T3 never uses `message.retry`; `retryable` ⇒ T9 then `message.retry` |
| Fan-out consumer | Same as the registration consumer, for one `(player_id, code)` per job; triggers the freeze + seal + build when expansion done | Queue consumer |
| DLQ inspection consumer | Set the global row `retry_exhausted` on an exact `current_attempt_id = message.attempt_id` match when **no invocation is active**: a `retry_wait` row always qualifies (`current_invocation_token IS NULL`; the future `retry_due_at` / pickup-grace `invocation_expires_at` are not consulted), an `in_progress` row only if its `current_invocation_token` is null or `invocation_expires_at` has passed (T10); a different `attempt_id` ⇒ `dlq_stale_attempt`, a still-live invocation ⇒ `dlq_invocation_active`, both audit-only and change nothing (T11); mirror to non-terminal `operation_items` (subject to the [§15.3](architecture/summary-and-delivery.md#153-completion-accounting-and-the-source-freeze) freeze) | Consumer of `redemption-dlq`; each DLQ message is one specific `attempt_id` |
| Operation sweeper | Force-close operations past `OPERATION_DEADLINE_SECONDS` (then **freeze + seal**); **T12** reset `redemptions` rows with an expired invocation (`in_progress`/`retry_wait` → `pending`); mirror terminal redemptions onto waiting items (freeze-guarded); **re-drive** up to `SWEEPER_REDRIVE_BATCH` stuck non-terminal, unclaimed pairs with a **fresh `attempt_id`**; **T15** guarded `state`-mismatch reopen of already-terminal `player_ineligible` rows; atomic-reopen outbox-dead items pre-seal; optional bounded `retry_exhausted` reopen | Cron |
| Discord output builder | **Paged, cursor-driven, idempotent**: **seal** `summary_item_snapshot` (once), then a layout pass assigns snapshot `sort_key` ranges to chunks (`summary_chunk_layout`, persisting the open-chunk accumulator with the cursor) and a render pass persists `discord_output_deliveries` rows; every pass reads **only** the immutable snapshot; footer only in the final chunk; capped at `SUMMARY_MAX_CHUNKS` | Cron (shared `scheduled()` handler) + inline best-effort |
| Output delivery dispatcher | Claim `pending` (or lease-expired) `discord_output_deliveries` chunks in `chunk_index` order; send via Create Message with per-chunk nonce + `enforce_nonce`; record `discord_message_id`; resume at the first unsent chunk | Cron (every minute) + inline best-effort |
| `WhiteoutProvider` adapter | `redeem(PlayerRef, code, idempotencyKey)` → structured result; provider-side rate limiting; error mapping | `MockWhiteoutProvider` by default |
| `GiftCodeSource` adapter | Discover/list candidate codes from an **authorized** source | Not authorized; disabled |
| Code-discovery scheduler | Poll the authorized source when `CODE_DISCOVERY_ENABLED=true` | Cron; no-op until authorized |
| D1 | System of record | See [§12](architecture/data-model-and-outbox.md#12-preliminary-d1-data-model) |
| Queues + DLQ | Async fan-out + retry isolation | See [§13](architecture/redemption-state-machine.md#13-cloudflare-queue-and-dead-letter-queue-boundaries) |

---

## 16. Idempotency

| Layer | Key | Mechanism |
|---|---|---|
| Discord event acceptance | `processed_events.event_id` | marker inserted **only** in the same atomic `db.batch()` as the validation-reply delivery row (invalid) or the registration work + outbox rows (valid); PK conflict ⇒ whole batch rolls back ⇒ duplicate no-op; state-machine mode keeps `status` non-terminal until `work_committed` |
| Player | `players.player_id` | upsert |
| Gift code | `gift_codes.code` | unique |
| **Redemption (global)** | `redemptions (player_id, code)` | acquire-invocation upsert (**T1/T2/T3**); the durable `attempt_id` is the retry budget, the per-invocation `current_invocation_token` serializes provider calls; **every consumer terminal / `retry_wait` write guarded on `current_attempt_id = :aid AND current_invocation_token = :itok AND status='in_progress'`**; the **DLQ** write (T10) guarded on exact `attempt_id` **AND no live invocation**; state-dependent terminal adds `attempt_state` vs `players.state`; `success` / `already_redeemed` immutable (T16); T3 (contention) writes nothing here; full transition table in [§15.2](architecture/redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority) |
| Operation item | `operation_items (operation_id, item_key)` | PK + coarse `attempt_id` lease (queue-dedup + accounting only — the real serializer is the global invocation token); `status` frozen once `summary_state ≠ 'none'` |
| Outbox → Queue | `outbox_jobs.job_id` + `attempt_id` in the message body | **consumer-side** dedup (no producer key, [fact:C7]); `attempt_id` re-minted only on a reset to `pending`, never on `message.retry` |
| Summary rendered inputs | `summary_item_snapshot (operation_id, player_id, code)` (ordered by `sort_key`) | sealed once from **frozen** `operation_items` (freeze at `summary_state: none → sealing`; later outcomes → `operation_late_results`), `ON CONFLICT DO NOTHING`; immutable after seal; both build passes **and the counters** read only this |
| Discord output (per chunk) | `discord_output_deliveries.delivery_id` + deterministic `nonce`; `summary_chunk_layout (operation_id, chunk_index)` | `delivery_id` / `nonce` / content are pure functions of `(operation_id, chunk_index)` + the immutable snapshot; seal / layout / render passes resume from `snapshot_cursor` / (`summary_layout_cursor` + `summary_layout_open`) / `summary_build_cursor` with `ON CONFLICT DO NOTHING`; `enforce_nonce` bounded suppression ([fact:D6]); delivery resumes at first unsent chunk |

Queues are at-least-once **[fact:C7][fact:C8]**; every consumer is written to be safely
re-runnable.

---

## 23. Phased implementation order

Each phase is its own branch + PR, starting from the merged `main`. No merge or deploy is
automated.

1. **Scaffold** — TypeScript strict, Wrangler config for the `staging` stack,
   `MockWhiteoutProvider`, test harness. Staging only.
2. **D1 schema + migrations** for the preliminary model ([§12](architecture/data-model-and-outbox.md#12-preliminary-d1-data-model)).
3. **Ingestion Worker + `DiscordEventSource` interface + atomic acceptance + transactional
   outbox + Queues** — no real Gateway adapter yet; drive `/ingest` with synthetic
   `RegistrationMessageEvent`s (including bot/webhook cases).
4. **Consumers + global redemption serialization + operation aggregation + durable output
   delivery** — item lease, `redemptions` claim, deterministic per-chunk build/deliver,
   footer placement, zero-result handling, bounded expansion, outbox reopen / repair.
5. **ADR 0001 spike** — decide Option 1 vs Option 2 against the spike's pass/fail criteria.
6. **Chosen `DiscordEventSource` adapter** — implement the winner. *(Blocked until phase 5
   completes or is explicitly waived.)*
7. **Observability, sweepers, DLQ consumer, hardening.**
8. **Blocked** — authorized `WhiteoutProvider` / `GiftCodeSource`; production redemption.
   Requires the authorizations in
   [whiteout-provider-decision.md](whiteout-provider-decision.md).

---

## 25. Official sources

Every fact tag above resolves here. All URLs are official
(`docs.discord.com/developers/*`, `developers.cloudflare.com/*`).

| Ref | URL | Facts used |
|---|---|---|
| D1 | <https://docs.discord.com/developers/events/gateway> | Connection lifecycle; Hello + `heartbeat_interval`; jittered first heartbeat; Heartbeat ACK, missed ACK → close with a non-`1000`/`1001` code then reconnect + Resume; Identify required, **1000 IDENTIFY / 24 h** globally (RESUME excluded); Resume needs `session_id` + `resume_gateway_url` + last `s`, no re-Identify; resumable vs non-resumable close codes; Invalid Session (`d` true/false); `1000`/`1001` invalidate the session; **120 gateway events / 60 s → immediate disconnect**; `max_concurrency` bounds IDENTIFY |
| D2 | <https://docs.discord.com/developers/events/gateway-events> | `MESSAGE_CREATE` "Sent when a message is created"; payload = message object + `guild_id?`, `member?`, `mentions`, `channel_type?` |
| D3 | <https://docs.discord.com/developers/topics/gateway> | `MESSAGE_CONTENT (1 << 15)` is a **privileged intent** gating `content`, `embeds`, `attachments`, `components`, `poll`; empty without it except own messages / DMs / mentions / message-context-menu targets; must be enabled in the Developer Portal; < 10,000 users self-enable, verified apps in 100+ guilds need approval; misconfiguration → close `4014` |
| D4 | <https://docs.discord.com/developers/topics/gateway#get-gateway-bot> | Get Gateway Bot returns `url`, `shards`, `session_start_limit` (`total`, `remaining`, `reset_after`, `max_concurrency`); "should not be cached for extended periods" |
| D5 | <https://docs.discord.com/developers/interactions/receiving-and-responding> | Gateway vs HTTP-webhook interactions are mutually exclusive; webhook must verify Ed25519 (`X-Signature-Ed25519` / `X-Signature-Timestamp`); initial response within **3 seconds**; 15-minute follow-up token; deferred types 5 / 6 |
| D6 | <https://docs.discord.com/developers/resources/message#create-message> | Create Message `nonce` is **at most 25 characters**; with `enforce_nonce=true` Discord checks nonce uniqueness **only within the past few minutes**, and for a same-author repeat in that window **returns the existing message instead of creating another**; no strict exactly-once message-creation guarantee |
| D7 | <https://docs.discord.com/developers/resources/message> | Message object fields: `author` (a user object), `author.bot`, `author.system`, `webhook_id` (present when the message is webhook-generated), `application_id`; `nonce` field type |
| C1 | <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/> | Stub creation ≠ instantiation; first call runs `constructor()`; **hibernation** after ~10 s idle only with no timers / in-progress `fetch()` / WebSocket API / active connections; **full eviction** ~70–140 s from the non-hibernatable idle state; eviction deferred until all outbound connections close **and** the 70–140 s window elapses; hibernation discards in-memory state; next request re-runs `constructor()` |
| C2 | <https://developers.cloudflare.com/durable-objects/best-practices/websockets/> | "Hibernation is only supported when a Durable Object acts as a WebSocket server. Outgoing WebSockets do not hibernate." "an active outbound WebSocket connection keeps the Durable Object alive and prevents eviction for up to 15 minutes per connection." (A cap on how long an active outbound connection *prevents* eviction — not a statement that the connection is closed or the object evicted at 15 minutes.) Serialized attachment max 16,384 bytes |
| C3 | <https://developers.cloudflare.com/durable-objects/api/alarms/> | One alarm per DO; **guaranteed at-least-once** execution; retried on throw with exponential backoff from 2 s, up to 6 retries; alarms persist across restarts; `constructor()` runs before `alarm()` |
| C4 | <https://developers.cloudflare.com/workers/configuration/cron-triggers/> | `triggers.crons`; `scheduled()` handler; **UTC**; minimum granularity every minute; config propagation up to ~15 min |
| C5 | <https://developers.cloudflare.com/workers/platform/limits/> | Cron Triggers **5 per account (Free) / 250 (Paid)**; Cron CPU 30 s (< 1 h interval) / 15 min (≥ 1 h), Paid; alarm handler max wall time 15 min |
| C6 | <https://developers.cloudflare.com/queues/configuration/dead-letter-queues/> | DLQ receives messages after `max_retries` is reached; default retries before DLQ = 3; DLQ messages with no consumer persist 4 days |
| C7 | <https://developers.cloudflare.com/queues/configuration/javascript-apis/> | `MessageBatch`; `ack()` / `ackAll()`; `retry({ delaySeconds })` / `retryAll(...)`; best-effort ordering; producer API carries `body` + `contentType` only — **no producer-side idempotency / dedup key**; at-least-once delivery |
| C8 | <https://developers.cloudflare.com/queues/platform/limits/> | Message ≤ 128 KB; **max retries 100**; consumer batch ≤ 100 messages / 256 KB; batch wait ≤ 60 s; `delaySeconds` ≤ 24 h; push consumer concurrency up to 250; consumer wall clock 15 min |
| C9 | <https://developers.cloudflare.com/d1/worker-api/d1-database/> | D1 is SQLite; `db.batch([...])` executes statements atomically in a single transaction; integer affinity / JS `number` lose precision beyond 2^53 — identifier columns should be `TEXT` |
| C10 | <https://developers.cloudflare.com/d1/platform/limits/> | D1 has per-query bound-parameter, SQL statement-size, rows-read/written, and per-invocation limits, and Worker CPU/time limits still apply — motivating bounded, paged writes (fan-out expansion, summary build) rather than one unbounded batch |

---

## Traceability map

Where every level-two and level-three section of the original single-file `architecture.md`
now lives (plus the level-four blocks under [§15.2](architecture/redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority), listed because they are referenced by
name elsewhere). Heading text — and therefore every GitHub anchor — is unchanged; only the
heading *level* changes where a section was promoted out of its old parent. Content was moved
verbatim: no requirement, safety condition, transition, failure rule, test, unresolved
decision, risk, evidence tag, or source reference was added, removed, or reworded.

`architecture/` paths below are relative to this file.

| Original | Heading | Now in |
|---|---|---|
| §1 | `## 1. Scope, goals, non-goals` | this document (retained) |
| §1 › | `### In scope` | this document |
| §1 › | `### Goals` | this document |
| §1 › | `### Non-goals` | this document |
| §2 | `## 2. System context and deployment topology` | this document (retained) |
| §2 › | `### Deployment stacks` | this document |
| §2 › | `### Trust boundaries` | this document |
| §3 | ``## 3. `DiscordEventSource` — the ingestion boundary`` | [architecture/discord-ingestion-and-registration.md](architecture/discord-ingestion-and-registration.md) |
| §3 › | `### Author filtering` | architecture/discord-ingestion-and-registration.md |
| §3 ›› | `#### Staging spike exception — reachable at both tiers` | architecture/discord-ingestion-and-registration.md |
| §3 › | `### Candidate implementations (decided by [ADR 0001](adr/0001-discord-event-ingestion.md))` | architecture/discord-ingestion-and-registration.md (link target repaired to `../adr/…`; visible text unchanged) |
| §3 › | `### Companion validation scope (Option 2)` | architecture/discord-ingestion-and-registration.md |
| §4 | `## 4. Configuration and environment` | [architecture/configuration.md](architecture/configuration.md) |
| §4 › | `### Non-secret configuration` | architecture/configuration.md |
| §4 › | `### Secrets (names only — never values, never logged)` | architecture/configuration.md |
| §5 | `## 5. Discord registration flow` | architecture/discord-ingestion-and-registration.md |
| §5 › | `### Channel and author gate` | architecture/discord-ingestion-and-registration.md |
| §5 › | ``### Parsing (authoritative rules from `AGENTS.md`)`` | architecture/discord-ingestion-and-registration.md |
| §5 › | `### Atomic acceptance` | architecture/discord-ingestion-and-registration.md |
| §5 › | `### Invalid message reply` | architecture/discord-ingestion-and-registration.md |
| §5 › | `### Valid message — sequence` | architecture/discord-ingestion-and-registration.md |
| §6 | `## 6. Existing-code processing after registration` | architecture/discord-ingestion-and-registration.md |
| §7 | `## 7. New-code fan-out flow` | architecture/discord-ingestion-and-registration.md |
| §7 › | `### Overlap is handled by the global redemption record` | architecture/discord-ingestion-and-registration.md |
| §8 | `## 8. Component responsibilities` | this document (retained) |
| §9 | `## 9. Scheduled (Cron) components and the trigger budget` | [architecture/operations-and-reliability.md](architecture/operations-and-reliability.md) |
| §10 | `## 10. Identifier handling` | [architecture/data-model-and-outbox.md](architecture/data-model-and-outbox.md) |
| §11 | ``## 11. `WhiteoutProvider` and `GiftCodeSource` abstractions`` | [architecture/redemption-state-machine.md](architecture/redemption-state-machine.md) |
| §12 | `## 12. Preliminary D1 data model` | architecture/data-model-and-outbox.md |
| §12 › | ``### `players` `` | architecture/data-model-and-outbox.md |
| §12 › | ``### `gift_codes` `` | architecture/data-model-and-outbox.md |
| §12 › | ``### `processed_events` (event-acceptance state machine)`` | architecture/data-model-and-outbox.md |
| §12 › | ``### `redemptions` (global provider-call authority)`` | architecture/data-model-and-outbox.md |
| §12 › | ``### `operations` `` | architecture/data-model-and-outbox.md |
| §12 › | ``### `operation_items` `` | architecture/data-model-and-outbox.md |
| §12 › | ``### `operation_players_snapshot` (distribution runs only; optional)`` | architecture/data-model-and-outbox.md |
| §12 › | ``### `operation_late_results` (audit / history — outcomes observed after freeze)`` | architecture/data-model-and-outbox.md |
| §12 › | ``### `summary_item_snapshot` (immutable rendered inputs, sealed once)`` | architecture/data-model-and-outbox.md |
| §12 › | ``### `summary_chunk_layout` (deterministic item→chunk assignment)`` | architecture/data-model-and-outbox.md |
| §12 › | ``### `discord_output_deliveries` (durable per-message output)`` | architecture/data-model-and-outbox.md |
| §12 › | ``### `outbox_jobs` `` | architecture/data-model-and-outbox.md |
| §13 | `## 13. Cloudflare Queue and dead-letter-queue boundaries` | architecture/redemption-state-machine.md |
| §14 | `## 14. Transactional outbox` | architecture/data-model-and-outbox.md |
| §15 | `## 15. Redemption serialization, aggregation, and durable summary delivery` | **container heading only — it had no body of its own.** Its six subsections were split across three documents (below) and promoted one level, so no document falsely claims to hold all of them. Nothing else referenced this heading. |
| §15.1 | `### 15.1 Operation-item lease (queue-dedup + accounting)` → `## 15.1 …` | architecture/redemption-state-machine.md |
| §15.2 | `### 15.2 Global redemption record — the sole provider-call authority` → `## 15.2 …` | architecture/redemption-state-machine.md |
| §15.2 ›› | `#### State-transition table (the single source of truth)` → `### …` | architecture/redemption-state-machine.md |
| §15.2 ›› | `#### The six required behaviours` → `### …` | architecture/redemption-state-machine.md |
| §15.2 ›› | `#### Terminal-write guards` → `### …` | architecture/redemption-state-machine.md |
| §15.2 ›› | `#### Crash-safe re-drive (Operation sweeper)` → `### …` | architecture/redemption-state-machine.md |
| §15.2 ›› | ``#### Terminality is per `reason_code` `` → `### …` | architecture/redemption-state-machine.md |
| §15.2 ›› | `#### Crash ambiguity` → `### …` | architecture/redemption-state-machine.md |
| §15.3 | `### 15.3 Completion accounting and the source freeze` → `## 15.3 …` | [architecture/summary-and-delivery.md](architecture/summary-and-delivery.md) |
| §15.4 | `### 15.4 Deterministic, bounded, crash-resumable summary build and per-chunk delivery` → `## 15.4 …` | architecture/summary-and-delivery.md |
| §15.5 | `### 15.5 Zero-result operations` → `## 15.5 …` | architecture/summary-and-delivery.md |
| §15.6 | `### 15.6 Scenario matrix` → `## 15.6 …` | architecture/operations-and-reliability.md |
| §16 | `## 16. Idempotency` | this document (retained) |
| §17 | `## 17. Retry and permanent-failure classification` | architecture/redemption-state-machine.md |
| §18 | `## 18. Discord output safety` | architecture/summary-and-delivery.md |
| §19 | `## 19. Staging and production separation` | architecture/operations-and-reliability.md |
| §20 | `## 20. Observability without leaking secrets` | architecture/operations-and-reliability.md |
| §21 | `## 21. Testing strategy` | architecture/operations-and-reliability.md |
| §22 | `## 22. Failure modes and recovery` | architecture/operations-and-reliability.md |
| §23 | `## 23. Phased implementation order` | this document (retained) |
| §24 | `## 24. Unresolved decisions and risks` | [architecture/open-decisions-and-risks.md](architecture/open-decisions-and-risks.md) |
| §24 › | `### Resolved` | architecture/open-decisions-and-risks.md |
| §24 › | `### Open` | architecture/open-decisions-and-risks.md |
| §24 › | `### Risks` | architecture/open-decisions-and-risks.md |
| §25 | `## 25. Official sources` | this document (retained) |

Anchors are unaffected by the promotions, because a GitHub heading anchor is derived from the
heading text and not from its level: `#152-global-redemption-record--the-sole-provider-call-authority`,
`#atomic-acceptance`, `#21-testing-strategy` and the rest still resolve — in their new file.
Links were repaired to point at that file; no link text changed.

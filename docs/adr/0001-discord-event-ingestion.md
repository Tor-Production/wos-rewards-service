# ADR 0001 — Discord event ingestion

- **Status:** Proposed
- **Date:** 2026-08-29
- **Deciders:** wos-rewards-service maintainers
- **Related:** [architecture.md](../architecture.md), [whiteout-provider-decision.md](../whiteout-provider-decision.md)

> **Not Accepted.** The provisional recommendation below stands only until the time-boxed
> spike in [§6](#6-decision-proposed-spike-gated) completes or is explicitly waived by the
> maintainers.

Evidence is tagged **[fact:<ref>]** (confirmed by an official page in [§10](#10-official-evidence)),
**[inference]**, or **[assumption]**.

---

## 1. Context

The product requires that **plain messages in one configured Discord channel** are
registration commands (`PLAYER_ID [STATE] [NAME]`), with no change to that user experience.

Consequences of that requirement, from official documentation:

- Reading arbitrary user message text requires the **privileged `MESSAGE_CONTENT` intent**;
  without it `content` is empty except for the bot's own messages, DMs, mentions, and
  message-context-menu targets **[fact:D3]**.
- `MESSAGE_CREATE` events are delivered **only over a Gateway WebSocket connection**
  **[fact:D2]**. There is no push webhook for arbitrary channel messages; the Interactions
  webhook carries only slash-command / component interactions, and the two interaction
  transports are mutually exclusive **[fact:D5]**.
- A Gateway connection has hard liveness obligations: receive Hello, wait
  `heartbeat_interval * jitter`, then heartbeat every interval; track Heartbeat ACKs and, on
  a miss, close with a non-`1000`/`1001` code and reconnect + Resume; Identify is capped at
  **1000 per 24 h** globally; a connection may send at most **120 gateway events per 60 s**
  before immediate disconnect **[fact:D1]**.
- On Cloudflare, an **outbound** WebSocket **does not hibernate**, and "an active outbound
  WebSocket connection keeps the Durable Object alive and prevents eviction **for up to 15
  minutes per connection**" **[fact:C2]**. This is a cap on how long an active outbound
  connection *prevents* eviction — the docs do **not** state that the connection is closed
  or the Durable Object evicted at that point. After that window the normal lifecycle
  applies: hibernation is blocked while a WebSocket is in use, and full eviction otherwise
  occurs ~70–140 s after the object goes idle, discarding in-memory state **[fact:C1]**.
  Alarms can wake an object on a schedule with at-least-once execution **[fact:C3]**, and
  Cron granularity is one minute **[fact:C4]**.

**Therefore the official documentation does not establish a reliability guarantee for a
permanently hosted Cloudflare Gateway client.** Whether a Durable Object can hold a stable
Gateway connection in practice — kept resident by continuous inbound traffic, or
reconnected/Resumed under an alarm loop within the 15-minute window — is an **empirical
question** that this ADR resolves with a spike, not an assumption.

Constraints that bound the options:

- Staging is the default environment; no production action without explicit human approval.
- A Discord **bot account** only. No self-bot; no automation of a normal user account —
  this applies to the service **and** to any spike harness.
- Production registration ingestion **ignores** the application's own messages, other
  bot-authored messages, and webhook-authored messages
  ([architecture.md §3](../architecture.md#author-filtering),
  [architecture.md §5](../architecture.md#channel-and-author-gate)) **[fact:D7]**.
- `MockWhiteoutProvider` in development, tests, and staging; real redemption stays disabled.

---

## 2. Decision drivers

- Preserve the plain-message registration UX.
- Minimise event loss: every `MESSAGE_CREATE` in the registration channel must reach the
  backend, and duplicates must be absorbable.
- Keep as much logic as possible on Cloudflare, testable, and behind the stable
  `DiscordEventSource` boundary defined in [architecture.md §3](../architecture.md#3-discordeventsource--the-ingestion-boundary).
- Minimise operational surface and secret spread.
- Do not force a Cloudflare-only design if the platform docs do not support it.

---

## 3. Options evaluated

### Option 1 — Persistent Gateway client in a Durable Object (`DurableObjectGatewaySource`)

A Durable Object opens the outbound Gateway WebSocket, heartbeats, handles Resume/reconnect,
filters to the registration channel, and calls the Ingestion Worker in-process. An alarm
provides a watchdog / scheduled reconnect.

### Option 2 — External companion Gateway client (`CompanionGatewaySource`) *(provisional reference)*

A minimal always-on process outside Cloudflare holds the single Gateway connection, performs
all liveness handling, filters to the registration channel, and POSTs
`RegistrationMessageEvent` to the Ingestion Worker over authenticated HTTPS. It holds only
its bot token and `INGESTION_SHARED_SECRET`; it has no D1 access and never writes to Discord.
It forwards message `content` even when the registration syntax is invalid, because the
Cloudflare business layer must generate the validation reply.

### Option 3 — Discord application command `/register` (Interactions HTTP webhook on a Worker)

A Worker serves the Interactions Endpoint URL, verifies Ed25519, answers PING with PONG,
responds (or defers) within 3 seconds, and enqueues the registration **[fact:D5]**. Fully
Cloudflare-native and requires no persistent connection — but **changes the requested UX**
from plain messages to a slash command.

### Option 4 — Scheduled REST polling of channel messages

A Cron Worker calls `GET /channels/{id}/messages?after=<last_id>` on a schedule and enqueues
new messages.

---

## 4. Constraints and tradeoffs

| Dimension | Option 1 (DO Gateway) | Option 2 (Companion) | Option 3 (`/register`) | Option 4 (REST poll) |
|---|---|---|---|---|
| Preserves plain-message UX | Yes | Yes | **No** (slash command) | Yes |
| Reliability basis | **Not guaranteed by docs**; 15-min prevent-eviction cap [fact:C2]; eviction discards in-memory session state [fact:C1] | Standard long-lived process; supervised restart | Strong — stateless HTTP, Cloudflare-native [fact:D5] | Weak — polling latency, gaps between polls, ordering/dedupe burden |
| Event-loss window | Unknown until spiked — eviction between alarm cycles, cold-start races | Only while the companion is down (bounded, monitored) | None for submitted commands | Anything created and deleted between polls; `after` cursor gaps |
| `MESSAGE_CONTENT` still required | Yes [fact:D3] | Yes [fact:D3] | **No** (command options are explicit) | Yes — content across the APIs is gated [fact:D3] |
| Heartbeat / Resume handling | In the DO, across evictions — fragile [inference] | In a normal process — well-trodden | N/A | N/A |
| IDENTIFY / 120-per-60 s budget [fact:D1] | At risk if evictions force frequent re-IDENTIFY [inference] | Low risk | N/A | N/A |
| Ops surface | Cloudflare only | Cloudflare **+ one external host** | Cloudflare only | Cloudflare only |
| Secret spread | Bot token in a Worker secret | Bot token + ingestion secret on the external host | Bot token + public key in Worker secrets | Bot token in a Worker secret |
| REST rate-limit pressure | Low | Low | Low | **High** — repeated polling |
| Cost | Low | Low + a small always-on host | Lowest | Low–medium |
| Testability of backend | High (behind `DiscordEventSource`) | High (behind `DiscordEventSource`) | High | High |

---

## 5. What the docs confirm vs. what must be spiked

| Confirmed by docs | Must be observed by a spike |
|---|---|
| Outbound WebSockets do not hibernate; active outbound connection prevents eviction ≤ 15 min per connection **[fact:C2]** | Whether continuous inbound Gateway traffic keeps a DO resident in practice, and for how long |
| Idle DO evicts ~70–140 s after going idle; in-memory state discarded **[fact:C1]** | Whether an alarm-driven reconnect/Resume loop inside the 15-minute window loses zero events across evictions |
| Alarms are at-least-once, retried with backoff **[fact:C3]**; Cron min 1 minute **[fact:C4]** | Cold-start race between an alarm firing and the previous connection's session expiring |
| Resume replays missed events only within session lifetime; else fresh IDENTIFY **[fact:D1]** | Real IDENTIFY/RESUME counts under repeated eviction |

---

## 6. Decision (Proposed, spike-gated)

**Provisional recommendation:** adopt **Option 2 (`CompanionGatewaySource`)** as the
reference topology, because the platform documentation does not guarantee Option 1's
reliability.

**Option 1 is not rejected.** The spike below tests exactly its viability. If the spike
meets its pass thresholds, **Option 1 becomes the recommendation** (fewer moving parts,
fully Cloudflare-hosted, one fewer secret location). If the spike fails or is not run,
Option 2 stands.

**Option 3** is the fallback if the companion is judged undesirable **and** Option 1 fails —
accepting the UX change to a `/register` slash command, plus a manual/bounded re-send path
for anything missed. **Option 4 is rejected**: it still requires `MESSAGE_CONTENT`
**[fact:D3]**, adds latency and REST rate-limit pressure, and has no official
"stream since" semantics, so gaps and duplicates are inherent.

The real `DiscordEventSource` adapter (either implementation) is **not built** until this
spike completes or the maintainers explicitly waive it. Backend phases 1–4 in
[architecture.md §23](../architecture.md#23-phased-implementation-order) proceed against the
`RegistrationMessageEvent` contract alone.

### Spike — reproducible design

**Environment:** the `staging` stack only. `MockWhiteoutProvider` only — **no real Whiteout
Survival access and no real gift-code redemption.** The spike exercises ingestion
reliability, nothing else.

**Duration:** a continuous run of **≥ 72 hours**.

**Sender identity.** Every automated poster and observer in the spike authenticates as a
**dedicated Discord bot account or an incoming webhook**. **No spike component uses a normal
Discord user, a user token, or user automation** — this is non-negotiable and matches the
constraint in [§1](#1-context).

**Staging-only allow-list — reachable at both tiers.** Production ingestion drops bot- and
webhook-authored messages
([architecture.md §3](../architecture.md#author-filtering)). So in the `staging` stack,
`SPIKE_SENDER_ALLOWLIST` (the dedicated spike sender's bot / webhook id(s)) is consulted by
**both** the `DiscordEventSource` and the Ingestion Worker: the source **forwards** an
allow-listed sender's message (flags intact) instead of dropping it — otherwise it would
never reach the Worker — and the Worker re-checks the same list as the **authoritative
gate** and asserts `ENVIRONMENT !== "production"` before reading it. The variable is
**never defined in the production config of either tier**, and it can only ever admit a bot
account or incoming webhook. The production author filter is therefore never weakened.

**Test-message generation.** The dedicated spike bot / webhook posts messages
`SPIKE-<seq>-<uuid>` into a dedicated staging channel at a defined cadence: 1 message/minute
steady, plus a burst of 10 messages within 5 seconds every 30 minutes. Every post is
appended to an **expected-message ledger**: `seq`, `uuid`, post timestamp, and the message
id returned by the poster's Create Message call.

**Independent control.** A second, independent observer — **its own dedicated bot account**
(distinct from the ingestion tier's bot and from the spike poster), running a throwaway
reference Gateway client on a normal always-on host, plus periodic
`GET /channels/{id}/messages` pagination as a cross-check — records every message id it
sees. It never uses a user token. Compared against the ledger and against what the DO source
delivered to `/ingest`:

- **miss** = a ledger entry the DO source never delivered to `/ingest`;
- **duplicate** = the same message id delivered to `/ingest` more than once and **not**
  absorbed idempotently.

**Scenarios exercised during the run:**

1. Idle gap of 20–30 minutes with no channel traffic, then a burst.
2. Forced Worker/DO redeploy mid-run.
3. DO alarm-driven scheduled reconnect.
4. Simulated Gateway disconnect (server close frame) followed by Resume.
5. Simulated non-resumable close (Invalid Session `d=false`) forcing a fresh IDENTIFY.
6. Transient network interruption.
7. Long uninterrupted steady-state stretch (≥ 12 h) with no intervention.

**Instrumentation:** record every IDENTIFY, every RESUME, every close code, every
heartbeat-ACK gap, and every DO constructor invocation, with timestamps.

**Pass thresholds (all must hold):**

- **Zero** missed ledger messages over the full run.
- **Zero** duplicate deliveries that are not absorbed idempotently.
- Every disconnect recovers via **Resume**, except scenario 5 which is deliberately
  non-resumable.
- **≤ 1 unforced fresh IDENTIFY per 24 h** (scenario 5 excluded).
- Total IDENTIFY count recorded and **< 20/day** — far under the 1000/24 h cap
  **[fact:D1]**. RESUME count recorded.
- No unforced heartbeat-ACK gap and no Discord-initiated disconnect outside the deliberate
  scenarios.

**Fail conditions (any one):** a missed ledger message; an unabsorbed duplicate; more than
1 unforced non-resumable reconnect per 24 h; IDENTIFY budget pressure; unforced heartbeat
gaps.

**Reporting rule:** the spike report must **separate observed Cloudflare platform behaviour
during this run from guarantees stated in official documentation.** Observations are
evidence for this decision; they are not platform commitments.

---

## 7. Consequences

### If the spike passes → Option 1

- `DiscordEventSource` is a Durable Object in each stack; no external host; bot token stays
  a Worker secret; `INGESTION_SHARED_SECRET` is unnecessary (in-process call).
- Operational monitoring: DO residency, alarm health, IDENTIFY/RESUME counters.
- Risk accepted: reliance on observed (not documented) residency behaviour; revisit if
  Cloudflare changes eviction timing.

### If the spike fails or is waived → Option 2

- One small always-on external process to run and monitor (host chosen separately —
  **open**). Trust boundary: it is untrusted for business logic and authenticates to
  `/ingest` with `INGESTION_SHARED_SECRET`.
- Cloudflare remains the system of record and the only Discord writer.
- Monitoring: companion liveness/health check, forward error rate, reconnect counters.

### Either way

- The backend, D1 model, queues, operation aggregation, and Discord output are unchanged —
  they depend only on `RegistrationMessageEvent`.

---

## 8. Failure and reconnect considerations

- **Heartbeat:** wait `heartbeat_interval * jitter` before the first heartbeat, then every
  interval; include the last sequence number **[fact:D1]**.
- **Missed ACK:** close with a code other than `1000`/`1001`, reconnect, attempt Resume
  **[fact:D1]**.
- **Resume:** use `session_id` + `resume_gateway_url` + last sequence; no re-Identify
  **[fact:D1]**.
- **Invalid Session:** `d=true` → Resume; `d=false` → fresh connection + Identify
  **[fact:D1]**.
- **Close codes:** `1000`/`1001` invalidate the session (bot appears offline); other/absent
  codes leave the session to time out in a few minutes **[fact:D1]**.
- **Rate/limit budgets:** ≤ 120 gateway events / 60 s; ≤ 1000 IDENTIFY / 24 h;
  `max_concurrency` bounds concurrent IDENTIFY **[fact:D1][fact:D4]**.
- **Intent misconfiguration:** passing `MESSAGE_CONTENT` without enabling it in the
  Developer Portal closes the connection with `4014` **[fact:D3]**.
- **Gateway URL:** obtain from Get Gateway Bot; do not cache it for extended periods
  **[fact:D4]**.

---

## 9. Fallback approach

If the companion is undesirable and Option 1 fails the spike: implement Option 3
(`/register` application command handled entirely by a Worker), accepting the UX change.
Independently of the transport, provide a **manual/bounded re-send path** (operator triggers
a bounded REST catch-up over the registration channel) for events missed during any
ingestion outage.

---

## 10. Official evidence

| Ref | URL | Facts used in this ADR |
|---|---|---|
| D1 | <https://docs.discord.com/developers/events/gateway> | Lifecycle; Hello + `heartbeat_interval`; jittered first heartbeat; Heartbeat ACK and missed-ACK handling; Identify; **1000 IDENTIFY / 24 h**; Resume inputs and "no re-Identify"; resumable vs non-resumable close codes; Invalid Session `d` semantics; `1000`/`1001` behaviour; **120 gateway events / 60 s**; `max_concurrency` |
| D2 | <https://docs.discord.com/developers/events/gateway-events> | `MESSAGE_CREATE` is delivered as a Gateway event; payload shape |
| D3 | <https://docs.discord.com/developers/topics/gateway> | `MESSAGE_CONTENT` is a privileged intent; empty content without it (with the four exceptions); Developer Portal enablement; approval thresholds; `4014` on misconfiguration |
| D4 | <https://docs.discord.com/developers/topics/gateway#get-gateway-bot> | Get Gateway Bot fields; `session_start_limit` incl. `max_concurrency`; do not cache the URL for extended periods |
| D5 | <https://docs.discord.com/developers/interactions/receiving-and-responding> | Gateway vs HTTP-webhook interactions are mutually exclusive; Ed25519 verification; 3-second initial response; deferred responses |
| D7 | <https://docs.discord.com/developers/resources/message> | Message object exposes `author.bot`, `author.system`, `webhook_id`, and `application_id`, which the author filter uses to drop bot / system / webhook / own-application messages |
| C1 | <https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/> | Hibernation preconditions; ~70–140 s idle eviction; in-memory state discarded; `constructor()` re-runs |
| C2 | <https://developers.cloudflare.com/durable-objects/best-practices/websockets/> | "Outgoing WebSockets do not hibernate"; "prevents eviction for up to 15 minutes per connection"; hibernation is server-only |
| C3 | <https://developers.cloudflare.com/durable-objects/api/alarms/> | One alarm per DO; guaranteed at-least-once; ret/backoff; survives restart; `constructor()` before `alarm()` |
| C4 | <https://developers.cloudflare.com/workers/configuration/cron-triggers/> | `scheduled()`; UTC; minimum granularity one minute |
| C5 | <https://developers.cloudflare.com/workers/platform/limits/> | Cron Triggers per account (5 Free / 250 Paid); alarm handler max wall time 15 min |

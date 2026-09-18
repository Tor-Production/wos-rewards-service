# Whiteout Provider Decision

- **Status:** Production redemption is **BLOCKED**
- **Date:** 2026-08-29
- **Owner:** wos-rewards-service maintainers
- **Related:** [architecture.md](architecture.md), [ADR 0001](adr/0001-discord-event-ingestion.md)
- **Architecture detail:** [Redemption state machine and retries](architecture/redemption-state-machine.md) (the `WhiteoutProvider` interface, T1–T16, retry classification), [Summary construction and Discord delivery](architecture/summary-and-delivery.md) (how outcomes are counted and reported), [Configuration](architecture/configuration.md) (`PROVIDER_MODE`, `PRODUCTION_REDEMPTION_ENABLED`, `CODE_DISCOVERY_ENABLED`)

This document is the single place that records what Whiteout Survival access is authorized,
what the provider abstraction may do, and exactly what evidence is required before real
gift-code redemption can be enabled. It contains **no tokens, cookies, or secret values**;
§16 records the sole endpoint authorized for the bounded Task 12 experiment.

**Task 10 research, 2026-09-17:** no acceptable authorized integration contract was found
in the public sources examined. [§10–§15](#10-task-10-public-evidence--2026-09-17) record the
evidence, implementation gaps, isolated-test proposal, and pending decisions. This is
preparation for blocked roadmap phase 8, not completion of it. The four-part §4 gate
remains binding for general integration, except for the narrow Task 12 exception in §16; the staged amendment in §13 is
**proposed, not approved**. Merging this documentation does not authorize provider calls,
production enablement, or credential provisioning.

---

> **Revision 2026-08-30:** provider signature updated to `redeem(player, code,
> idempotencyKey)`; `already_redeemed` is now an explicit success-equivalent terminal
> outcome; the global `redemptions` record is the sole provider-call authority.
>
> **Revision 2026-08-30 (PR #3 review round 2):** terminality is defined **per
> `reason_code`** — `success` / `already_redeemed` immutable; `player_ineligible`
> (state-dependent) auto-reopens when the player's `state` changes; `code_invalid` /
> `code_expired` / operational failures and `retry_exhausted` reopen only via an operator
> `repair_run`. `idempotencyKey` stays stable across reopens so a genuine prior `success` is
> still deduplicated. The DLQ path terminalizes the shared row only for the claim-owning
> attempt (architecture side).
>
> **Revision 2026-08-30 (PR #3 review round 3):** the "claim-owning attempt" is a durable
> `attempt_id`; an owner-path retry keeps it across `message.retry`; the DLQ write is
> guarded on the exact `current_attempt_id`; a `player_ineligible` result whose
> `attempt_state` no longer matches re-drives instead of terminalizing.
>
> **Revision 2026-08-31 (PR #3 review round 4):** the retry-budget identity (`attempt_id`)
> is now separated from a **per-invocation execution claim** (`current_invocation_token` +
> lease). Two overlapping deliveries of one `attempt_id` cannot both call the provider
> (**T3**); a `retryable` result releases the invocation and records `retry_due_at` before
> `message.retry`; a redelivery acquires a new invocation only when none is live and the
> retry is due (**T2**). The DLQ terminal write also requires **no live invocation** (**T10**;
> else **T11** audit-only). The state re-evaluation cap now has an explicit terminal outcome
> **`state_reevaluation_limit`** (**T8**, `repair_run`-only, alerted). The single
> state-transition table is now **T1–T16**. No provider-contract change.
>
> **Revision 2026-08-31 (PR #3 review round 5):** the DLQ "no invocation active" test is
> now taken from `current_invocation_token`, not the pickup-grace deadline. A `retry_wait`
> row (invocation already released by **T9**) always satisfies **T10**, so a retry that
> exhausts `max_retries` **before** its `retry_due_at` is recorded `retry_exhausted`
> instead of being misfiled as `dlq_invocation_active`; the lease-expiry comparison is
> reserved for an `in_progress` row still holding a token. No provider-contract change.

## 1. Current status

Task 12's one-test exception is recorded in §16. It does not enable service redemption.

**No authorized production `WhiteoutProvider` exists.** Production gift-code redemption is
**disabled** and stays disabled until every item in [§4](#4-required-authorization-and-evidence-before-adding-a-real-provider)
and [§5](#5-acceptance-criteria-for-a-production-provider) is satisfied and a maintainer
records explicit approval here.

- `PRODUCTION_REDEMPTION_ENABLED` must be `false` in every environment.
- `PROVIDER_MODE` is `mock` in development, automated tests, and staging.
- If no authorized production provider exists, the service keeps production redemption
  disabled and reports the blocker clearly rather than attempting a real redemption.

---

## 2. Allowed provider-interface responsibilities

`WhiteoutProvider` is the **only** path to Whiteout Survival. Its responsibilities are
limited to:

- **Redeem one gift code for one player:**

  ```ts
  interface PlayerRef { playerId: string; state: string }

  type RedeemResult =
    | { outcome: 'success'; providerReceipt?: string }          // terminal, counts as applied
    | { outcome: 'already_redeemed'; providerReceipt?: string } // terminal, success-equivalent, counts as applied
    | { outcome: 'retryable'; reasonCode: string }
    | { outcome: 'permanent'; reasonCode: string };

  redeem(player: PlayerRef, code: string, idempotencyKey: string): Promise<RedeemResult>;
  ```

  `player.state` is the state carried through the registration contract (user input or
  `DEFAULT_STATE`); the provider uses it as given. `idempotencyKey` is the stable
  per-`(player_id, code)` key from the global `redemptions` record
  ([architecture.md §15.2](architecture/redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority));
  a compliant real provider uses it (or an authorized reconciliation lookup) so a retried
  redemption is a safe no-op. `permanent` outcomes carry a `reasonCode` that the service
  uses to classify terminality and reopen eligibility (see §6 and architecture [§15.2](architecture/redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority)); the
  provider only reports the reason, it does not decide reopen policy.
- **Provider-side rate limiting:** keep requests within the provider's documented limits
  (`PROVIDER_RATE_LIMIT_PER_SECOND`).
- **Error mapping:** translate provider responses into the internal taxonomy
  ([§6](#6-provider-rate-limits-and-error-mapping)).

It **must not**:

- Discover or list gift codes — that is `GiftCodeSource`
  ([§7](#7-gift-code-discovery-source-status)).
- Look up, infer, or "enrich" a player's state, nickname, or any other profile attribute.
  State comes from user input or `DEFAULT_STATE`; the display name comes from user input or
  the `ID <PLAYER_ID>` fallback. `PlayerRef` carries only what the registration contract
  already provided.
- Call any undocumented or unauthorized Whiteout Survival endpoint.

Identifiers passed to and stored by the provider adapter are **canonical strings**
(`playerId`, `code`, `idempotencyKey`) — see
[architecture.md §10](architecture/data-model-and-outbox.md#10-identifier-handling).

---

## 3. `MockWhiteoutProvider` behaviour

`MockWhiteoutProvider` is the default in development, automated tests, and staging. It:

- implements `redeem(player: PlayerRef, code, idempotencyKey)` and returns deterministic,
  configurable outcomes per `(playerId, code)`:
  - `success`,
  - `already_redeemed` (success-equivalent; e.g. when the same `idempotencyKey` is seen
    again, or per fixture),
  - `retryable` for simulated rate limiting (HTTP 429-equivalent) and transient 5xx,
  - `permanent` for invalid, expired, or disabled codes and for ineligible players;
- is **idempotent by construction** — re-invoking `redeem` with the same `idempotencyKey`
  yields a terminal, success-equivalent outcome and applies nothing twice;
- performs no network I/O and holds no secrets;
- supports fixtures that drive the mandated unit tests (validation, deduplication, retry
  classification, message chunking, provider error mapping) and the global-redemption
  serialization tests.

---

## 4. Required authorization and evidence before adding a real provider

All of the following must exist **before** a real provider is implemented:

1. A **human-recorded authorization** in this file: who approved it, the date, and the scope
   (which endpoints, which rate limits, which environments).
2. The **API contract** captured in this file: request/response shapes, authentication
   mechanism, rate-limit rules, error codes, and idempotency semantics — sourced from
   official or explicitly authorized documentation.
3. Explicit maintainer approval, recorded here, to set `PRODUCTION_REDEMPTION_ENABLED=true`
   in production.
4. Production credentials provisioned as Wrangler **secrets**. **Secret name(s) are defined
   only when the contract exists** — this repository does not pre-declare a provider secret
   and makes no assumption that authentication is by API key.

Until items 1–4 are complete, do not add a real provider implementation, do not add a
provider secret name, and do not enable production redemption.

---

## 5. Acceptance criteria for a production provider

A candidate provider is acceptable only if **all** hold:

- **Documented, authorized API** — official documentation, or a written authorization plus a
  recorded contract ([§4](#4-required-authorization-and-evidence-before-adding-a-real-provider)).
- **Redemption idempotency** — the provider supports **a stable redemption idempotency key**
  (so retrying a redemption that already succeeded is a safe no-op) **or** an **authorized
  lookup / reconciliation mechanism** (so the service can determine after a crash whether a
  redemption landed, recorded as `redemptions.provider_receipt`). A provider offering
  **neither does not pass acceptance**, because the global redemption record
  ([architecture.md §15.2](architecture/redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority))
  still cannot rule out a "provider redeemed, Worker crashed before the conditional write"
  double-apply without one. In that case production redemption **remains blocked**. The key
  is **stable across the service's re-evaluations** (a re-registration that reopens a
  `player_ineligible` result keeps `redeem:v1:<player_id>:<code>`), so the provider must
  still deduplicate a genuine prior `success` while accepting a fresh call after a reopened
  non-applied failure.
- **Known, honoured rate limits** — documented and enforced client-side.
- **Mapped error taxonomy** — every provider error maps to `retryable` or `permanent` with a
  reason code ([§6](#6-provider-rate-limits-and-error-mapping)); passes the provider
  error-mapping unit tests.
- **Staging soak with mock parity** — runs in staging against the real API (if permitted) or
  a contract-faithful fake, producing the same `RedeemResult` distribution shape as
  `MockWhiteoutProvider`.
- **Rollback** — a single switch (`PRODUCTION_REDEMPTION_ENABLED=false` / `PROVIDER_MODE=mock`)
  disables it without a deploy.

---

## 6. Provider rate limits and error mapping

The adapter owns a mapping table; the shape below is the contract every provider
implementation must fill in.

| Provider signal (example categories) | Internal outcome | Reason code (example) | Operator action |
|---|---|---|---|
| Redemption applied now | `success` | — | none; store `providerReceipt` if returned |
| Code was already redeemed for this player | **`already_redeemed`** (success-equivalent terminal — **not** a failure) | `already_redeemed` | none |
| HTTP 429 / explicit "rate limited" | `retryable` | `provider_rate_limited` | none — backoff + `Retry-After` |
| HTTP 5xx / gateway / timeout / connection reset | `retryable` | `provider_unavailable` | watch error rate |
| Malformed / rejected request that a retry cannot fix | `permanent` | `provider_bad_request` | investigate adapter |
| Invalid / unknown gift code | `permanent` | `code_invalid` | mark code `disabled` |
| Expired gift code | `permanent` | `code_expired` | mark code `expired` |
| Player not eligible / unknown to the game | `permanent` — **state-dependent** | `player_ineligible` | reported in summary; **T7** re-drive if `attempt_state ≠ players.state` and under `REDEMPTION_MAX_REEVAL`; **T13**/**T15** reopen on a `state` change; **at the cap → T8** (see next row) |
| State re-evaluation cap reached (`player_ineligible` keeps mismatching after `REDEMPTION_MAX_REEVAL` re-drives) | `permanent` — **internal terminal** | **`state_reevaluation_limit`** | operator alert; **`repair_run` only** to reopen; rendered truthfully ("state re-check limit — manual review"), never as `player_ineligible` applying to the current `state` |
| Authentication / authorization failure | `permanent` — operational | `provider_auth_failed` | rotate credentials (human); reopen via `repair_run` only |

Policy:

- **`already_redeemed` counting:** it is a terminal, success-equivalent outcome. In
  operation totals and user-facing Discord summaries it counts toward
  **`applied` (`success` + `already_redeemed`)** and is **never** listed as a failure; a
  summary may add a parenthetical note but the headline count includes it
  ([architecture.md §15.3](architecture/summary-and-delivery.md#153-completion-accounting-and-the-source-freeze),
  [architecture.md §17](architecture/redemption-state-machine.md#17-retry-and-permanent-failure-classification)).
- **Terminality is per `reason_code`** ([architecture.md §15.2](architecture/redemption-state-machine.md#152-global-redemption-record--the-sole-provider-call-authority),
  state-transition table **T1–T16**): `success` / `already_redeemed` immutable (T16);
  `player_ineligible` re-drives when `attempt_state ≠ players.state` while under cap (T7
  in-flight, T13 re-registration, T15 sweeper); **at the cap it terminalizes as
  `state_reevaluation_limit` (T8)** — a terminal failure that finishes the operation,
  reopenable only via `repair_run` (T14); `code_invalid` / `code_expired` /
  `provider_bad_request` / `provider_auth_failed` reopen only via `repair_run` (T14);
  `retry_exhausted` via `repair_run` (or a bounded opt-in sweeper reopen). The provider
  adapter does not decide reopen policy — it only returns the `reason_code`.
- **Backoff:** exponential with jitter, capped at `PROVIDER_MAX_RETRIES` and within Queue
  limits. The durable `attempt_id` carries the retry budget across `message.retry`; a
  per-invocation `current_invocation_token` serializes provider calls, so two overlapping
  deliveries of one `attempt_id` cannot both call the provider (**T3**). A `retryable`
  result executes **T9** (release the invocation, record `retry_due_at`) *before*
  `message.retry`. **T3** contention is **not** a retry and does not consume the budget.
- **Circuit-breaking:** on a sustained burst of `retryable` failures, pause the affected
  consumer and alert; operations continue to age toward their deadline and will finalise
  with a partial summary if needed.
- **`retry_exhausted`:** after an `attempt_id`'s deliveries exhaust their retries the DLQ
  consumer marks the global `redemptions` row `retry_exhausted` on an exact
  `current_attempt_id = message.attempt_id` match when **no invocation is active** (**T10**).
  A `retry_wait` row always qualifies — **T9** already cleared `current_invocation_token`, so
  the future `retry_due_at` and the pickup-grace `invocation_expires_at` are **not**
  consulted; a retry that reaches `max_retries` before it was due is still recorded
  `retry_exhausted`. For an `in_progress` row the consumer additionally requires the token to
  be null or the lease expired. Mirrored `operation_items` rows follow. A stale `attempt_id`
  message (a newer attempt has taken over, **whether or not its lease has since expired**) is
  audit-only `dlq_stale_attempt`; a message that arrives while an `in_progress` invocation is
  still live is audit-only `dlq_invocation_active` (**T11**); neither terminalizes the shared
  row, and the sweeper (**T12**) never re-drives the row **T10** has already terminalized. A
  **T3** contention message never dead-letters. The final summary reports `retry_exhausted`
  as a failure, never a success.

---

## 7. Gift-code discovery source status

**Not authorized / not finalized.**

- Discovery is modelled as the `GiftCodeSource` abstraction
  ([architecture.md §11](architecture/redemption-state-machine.md#11-whiteoutprovider-and-giftcodesource-abstractions)).
  It is disabled (`CODE_DISCOVERY_ENABLED=false`) and has no implementation.
- **Allowed-source criteria** — a source may be implemented only if it is:
  - official, or explicitly authorized in writing and recorded here;
  - backed by a documented contract committed to this repository;
  - compliant with the source's rate limits;
  - free of any Terms-of-Service violation.
- The architecture never assumes scraping, an undocumented game endpoint, or any
  browser-automation technique is permitted.

---

## 8. Explicit prohibition statement

The following are **not authorized** for this service, in any environment, by any component:

- Calling any undocumented or unpublished Whiteout Survival endpoint.
- Scraping web pages or app traffic to obtain codes, player state, or nicknames.
- Using cookies, session credentials, user tokens, or any credential belonging to a Discord
  or Whiteout Survival **user account**.
- Bypassing, solving, or outsourcing CAPTCHAs or other bot-detection.
- Bypassing rate limits, anti-bot protections, authentication, or access controls.
- Implementing a Discord self-bot or automating a normal Discord user account.

Any change to this list requires a human authorization recorded in this file, together with
the supporting contract, before implementation.

---

## 9. Change log

| Date | Change | Approved by |
|---|---|---|
| 2026-08-29 | Initial decision record. Production redemption blocked; mock provider is the default; discovery source unauthorized. | (pending review) |
| 2026-08-30 | Review fixes: `redeem(player: PlayerRef, code, idempotencyKey)` signature; `already_redeemed` is an explicit success-equivalent terminal outcome that counts toward `applied`; the global `redemptions` record is the sole provider-call authority; production still blocked without a stable idempotency key or authorized reconciliation. | (pending review) |
| 2026-08-30 | PR #3 review round 2: terminality defined per `reason_code` — `success` / `already_redeemed` immutable; `player_ineligible` auto-reopens on a `state` change; other `permanent` failures and `retry_exhausted` reopen only via `repair_run`. `idempotencyKey` stays stable across reopens. `retry_exhausted` on the shared row is written only by the claim-owning owner-path attempt; contention is off the retry path. | (pending review) |
| 2026-08-30 | PR #3 review round 3: durable `attempt_id` — an owner-path retry keeps one `attempt_id` across `message.retry`; the DLQ terminal write is guarded on the exact `current_attempt_id`; a `player_ineligible` result whose `attempt_state ≠ players.state` re-drives instead of terminalizing. No provider-contract change. | (pending review) |
| 2026-08-31 | PR #3 review round 4: split `attempt_id` (retry budget) from a per-invocation `current_invocation_token` (+ lease) so two overlapping deliveries of one `attempt_id` cannot both call the provider (**T3**); `retryable` → `retry_wait` release + `retry_due_at` before `message.retry` (**T9**), redelivery acquires a new invocation via **T2**; DLQ terminal write also requires no live invocation (**T10** / **T11**). New terminal outcome **`state_reevaluation_limit`** (**T8**, `repair_run`-only, alerted) for the state re-evaluation cap. Summary source frozen at `summary_state: none → sealing` with late outcomes in `operation_late_results`. Table now **T1–T16**. No provider-contract change. | (pending review) |
| 2026-08-31 | PR #3 review round 5: the DLQ "no invocation active" check reads `current_invocation_token`, not the pickup-grace `invocation_expires_at`. A `retry_wait` row always satisfies **T10** (invocation released by **T9**), so a retry exhausting `max_retries` before `retry_due_at` is recorded `retry_exhausted` rather than `dlq_invocation_active`; the lease-expiry comparison is reserved for an `in_progress` row still holding a token; **T12** never re-drives a row **T10** terminalized. No provider-contract change. | (pending review) |
| 2026-09-17 | Task 10: dated public-source research, code/contract compatibility, mock-result isolation, pending staged-gate amendment, and bounded future-test design (§10–§15). Existing gates and prohibitions unchanged. | Research/documentation task authorized by the requesting human; no provider or amendment approval recorded |

---

## 10. Task 10 public evidence — 2026-09-17

**Finding:** the examined public material does not establish an authorized automated
redemption API or a contract meeting §5. This is a bounded research result, **not proof
that no private, partner, or other API exists**. No publisher permission, API contract,
staging-call approval, or production approval has been obtained in this task.

### Evidence register

All accesses below were on **2026-09-17**. Publication dates are the page's own dates when
visible; search-engine crawl dates are not publication dates. These are public-page reads,
not endpoint probes or redemption attempts.

| ID / direct source | Publisher / authority | Publication or update | Precise supported claim | Limitation |
|---|---|---|---|---|
| E1 — [Whiteout Survival game page](https://www.centurygames.com/games/a/) | Century Games, publisher | Not shown; visible news includes 2026-09-01 | Official game overview and links to player news/community are available. | The inspected page supplies no integration authorization, request schema, or developer contract. |
| E2 — [Whiteout Survival Terms of Service](https://legal.centurygames.com/termsofservice_wos_EN.html) | Century Games, game-specific legal publication | Last updated 2025-07-04 | §2 describes a personal entertainment license and prohibits reverse engineering/source extraction; §9 restricts automation software that violates applicable license agreements. | No affirmative service-integration permission or redemption contract. This is a permission gap, not a legal determination about every possible integration. |
| E3 — [English Terms of Service](https://www.centurygames.com/terms-of-service/) | Century Games | Last updated 2025-07-04 in the retrieved English page | The inspected English page also contains the §2 and §9 restrictions described in E2. | Search results for other language versions showed different dates; this record does not resolve their applicability or infer an exception. |
| E4 — [Whiteout Survival Help Center](https://centurygames.helpshift.com/hc/en/64-whiteout-survival/) | Century Games support on Helpshift | No page update date shown | Public support index exposes gameplay/account categories. | No integration contract found in the index or targeted searches; this does not establish the contents of every support article or private support reply. |
| E5 — [Whiteout Survival — Write A Sentence](https://www.centurygames.com/whiteout-survival-write-a-sentence/) | Century Games | 2026-04-22 | The publisher directs questions to in-game Settings → Contact Us. | A route for the human to request documentation, not evidence that support will authorize an API. No message was sent. |
| E6 — [Gift Code Center](https://wos-giftcode.centurygame.com/) | Century Game domain; page title identifies the gift-code center | Not available | Public page resolves with the title “Gift Code Center.” | Research reader exposed no substantive contract text. No form interaction, scripts, network traffic, or backend requests were inspected. Its existence grants no automation permission. |

### Search coverage and unavailable evidence

Reproducible query examples used on the access date:

- `site:centurygames.com "Whiteout Survival" "API"` and
  `site:centurygames.com "Whiteout Survival" "developer"`;
- `site:whiteoutsurvival.com "API"` and
  `site:whiteoutsurvival.com developer redemption documentation API`;
- `site:wosgame.com developer documentation redemption API`;
- `site:centurygames.helpshift.com "redeem" "code" "Whiteout"` and
  `"Whiteout Survival" "Gift Code" "centurygames.helpshift.com"`;
- `Whiteout Survival official gift code redemption center`, restricted to
  `centurygame.com`, `centurygames.com`, `whiteoutsurvival.com`, and `wosgame.com`.

Results included marketing, gameplay support, unrelated-game code articles, and community
tools, but no acceptable publisher-backed redemption specification. A broader initial
search surfaced [WOS Control API documentation](https://woscontrol.com/api-docs) and
[community bot claims](https://github.com/Gercekefsane/whiteout-survival-bot). These are
**unaccepted leads only**: no Century Games authorization was established; their claimed
technical behavior is not used as contract evidence. No community implementation or
signing method was adopted or tested.

The reader returned zero substantive lines for
[whiteoutsurvival.com](https://www.whiteoutsurvival.com/) and only one line for
[the descriptive game-page URL](https://www.centurygames.com/games/whiteout-survival/);
E1 was an accessible publisher alternative. Opening [wosgame.com](https://www.wosgame.com/)
was rejected by the research tool as unsafe/non-retryable; no workaround was attempted.
[The publisher support portal](https://support.centurygames.com/) exposed only a sparse
shell on direct access, so E4 and E5 supply the usable support references. E6 was similarly
text-inaccessible. No logged-in, private, partner, or application-traffic evidence was
available or requested. Missing material remains unknown, not a negative API guarantee.

## 11. Contract readiness and implementation compatibility

### Contract evidence still required

The §6 taxonomy is an **internal requirement**, not a description of observed game API
responses. Every upstream item below is **unknown** in the accepted evidence set E1–E6.

| Required evidence | Compatibility question / blocker |
|---|---|
| Authorized actions, endpoints and environments | Written publisher authorization must cover this service redeeming on behalf of consenting players and any reconciliation action. Identify sandbox versus live game side effects; a locally named staging stack does not create an upstream sandbox. Profile enrichment and discovery are excluded. |
| Versioned request/response contract | Specify documented methods, fields, encoding, code case/length rules, player/state semantics, response schemas and version policy. Confirm compatibility with string `PlayerRef.playerId`, supplied `state`, and `code`; do not infer state through lookup. |
| Authentication | State the supported service authentication mechanism, scope, expiry/revocation and environment separation. No mechanism or provider secret name is assumed; never supply secret values to this record. User-account cookies/session credentials remain prohibited. |
| Rate limits | Document quotas and windows, burst/concurrency limits, scope (application, credential, IP, player, code or shared account), cooldown/`Retry-After`, and whether lookup/authentication/retry requests count. Current local budgets are not upstream permission. |
| Applied / already applied | Supply exact success and already-redeemed responses, receipt meaning and authoritative player/code attribution. Distinguish accepted/pending from completed; an asynchronous job id alone cannot become `success`. Confirm `already_redeemed` means this pair's reward was applied. |
| Non-applied failures | Supply exact invalid, expired, disabled, player-ineligible and bad-request signals; prove each means no application occurred. Define eligibility dependence on state and code-wide versus player-specific rejection before applying §6 policy. |
| Operational failures | Supply authentication/authorization, rate-limit and transient-error signals and whether side effects may already have occurred. An HTTP status alone cannot establish safe retry semantics. |
| Stable-key idempotency | Specify key format acceptance, scope, retention duration, concurrent replay behavior, response replay, parameter mismatch behavior, and behavior after retention expires. `redeem:v1:<player_id>:<code>` survives attempts, state changes and repairs. A prior success must dedupe, while a reopened non-applied failure must allow fresh evaluation with the same key and possibly changed state. |
| Ambiguous timeout / crash reconciliation | Document a permitted lookup by stable pre-request identity, consistency delay, retention, pending/not-found/final semantics and authoritative evidence of application. A receipt returned only after success cannot resolve a response lost before D1 persistence. Prove when a negative lookup permits replay while an original request might still be running. |

No candidate passes §5 until those gaps are closed. A documented key or lookup must cover
the service's entire permitted retry/reopen horizon; after its retention horizon, unresolved
work must stop for human review, not silently receive a fresh upstream identity.

### Code evidence, inspected 2026-09-17

Inspection base: `bb1fccb20914a84180fb269db8fbb6b5e39b6f01`, tree
`e5bc237f7cf4624a45baf4f1473b96b0d41bb3f9`. PR #12 is merged and Task 09 is included.
The following are repository facts, not evidence of current deployed behavior.

| Source | Verified behavior | Future integration implication |
|---|---|---|
| [Provider interface](../src/domain/whiteout-provider.ts) | `redeem(player, code, idempotencyKey)` returns success/already-redeemed with optional receipt, or retryable/permanent with reason string. | No pending/unknown variant, retry delay, cancellation signal, or reconciliation method exists. Any needed extension requires a separate reviewed task; uncertainty must never be mapped to applied. |
| [Factory](../src/providers/index.ts), [queueWork](../src/runtime/handlers.ts) | Factory accepts only mock. `queueWork` directly constructs `MockWhiteoutProvider` unless a provider is injected; it does not call the factory. | Adding an adapter to the factory alone would not route deployed Queue work. Future routing and disable behavior need end-to-end proof. Injection is a local test seam, not call authorization. |
| [Configuration loader](../src/config.ts), [Wrangler configuration](../wrangler.jsonc) | Only staging/mock is accepted; enabled production redemption and discovery are rejected. Defaults: 10-second provider timeout, 120-second item/redemption leases, four logical grants including the first, three physical retries, three state reevaluations. | These are current local bounds, not safe real-provider settings. Logical budget is captured per generation; state reevaluation or authorized repair can open another generation. A one-test global ceiling must span them all. |
| [Mock provider](../src/providers/mock-whiteout-provider.ts) | Applied keys live in an instance-local map; receipts are deterministic `mock-receipt:` strings; failures do not populate that map; no network access. | Mock behavior is a fixture contract. Neither the map nor its receipts establish upstream idempotency, retention, or reward delivery. |
| [Migration 0001](../migrations/0001_initial_schema.sql), [migration 0002](../migrations/0002_phase4_consumers_and_delivery.sql) | Redemptions use `(player_id, code)` with no provider discriminator. Terminal observations use pair + budget generation; terminal receipts add operation/item identity. | Mock successes/failures can suppress or complete later work and enter summaries. `terminal_receipts` are local accounting receipts, distinct from `redemptions.provider_receipt`; observations do not carry an upstream receipt or provider identity. |
| [Consumer](../src/redemption/consumer.ts), `consume` / `closeBudget` | Exact outbox attempt and item eligibility are rechecked in the grant transaction. A returned grant charges the logical counter before the call; result writes require the exact attempt and invocation token. Stable key is `redeem:v1:<player_id>:<code>`. | This protects local authority and stale writes. A charged but crashed grant is not refunded; these guards cannot undo or dedupe upstream side effects. |
| [Consumer](../src/redemption/consumer.ts), timeout/retry path | `Promise.race` turns timeout or thrown exception into retryable `provider_unavailable`; clearing the timer does not cancel `redeem`. Delay is `min(60 * 2 ** (provider_invocations - 1), 3600)` seconds. | A timed-out call may remain unresolved after the token is released and a retry starts. There is no jitter or provider `Retry-After` input in this path. §6 rate limiting/backoff requirements are not proof of implemented real-provider controls. |
| [Reconciliation](../src/redemption/reconcile.ts), `reuseTerminal` / `mirrorObservation` | Applies current local terminal observations to eligible items with transactional generation/state checks, or writes late audits after freeze. It performs no upstream lookup. | Calling this “reconciliation” must not be mistaken for resolving an uncertain game outcome. Reuse also propagates mock outcomes to later operations. |

Targeted searches found no `PROVIDER_RATE_LIMIT_PER_SECOND` reader or real-provider limiter
in `src`; `AppConfig` has no such field and Wrangler sets none. Queue concurrency one per
queue is not a provider-wide limiter across both queues or other clients. The no-deploy
rollback switch in §5 is an **acceptance requirement**, not an implemented real-provider
kill switch: current configuration is static and rejects any real mode.

The inspected tests substantiate local boundaries: [factory](../test/whiteout-provider.test.ts),
[mock](../test/mock-whiteout-provider.test.ts), [configuration](../test/config.test.ts),
[Phase 4](../test/phase4.test.ts) (four grants, concurrent claims, stale results, reuse),
[review regressions](../test/phase4-review-regressions.test.ts) (outbox authority and terminal
commit), and [staging MVP](../test/staging-mvp.test.ts) (mock distribution and synthetic
delivery). [Migration upgrade assertions](../test/manual-code-migration.test.ts) remain
unchanged. These do not validate a game contract or upstream timeout safety.

**Crash case:** upstream applies the reward, then the response is lost or the Worker exits
before the D1 terminal transaction. The ledger still lacks success. Lease expiry/recovery
can grant another call; fencing only prevents an old local write. An unresolved timeout
creates the same uncertainty even without a process crash. Safe continuation needs either
contract-backed idempotent replay (including in-flight requests) or authorized reconciliation
that proves application/non-application before replay. Client cancellation, even if added,
would not prove upstream cancellation. Current `retry_exhausted` is local accounting, not
proof that no reward was applied. These gaps are recorded, not fixed in Task 10.

## 12. Minimum mock-to-real isolation recommendation

**Proposed minimum for a future approved real test: a separate test stack and fresh ledger,
dedicated to the single approved pair.** Retain the existing mock staging stack and all its
historical records. A fresh code in the existing stack is insufficient: manual distribution
can include every registered player; old outbox/Queue work and observations remain eligible,
and changing provider routing could redirect pending mock work. A receipt prefix changes
neither the primary key nor reuse/summary authority.

The later activation review must prove all of the following before any call:

- Dedicated Worker/routing, D1 binding and empty test ledgers; no copying of mock redemptions,
  gift-code status, manual-command/event ledgers, operations/items, terminal observations or
  receipts, late results, frozen snapshots, summary layouts, output deliveries, scheduler
  progress or dispatch state. Seed only the approved player/state and manually supplied code.
- Separate registration/fanout queues and DLQ, with no existing producers, consumers, backlog,
  retry, replay or recovery path crossing from mock staging. Cron and ingress stay off until
  specifically needed and approved. Hardcoded Queue routes in `queueWork` need a reviewed
  isolation design; changing only resource names is not an implementation plan that works today.
- One explicit provider route for test work, no automatic fallback to mock after a real
  failure, and an enforceable one-player/one-code allowlist and total request ceiling.
  All game traffic must still pass through `WhiteoutProvider` and durable call authority.
- Separate credentials with documented scope if the contract requires them; provision only
  under a later approval, never copied from user sessions or another environment. No Discord
  delivery is needed for the first provider test. If later approved, use a separate test
  application/channel and unmistakably identify test evidence without claiming mock rewards.
- Verify resource bindings, empty pending work and disable behavior with fakes first; retain
  the real test's ledger afterward for audit and uncertainty resolution. Do not reset it to
  obtain a fresh retry allowance. Local isolation does not isolate upstream player rewards.

If shared storage or mock/real switching within one stack is later required, first design
explicit provider/environment provenance across identities, grants, observations, receipts,
outbox/Queue routing, repair, reuse and frozen summaries, with an additive migration and
historical-data policy. That is larger than the first isolated test. Neither this proposal
nor this task authorizes migration, provisioning, deletion, or changes to historical outcomes.

## 13. Pending staged-gate amendment

Task 12 is separately authorized by the narrower §16 exception; this proposal remains pending.

**Current binding rule:** §4 requires all four items before any real-provider implementation:
human-recorded authorization, documented API contract, explicit production-enablement
approval, and production credentials provisioned as secrets. They are not complete. Its
wording does not permit an offline or staging adapter merely because production stays off.

**Proposed amendment text — NOT ACCEPTED:** replace §4's all-stages prerequisite with the
stage-specific prerequisites below **only after an explicit human maintainer acceptance is
recorded here**. Publisher authorization establishes external rights; maintainer approval
establishes repository/operational scope. Neither substitutes for the other. Preserve §5's
production acceptance criteria and §8's prohibitions. Production approval and production
credential provisioning would move to stage D; they would not be waived. Approval of any
stage does not imply approval of the next stage.

| Stage | Required evidence and approver | Allowed actions | Exit criteria and remaining prohibitions |
|---|---|---|---|
| A — public research/documentation | Human task authorization; attributable public sources | Read public documentation, assess compatibility, draft unsent questions and pending proposals | Deliver evidence/gaps and recommendation. No real adapter, endpoint probing, form interaction, game requests, credentials, provisioning or activation. Task 10 is stage-A work under existing rules. |
| B — contract-backed offline implementation | Explicit maintainer acceptance of this amendment and separate B task approval; recorded publisher authorization for intended integration; versioned contract closing §11 safety questions | Implement the specifically approved adapter/contract slice using injected fake transport with external network denied; sanitized contract fixtures and local tests only | Pass outcome, idempotency/reopen, unknown-outcome, rate-limit and crash tests relevant to the slice; record remaining activation gaps. No real requests, real credentials, runtime selection, deployment, resource provisioning or production enablement. |
| C — narrowly approved staging activation | B evidence; publisher permission for the exact upstream environment/actions; consenting test-player approval; explicit maintainer/operator approval for exact resources, revision, pair, window, numeric ceilings and rollback plan | Only separately approved provisioning, secret entry, deployment and bounded calls in the isolated stack; actions may be approved in smaller gates | Record authoritative outcomes and request accounting, then disable; unresolved outcome remains unresolved. No wider fanout, discovery, production rollout, prohibited authentication or bypass. A staging caller against the live game still needs real-redemption approval. |
| D — production rollout | All §5 criteria, C evidence, publisher production scope, explicit maintainer production-enablement and rollout approval; production credentials provisioned as secrets after the contract defines names/mechanism | Only approved production provisioning/migrations/deployment/activation within rollout bounds | Reviewed operational evidence, monitored ceilings and tested disable procedure. No discovery or scope expansion by implication; separate approval is required for each. |

No acceptance is inferred from a PR merge, a checked box, a test passing, or Task 09's
mock-only smoke. Until explicit amendment acceptance, the original §4 gate controls B–D.
If the publisher contract requires no credentials, resolve that conflict with current §4
explicitly; do not silently mark its credential item satisfied or invent a secret.

### Pending approval / evidence record template

Copy a record per decision; empty fields mean **pending**, never approved. Do not include
secret values. A resource/credential action needs its own explicit permitted-action entry.

| Field | Pending value |
|---|---|
| Decision / status | Amendment acceptance, B implementation, C action gate, or D rollout / PENDING |
| Approver and authority | Named human maintainer/operator; publisher representative and authority where relevant; test-player consent reference |
| Recorded date / expiry | UTC timestamp and authorized window, not yet supplied |
| Scope / environment | Service, revision, exact local stack and upstream environment, player/code approval reference |
| Permitted actions | Explicit implementation, provisioning, secret-entry, deployment, redemption or reconciliation actions; nothing inferred |
| Limits | Total and per-action request ceilings, retry/reconciliation counts, rate/concurrency, timeouts and duration |
| Supporting source / contract | Version/date, direct documentation or written authorization reference, retention and outcome guarantees |
| Exit / abort / disable | Operator, authoritative evidence, abort conditions, disable procedure and unresolved-outcome handling |
| Exclusions / remaining gates | Discovery, profile enrichment, production unless specifically approved; §8 prohibitions retained |

## 14. Later one-pair test design — not executable yet

Subject to §4 or an explicitly accepted §13 amendment, test **one consenting, explicitly
approved real player and one manually supplied code**. No participant or code is selected
here. The maintainer must record the exact pair privately or by an approved non-secret
reference, the contract version, test revision, operator and window before execution.

1. **Prepare offline:** prove §12 isolation, exact allowlist, request accounting, disabled
   discovery/Discord delivery and fail-closed provider routing. Use fakes to simulate all
   failures, duplicate delivery, crash after upstream application, and a response later than
   timeout. Do not deliberately crash during the real test.
2. **Approve a complete ceiling:** the preferred first run has at most **one redemption
   submission and zero automatic redemption retries**, plus at most `L` authorized
   reconciliation requests and `A` required authentication requests: total `N = 1 + L + A`.
   `L`, `A`, `N`, per-scope rate/concurrency, overall duration and timeout remain **unset and
   unapproved** until the contract specifies the request sequence, consistency/polling
   interval, idempotency retention, authentication lifecycle and applicable quotas. If no
   network authentication is required, record `A=0`; do not assume it. Count every physical
   request, including failures, redirects if permitted, hidden SDK retries and polls. No
   retry/reopen/repair may reset the run ceiling. Additional redemption retries require a
   revised explicit numeric ceiling and proven safe-replay semantics before starting.
3. **Contain entry and calls:** after separately approved provisioning/deployment, verify
   exact bindings and zero unrelated work. Permit only the approved pair; no companion
   restart or all-player manual distribution in the existing staging stack. Enforce the
   run budget before each network request. Current four-grant configuration alone cannot
   enforce this complete request ceiling or count reconciliation requests.
4. **Timeout and abort:** choose the timeout and longer lease from documented upstream
   behavior, with no assumption that local timeout cancels application. On timeout, crash,
   unexpected schema, auth failure, CAPTCHA/anti-bot challenge, rate-limit response,
   isolation mismatch, expired authorization or exhausted ceiling, stop new redemption
   submissions. Only separately preapproved reconciliation within the remaining budget may
   continue. Pending/not-found is not non-application unless the contract guarantees it.
5. **Evidence and completion:** retain sanitized contract response/receipt or authorized
   lookup evidence tied to the exact player/code and upstream identity, timestamps, physical
   request counts, local grant/terminal records and operator decision. Require the player's
   manual in-game confirmation as corroboration, without account automation. Pass only with
   contract-authoritative applied/already-applied evidence and consistent accounting;
   otherwise record not-applied or unresolved as supported. Mock receipts, local terminal
   receipts and Discord summaries are never authoritative game-outcome evidence.
6. **Disable and preserve:** exercise a reviewed fail-closed control that stops new real
   calls before the test; on completion/abort use it, stop test ingress/producers/consumers
   and recovery/Cron execution as specified in the approved runbook, and retain pending
   messages and ledger evidence without replay. Do not switch unresolved real work to mock,
   erase history, or claim disablement reverses a reward already applied. The operator must
   verify no new requests and resolve in-flight uncertainty by the contract or publisher
   support. Implementing/testing this control is a prerequisite; it does not exist today.

The one-submission preference does not relax §5's idempotency/reconciliation criterion:
even a single request can succeed upstream while its local outcome remains unknown.

## 15. Recommended path, blockers and next slice

**Recommend publisher authorization and contract acquisition, followed by offline validation
under an explicitly accepted staged gate.** Keep mock mode and real redemption blocked
while waiting. Public-site automation and community adapters are not acceptable substitutes
for missing permission; indefinite unbounded exploration is not required to complete Task 10.

Exact blockers, in order:

1. Publisher permission and a versioned contract covering every §11 unknown, particularly
   in-flight replay, retention, reopened non-applied failures and post-crash reconciliation.
2. Human decision on the proposed §13 amendment. Without acceptance, **all four original
   §4 requirements still precede implementation**, including production approval and secrets.
3. Separate approval of a bounded offline implementation task. Activation additionally
   requires routing/timeout/limiter/unknown-outcome controls, request accounting and §12
   isolation proof; none is supplied by adding a class alone.
4. Explicit C approvals, player consent and settled numeric test limits before any real
   request; independent D evidence/production approvals afterward. Resource availability
   and any publisher sandbox remain unknown and must be checked within that later scope.

**Draft request for the human to send through publisher support — not sent by this task:**

> We maintain a Discord service that would redeem a manually supplied gift code for a
> consenting Whiteout Survival player. Is service-to-service automated redemption permitted?
> Please provide written scope and official or explicitly authorized, versioned documentation
> for supported redemption and post-timeout reconciliation actions and environments. We need
> request/response schemas; supported service authentication without sharing secret values;
> quotas, scope and cooldown rules; precise applied, already-applied, invalid/expired,
> ineligible, auth, rate-limit and transient-error outcomes; stable idempotency-key scope,
> retention and concurrent replay behavior; handling of reopened non-applied failures with
> changed state; and an authoritative way to resolve a request whose response was lost.
> Is a sandbox available, or may one approved live player/code pair be tested under an agreed
> request ceiling? We will not use user-session credentials, reverse engineering, scraping,
> CAPTCHA bypass or undocumented calls. No access is requested to discover codes or enrich
> player profiles. If this integration is unsupported, please confirm that limitation.

**Maintainer decision requested later:** record the publisher response/contract and explicitly
accept or reject §13; if accepted and evidence is complete, authorize B's smallest slice.
No secret values are requested. PR merge is a separate documentation review decision.

**Smallest subsequent implementation slice, conditional on those prerequisites:** an offline,
unwired `WhiteoutProvider` adapter contract slice using injected fake transport: validate one
documented request, map documented terminal/nonterminal responses, preserve the stable key,
and prove safe replay/reopen and ambiguous-timeout behavior with contract fixtures. Include
only contract-required type/error changes and tests; if the contract cannot fit the current
taxonomy safely, first review that narrowly scoped contract change. Keep the runtime factory,
Queue path and configuration mock-only; no real credentials, network calls or activation.
Later slices must separately address limiter/request budgets, routing/disable controls and
isolated staging resources. Do not start dependent work before this PR is merged and the
specific implementation gates are satisfied.

Task 09's deployed-version, migration, companion-shutdown and test-count records are
**historical evidence**, not reverified here; its smoke proved mock operation, not game
redemption. Automatic discovery remains separately unauthorized. ADR 0001 remains
**Proposed**, with its 72-hour spike **deferred, not passed or waived**. Task 10 makes no
runtime, schema, generated-type, test, dependency or configuration change.

## 16. Task 12 — bounded local live experiment, 2026-09-18

### Human authorization recorded before implementation

The user supplied the revised Task 12 execution brief on 2026-09-18, expressly authorizing
one real redemption submission for one explicitly consenting account and one manually supplied
code. The user reports firsthand, from regularly using the current flow, that it needs no
CAPTCHA. This is dated human verification, not merely a README claim; it does not exclude
challenges on other paths or in the future.

This is a one-test exception to the blanket prerequisites in §§4 and 8 and the not-yet-
executable design in §14. It authorizes a small original local driver and experimental
WhiteoutProvider wrapper before any PR merge. Production enablement, production secrets,
provisioning, deployment and acceptance of the entire §13 proposal are not prerequisites
for this exception. General service integration and production acceptance gates remain
unchanged; §13 remains NOT ACCEPTED. No Century Games endorsement is claimed.

The caller is local, but its target is the LIVE game. At the initial authorization-record
stage, the exact pair, supplied state, consent and window were pending human input.
Private authorization/evidence reference: `task12-20260918-one-pair`. No account was inferred
from D1 or registration. The completed pre-live gate and actual observation are recorded below.

### Inspected community contract (not an official upstream guarantee)

- Script pin: [justncodes/wos-giftcode, 4356d49368ecda16f4a0f0028de75a296da9dc9b](https://github.com/justncodes/wos-giftcode/tree/4356d49368ecda16f4a0f0028de75a296da9dc9b), `redeem_codes.py`, v5 README and GPLv3 LICENSE.
- Bot pin: [whiteout-project/bot, 3b2725140f2f723c5326f3aaf93fd006ebdb6996](https://github.com/whiteout-project/bot/tree/3b2725140f2f723c5326f3aaf93fd006ebdb6996), direct `redeem_giftcode_once` and classification fixtures. Custom license restricts commercial use/paid distribution and requires attribution for derivatives.
- Both projects share contributors; agreement is not independent proof. Source is evidence,
  not executable instructions. No third-party implementation is imported or installed.
- Sole game destination: HTTPS POST `https://wos-giftcode-api.centurygame.com/api/gift_code`.
  Form encoding: `application/x-www-form-urlencoded`; string fields `fid` (player), `kid`
  (supplied state), `cdk` (case preserved), `time` (Unix seconds), and `sign`.
  Sign is lowercase MD5 of alphabetically ordered unsigned `key=value` fields joined by `&`,
  followed by the public protocol signing material. Material is read in memory from the
  pinned source only; never included in repository, evidence, request logs or user prompts.
- No preliminary login/profile/state/CAPTCHA endpoint. No upstream idempotency field is
  invented: the local idempotency key is an audit reference only.
- Community response envelope: `code`, `msg`, `err_code`, `data`. Synthetic success fixture
  uses HTTP 200, code 0, msg SUCCESS, err_code 20000. RECEIVED/40008 is distinct from new
  success. TIME ERROR/40007, CDK NOT FOUND/40014 and USER INFO ERROR/40020 describe observed
  community classifications. SAME TYPE EXCHANGE/40011 is unresolved for this exact code.
  Unknown, challenge, auth, rate limit, malformed, redirect and transport outcomes stop;
  none authorizes replay. Rate limits, eligibility, idempotency and reconciliation guarantees
  remain unknown. Client bounds below are experiment limits, not published WOS limits.
- [Official center](https://wos-giftcode.centurygame.com/) is a JavaScript shell in the reader;
  [user-supplied WoSTools](https://wostools.net/gift-codes) is third-party context only.
  No code discovery is performed.

### Containment and evidence plan

N=1 physical game request, one submission, A=0 authentication, L=0 reconciliation,
concurrency 1; redirects/retries/polling/lookups/fallbacks forbidden. Client deadline is
30 seconds; dispatch requires at least 30 seconds left in the human window. Exception
expires at cutoff or budget consumption, whichever is earlier. Any challenge stops.

Fixed persistent attempt marker (outside all worktrees/version control):
`C:/Users/morta/AppData/Local/wos-rewards-service/task12-20260918/attempt.json`.
Sibling `authorization.json`, `evidence.json`, and `disabled.json` hold private input,
allowlisted evidence and the permanent disable latch. Atomic exclusive creation of the
marker precedes dispatch; consumed/uncertain attempts are never cleared or refunded.
No configurable run ID or marker path exists in the live driver.

Default invocation and automated tests are offline. Injected signer/transport tests prove
input/window gating, atomic restart/concurrency protection, one request only, timeout
uncertainty and redaction. The wrapper stays outside `src` and imports only provider types.
Runtime factory/configuration/Queue remain mock-only; the experiment never invokes the Worker,
companion, Cron, Queues, D1, Discord or Telegram and never reinterprets mock successes.

Sanitized evidence records source and harness digests, UTC times, private pair reference,
HTTP status, allowlisted response fields, request accounting, marker state and stop reason.
Raw bodies, signed forms, headers, arbitrary exception messages and account data are omitted.
Human in-game mail confirmation is separate from the API observation and currently pending.
After attempt or explicit abort, permanently disable this invocation and retain evidence.

Source-inspection incident: the first redaction filter missed the publicly embedded signing
constant and it appeared in tool output. It was not written to repository files; subsequent
inspection suppresses all key assignments. No constant value is reproduced in this record.

### Pre-live gate recorded 2026-09-18T01:42:11Z

The user supplied the exact pair/state privately, then explicitly confirmed ownership,
unredeemed status and reservation, and authorized the next 30 minutes. Reference:
`task12-20260918-one-pair`. Window: 2026-09-18T01:42:11Z through
2026-09-18T02:12:11Z. Reported code validity is September 20 at 23:59 with timezone unknown;
no UTC expiry is invented. The shorter explicit window controls dispatch.

Pre-live harness SHA-256 (ordered filename + NUL + bytes for probe.ts, transport.ts,
driver.ts, probe.test.ts, tsconfig.json, vitest.config.ts):
`8684ccc844bf9d466084456faa9eaab41a872a661420233703d57a538411f2b7`.
Base SHA: `496e63916bd6304f49e01167ec846878d72c1d42`.
`npm run test:probe`: exit 0, strict compilation, 39/39 synthetic tests passed.
Default driver: exit 0, offline notice only. `git diff --check`: exit 0.
Source/runtime inspection found no experiment reference in src, companion or Wrangler.
Synthetic request inspection verifies POST, exact endpoint, form fields and seconds; no
upstream idempotency field. Full repository checks started independently and do not gate
this expiring-code dispatch. N=1, A=0, L=0, concurrency 1, deadline 30 seconds unchanged.

### Live observation and shutdown

One physical HTTPS redemption request was dispatched at **2026-09-18T01:42:59.362Z**;
the driver finished at **2026-09-18T01:43:00.004Z**. HTTP status: **403**. Allowlisted response
fields: none. The transport could not provide the expected JSON envelope, so the original
pre-live classifier recorded `unexpected_schema`. This is an unresolved experiment error,
not a permanent player/code failure, proof of application, or proof of non-application.
403's cause is unknown; no auth/signature correction, browser impersonation, CAPTCHA handling,
additional endpoint, or second request was attempted. The user was asked to inspect in-game
mail without submitting again. Human confirmation remains pending as of this record.

Public source-content SHA-256 observed in memory:
`dfed6b68f312eaaabee766f9202bb47a7ceac44a58fc01222994e8f4f743ae75`.
Harness digest matches the pre-live gate. Physical game requests: **1**; authentication: **0**;
reconciliation: **0**; retries/redirects: **0**. The persistent marker was consumed before
submission and remains in place. `disabled.json` is present with `disabled: true`.
A process inspection found no running Task 12 driver. No background job was created.
No further live calls are allowed under this consumed authorization, including other accounts.

Private evidence is retained at the fixed location above, with raw payloads/responses omitted.
No successful redemption, upstream deduplication, quotas, eligibility guarantee, safe replay,
production readiness or publisher endorsement was established. The narrower caller did not
use source clients' rotating browser headers or retries. This observation does not contradict
the user's firsthand report that their regularly used flow needs no CAPTCHA.

External actions for this task: GitHub read/fetch; reads of the pinned public GitHub source
and license files and public website pages; locked npm dependency download; the one game
POST; and the authorized branch push/draft PR when completed. No Cloudflare resource change,
deployment, migration, production enablement, Discord/Telegram message or game-account login.
The full offline check suite may use local Wrangler dry-run validation; this does not deploy.

### Offline validation and review handoff

- `npm run test:probe`: exit 0; strict experiment TypeScript compilation and **39/39** tests.
- `npm run check`: exit 0. Formatting and Wrangler type freshness/strict Worker, test,
  companion TypeScript checks passed; experiment **39/39**; deterministic Workers **575/575
  across 44 files**, companion **26/26 across 3 files**; shuffled Workers **575/575** with
  seed `1789695873946`, companion **26/26** with seed `1789695999901`; staging dry-run passed.
- `npm run test:mvp`: exit 0; Workers **12/12 across 4 files**, companion **26/26 across 3 files**.
- `git diff --check` and staged diff check: exit 0. Staged-scope scan found no signing
  constant or private approved pair values. Default driver invocation made zero requests.
- Wrangler emitted missing-local-secret warnings during synthetic tests; no secrets were
  requested or provided. All required commands passed without weakening assertions.
- Harness source digest is unchanged from the pre-live gate. Final documentation updates
  report this observation and validation; runtime code, schema and provider selection are unchanged.

Branch: `codex/12-live-provider-probe`. Absolute worktree:
`C:/Users/morta/AppData/Local/Temp/wos-rewards-service-12-live-provider-probe`.
Base: `496e63916bd6304f49e01167ec846878d72c1d42`; original checkout remains clean on
`codex/09-live-staging-mvp`. Changed files: this decision, `docs/README.md`, `package.json`,
root `vitest.config.ts`, and `experiments/task12/{README.md,driver.ts,probe.ts,probe.test.ts,
transport.ts,tsconfig.json,vitest.config.ts}`. The draft PR is the focused review diff.
Head/tree SHAs and PR URL are supplied in the task's final handoff to avoid self-referential
commit metadata. No actual task deeplink was exposed; none is invented.

Next action: return to the existing orchestration task for review; fixes and any later human
mail confirmation belong in this same Task 12 branch/PR. A further real request requires new
specific authorization and a new bounded request budget; this consumed test cannot be replayed.
No merge, deploy, production change or second task implementation is authorized by this handoff.

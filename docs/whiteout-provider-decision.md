# Whiteout Provider Decision

- **Status:** Production redemption is **BLOCKED**
- **Date:** 2026-08-29
- **Owner:** wos-rewards-service maintainers
- **Related:** [architecture.md](architecture.md), [ADR 0001](adr/0001-discord-event-ingestion.md)
- **Architecture detail:** [Redemption state machine and retries](architecture/redemption-state-machine.md) (the `WhiteoutProvider` interface, T1–T16, retry classification), [Summary construction and Discord delivery](architecture/summary-and-delivery.md) (how outcomes are counted and reported), [Configuration](architecture/configuration.md) (`PROVIDER_MODE`, `PRODUCTION_REDEMPTION_ENABLED`, `CODE_DISCOVERY_ENABLED`)

This document is the single place that records what Whiteout Survival access is authorized,
what the provider abstraction may do, and exactly what evidence is required before real
gift-code redemption can be enabled. It contains **no real endpoints, tokens, cookies, or
secret values.**

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

# Whiteout Provider Decision

- **Status:** Production redemption is **BLOCKED**
- **Date:** 2026-08-29
- **Owner:** wos-rewards-service maintainers
- **Related:** [architecture.md](architecture.md), [ADR 0001](adr/0001-discord-event-ingestion.md)

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
  ([architecture.md §15.2](architecture.md#152-global-redemption-record--the-sole-provider-call-authority));
  a compliant real provider uses it (or an authorized reconciliation lookup) so a retried
  redemption is a safe no-op. `permanent` outcomes carry a `reasonCode` that the service
  uses to classify terminality and reopen eligibility (see §6 and architecture §15.2); the
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
[architecture.md §10](architecture.md#10-identifier-handling).

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
  ([architecture.md §15.2](architecture.md#152-global-redemption-record--the-sole-provider-call-authority))
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
| Player not eligible / unknown to the game | `permanent` — **state-dependent** | `player_ineligible` | none — reported in summary; **auto-reopens** on a re-registration that changes `players.state` |
| Authentication / authorization failure | `permanent` — operational | `provider_auth_failed` | rotate credentials (human); reopen via `repair_run` only |

Policy:

- **`already_redeemed` counting:** it is a terminal, success-equivalent outcome. In
  operation totals and user-facing Discord summaries it counts toward
  **`applied` (`success` + `already_redeemed`)** and is **never** listed as a failure; a
  summary may add a parenthetical note but the headline count includes it
  ([architecture.md §15.3](architecture.md#153-completion-accounting),
  [architecture.md §17](architecture.md#17-retry-and-permanent-failure-classification)).
- **Terminality is per `reason_code`** ([architecture.md §15.2](architecture.md#152-global-redemption-record--the-sole-provider-call-authority)):
  `success` / `already_redeemed` immutable; `player_ineligible` auto-reopens on a `state`
  change (guarded, capped by `REDEMPTION_MAX_REEVAL`); `code_invalid` / `code_expired` /
  `provider_bad_request` / `provider_auth_failed` reopen only via operator `repair_run`;
  `retry_exhausted` via `repair_run` (or a bounded opt-in sweeper reopen). The provider
  adapter does not decide reopen policy — it only returns the `reason_code`.
- **Backoff:** exponential with jitter, capped at `PROVIDER_MAX_RETRIES` and within Queue
  limits. Lease contention on the global `redemptions` record is **not** a retry and does
  not consume the retry budget.
- **Circuit-breaking:** on a sustained burst of `retryable` failures, pause the affected
  consumer and alert; operations continue to age toward their deadline and will finalise
  with a partial summary if needed.
- **`retry_exhausted`:** after an **owner-path** attempt's retries are exhausted the message
  dead-letters and the DLQ consumer marks the global `redemptions` row `retry_exhausted`
  **only when that attempt still owns the claim** (`claim_token` + `attempt_generation`
  match, row still `in_progress`); mirrored `operation_items` rows follow. A contention /
  non-owning message never dead-letters and never terminalizes the shared row. The final
  summary reports `retry_exhausted` as a failure, never a success.

---

## 7. Gift-code discovery source status

**Not authorized / not finalized.**

- Discovery is modelled as the `GiftCodeSource` abstraction
  ([architecture.md §11](architecture.md#11-whiteoutprovider-and-giftcodesource-abstractions)).
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

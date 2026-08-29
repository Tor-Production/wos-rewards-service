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

## 1. Current status

**No authorized production `WhiteoutProvider` exists.** Production gift-code redemption is
**disabled** and stays disabled until every item in [§4](#4-required-authorization-and-evidence)
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

- **Redeem one gift code for one player:** `redeem(playerId: string, code: string)` →
  a structured `RedeemResult` (`success` | `retryable` + reason | `permanent` + reason).
- **Provider-side rate limiting:** keep requests within the provider's documented limits
  (`PROVIDER_RATE_LIMIT_PER_SECOND`).
- **Error mapping:** translate provider responses into the internal taxonomy
  ([§6](#6-provider-rate-limits-and-error-mapping)).

It **must not**:

- Discover or list gift codes — that is `GiftCodeSource`
  ([§7](#7-gift-code-discovery-source-status)).
- Look up, infer, or "enrich" a player's state, nickname, or any other profile attribute.
  State comes from user input or `DEFAULT_STATE`; the display name comes from user input or
  the `ID <PLAYER_ID>` fallback.
- Call any undocumented or unauthorized Whiteout Survival endpoint.

Identifiers passed to and stored by the provider adapter are **canonical strings**
(`player_id`, `code`) — see [architecture.md §10](architecture.md#10-identifier-handling).

---

## 3. `MockWhiteoutProvider` behaviour

`MockWhiteoutProvider` is the default in development, automated tests, and staging. It:

- returns deterministic, configurable outcomes per `(playerId, code)`:
  - `success`,
  - `retryable` for simulated rate limiting (HTTP 429-equivalent) and transient 5xx,
  - `permanent` for invalid, expired, or disabled codes and for ineligible players;
- is **idempotent by construction** — re-invoking `redeem` with the same arguments yields
  the same outcome and applies nothing twice;
- performs no network I/O and holds no secrets;
- supports fixtures that drive the mandated unit tests (validation, deduplication, retry
  classification, message chunking, provider error mapping).

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
  recorded contract ([§4](#4-required-authorization-and-evidence)).
- **Redemption idempotency** — the provider supports **a stable redemption idempotency key**
  (so retrying a redemption that already succeeded is a safe no-op) **or** an **authorized
  lookup / reconciliation mechanism** (so the service can determine after a crash whether a
  redemption landed). A provider offering **neither does not pass acceptance**, because the
  claim-and-lease protocol
  ([architecture.md §15](architecture.md#item-claim-and-lease-before-any-provider-call))
  cannot rule out a "provider redeemed, Worker crashed before recording" double-apply
  without one. In that case production redemption **remains blocked**.
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

| Provider signal (example categories) | Internal class | Reason code (example) | Operator action |
|---|---|---|---|
| HTTP 429 / explicit "rate limited" | `retryable` | `provider_rate_limited` | none — backoff + `Retry-After` |
| HTTP 5xx / gateway / timeout / connection reset | `retryable` | `provider_unavailable` | watch error rate |
| Malformed / rejected request that a retry cannot fix | `permanent` | `provider_bad_request` | investigate adapter |
| Invalid / unknown gift code | `permanent` | `code_invalid` | mark code `disabled` |
| Expired gift code | `permanent` | `code_expired` | mark code `expired` |
| Player not eligible / unknown to the game | `permanent` | `player_ineligible` | none — reported in summary |
| Already redeemed for this player | `permanent` (treated as success-equivalent) | `already_redeemed` | none — idempotent outcome |
| Authentication / authorization failure | `permanent` | `provider_auth_failed` | rotate credentials (human) |

Policy:

- **Backoff:** exponential with jitter, capped at `PROVIDER_MAX_RETRIES` and within Queue
  limits.
- **Circuit-breaking:** on a sustained burst of `retryable` failures, pause the affected
  consumer and alert; operations continue to age toward their deadline and will finalise
  with a partial summary if needed.
- **`retry_exhausted`:** after retries are exhausted the message dead-letters and the
  `operation_items` row is marked `retry_exhausted`; the final summary reports it as a
  failure, never a success.

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

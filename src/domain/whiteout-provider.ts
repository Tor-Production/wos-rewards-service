/**
 * Provider contracts owned by `docs/architecture/redemption-state-machine.md` section 11.
 *
 * All Whiteout Survival access goes through `WhiteoutProvider`. No authorized production
 * implementation exists, and none may be added until every item in
 * `docs/whiteout-provider-decision.md` sections 4 and 5 is satisfied and recorded there.
 */

/**
 * A player as the registration contract already knows them.
 *
 * `state` is what the user supplied or the configured `DEFAULT_STATE`. A provider must use it
 * as given: it must never look up, infer, or enrich a player's state or nickname
 * (`docs/whiteout-provider-decision.md` section 2).
 */
export interface PlayerRef {
  playerId: string;
  state: string;
}

/**
 * The outcome of one redemption attempt.
 *
 * `success` and `already_redeemed` are both terminal and immutable, and both count as
 * applied; `already_redeemed` is success-equivalent and is never reported as a failure.
 * `reasonCode` on the failure variants classifies terminality and reopen eligibility; the
 * provider only reports the reason, it never decides reopen policy.
 */
export type RedeemResult =
  | { outcome: "success"; providerReceipt?: string }
  | { outcome: "already_redeemed"; providerReceipt?: string }
  | { outcome: "uncertain"; reasonCode: "outcome_uncertain" }
  | { outcome: "retryable"; reasonCode: string }
  | { outcome: "permanent"; reasonCode: string };

export interface WhiteoutProvider {
  /**
   * Apply ONE gift code to ONE player.
   *
   * `idempotencyKey` is the stable per-(player, code) key from the global redemptions record.
   * The local key is not evidence of upstream idempotency. `permanent` asserts definitive
   * non-application; `retryable` requires non-application or proven safe replay. If it cannot be
   * established, return `uncertain`; a timeout or thrown exception is also uncertain.
   */
  redeem(player: PlayerRef, code: string, idempotencyKey: string): Promise<RedeemResult>;
}

/**
 * The reason codes this phase emits.
 *
 * The full provider error-mapping table lives in `docs/whiteout-provider-decision.md`
 * section 6. Only the codes `MockWhiteoutProvider` produces are declared here; a future
 * authorized adapter adds the remaining codes together with its documented contract.
 */
export const REASON_CODES = {
  OUTCOME_UNCERTAIN: "outcome_uncertain",
  PROVIDER_RATE_LIMITED: "provider_rate_limited",
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  CODE_INVALID: "code_invalid",
  CODE_EXPIRED: "code_expired",
  PLAYER_INELIGIBLE: "player_ineligible",
} as const;

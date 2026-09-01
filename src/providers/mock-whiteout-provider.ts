import type { PlayerRef, RedeemResult, WhiteoutProvider } from "../domain/whiteout-provider";
import { REASON_CODES } from "../domain/whiteout-provider";

/**
 * The default `WhiteoutProvider` in development, automated tests, and staging
 * (`docs/whiteout-provider-decision.md` section 3).
 *
 * It performs no network I/O, holds no secrets, and never looks up or infers a player's state
 * or nickname. Outcomes are chosen from declared fixtures, so every result is deterministic:
 * there is no clock and no randomness anywhere in this module.
 */

/** Selectable fixture outcomes. Each maps to a `RedeemResult` in `toRedeemResult`. */
export type MockOutcome =
  | "success"
  | "already_redeemed"
  | "rate_limited"
  | "provider_unavailable"
  | "code_invalid"
  | "code_expired"
  | "code_disabled"
  | "player_ineligible";

/**
 * A rule matching redemptions by player, by code, or by both.
 *
 * At least one of `playerId` / `code` must be set, so a rule can never silently shadow
 * `defaultOutcome`.
 */
export interface MockFixture {
  playerId?: string;
  code?: string;
  outcome: MockOutcome;
}

export interface MockWhiteoutProviderOptions {
  /** Outcome for redemptions no fixture matches. Defaults to `success`. */
  defaultOutcome?: MockOutcome;
  /** Rules scanned in order; the first match wins. */
  fixtures?: readonly MockFixture[];
}

function receiptFor(idempotencyKey: string): string {
  return `mock-receipt:${idempotencyKey}`;
}

function toRedeemResult(outcome: MockOutcome, idempotencyKey: string): RedeemResult {
  switch (outcome) {
    case "success":
      return { outcome: "success", providerReceipt: receiptFor(idempotencyKey) };
    case "already_redeemed":
      return { outcome: "already_redeemed", providerReceipt: receiptFor(idempotencyKey) };
    case "rate_limited":
      return { outcome: "retryable", reasonCode: REASON_CODES.PROVIDER_RATE_LIMITED };
    case "provider_unavailable":
      return { outcome: "retryable", reasonCode: REASON_CODES.PROVIDER_UNAVAILABLE };
    case "code_invalid":
      return { outcome: "permanent", reasonCode: REASON_CODES.CODE_INVALID };
    case "code_expired":
      return { outcome: "permanent", reasonCode: REASON_CODES.CODE_EXPIRED };
    // A disabled code classifies as `code_invalid`: `redemption-state-machine.md` section 17
    // groups "Invalid / expired / disabled code" under `code_invalid` / `code_expired`, and
    // `whiteout-provider-decision.md` section 6 lists "mark code disabled" as the operator
    // action for `code_invalid`. No new reason code is invented here.
    case "code_disabled":
      return { outcome: "permanent", reasonCode: REASON_CODES.CODE_INVALID };
    case "player_ineligible":
      return { outcome: "permanent", reasonCode: REASON_CODES.PLAYER_INELIGIBLE };
  }
}

export class MockWhiteoutProvider implements WhiteoutProvider {
  readonly #defaultOutcome: MockOutcome;
  readonly #fixtures: readonly MockFixture[];

  /**
   * Applied redemptions, keyed by `idempotencyKey` and holding the receipt that was issued.
   *
   * Private with no accessor: idempotency is observable through `redeem` alone.
   */
  readonly #applied = new Map<string, string>();

  constructor(options: MockWhiteoutProviderOptions = {}) {
    const fixtures = options.fixtures ?? [];
    for (const fixture of fixtures) {
      if (fixture.playerId === undefined && fixture.code === undefined) {
        throw new TypeError(
          "MockWhiteoutProvider fixture must set at least one of playerId or code",
        );
      }
    }
    this.#defaultOutcome = options.defaultOutcome ?? "success";
    this.#fixtures = [...fixtures];
  }

  async redeem(player: PlayerRef, code: string, idempotencyKey: string): Promise<RedeemResult> {
    // Idempotent by construction: a key that already applied never applies again, and the
    // repeat is reported as the success-equivalent terminal outcome with the same receipt.
    const appliedReceipt = this.#applied.get(idempotencyKey);
    if (appliedReceipt !== undefined) {
      return { outcome: "already_redeemed", providerReceipt: appliedReceipt };
    }

    const result = toRedeemResult(this.#resolveOutcome(player, code), idempotencyKey);

    // Only applied outcomes are recorded. A `retryable` or `permanent` result applied nothing,
    // so a later call with the same stable key still reaches its fixture.
    if (result.outcome === "success" || result.outcome === "already_redeemed") {
      this.#applied.set(idempotencyKey, receiptFor(idempotencyKey));
    }

    return result;
  }

  #resolveOutcome(player: PlayerRef, code: string): MockOutcome {
    for (const fixture of this.#fixtures) {
      const playerMatches = fixture.playerId === undefined || fixture.playerId === player.playerId;
      const codeMatches = fixture.code === undefined || fixture.code === code;
      if (playerMatches && codeMatches) {
        return fixture.outcome;
      }
    }
    return this.#defaultOutcome;
  }
}

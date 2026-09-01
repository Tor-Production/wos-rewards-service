/**
 * Gift-code discovery contracts owned by `docs/architecture/redemption-state-machine.md`
 * section 11.
 *
 * STATUS: NOT AUTHORIZED. `CODE_DISCOVERY_ENABLED` is `false` and there is deliberately no
 * implementation of `GiftCodeSource` in this repository. A source may only be implemented
 * once it meets the allowed-source criteria in `docs/whiteout-provider-decision.md`
 * section 7. Scraping, undocumented game endpoints, and browser automation are prohibited
 * (section 8).
 *
 * Discovery is a separate concern from redemption and never lives on `WhiteoutProvider`.
 */

export interface DiscoveredCode {
  code: string;
  /** Identifier of the authorized source. */
  source: string;
  /** ISO-8601 timestamp. */
  discoveredAt: string;
}

export interface GiftCodeSource {
  /** Discover candidate gift codes from a SEPARATELY AUTHORIZED source. */
  listCandidateCodes(): Promise<DiscoveredCode[]>;
}

import type { AppConfig } from "../config";
import type { WhiteoutProvider } from "../domain/whiteout-provider";
import { MockWhiteoutProvider } from "./mock-whiteout-provider";
import type { MockWhiteoutProviderOptions } from "./mock-whiteout-provider";

export { MockWhiteoutProvider } from "./mock-whiteout-provider";
export type {
  MockFixture,
  MockOutcome,
  MockWhiteoutProviderOptions,
} from "./mock-whiteout-provider";

/**
 * Build the `WhiteoutProvider` for a validated configuration.
 *
 * `MockWhiteoutProvider` is the default in development, automated tests, and staging. This is
 * also the rollback seam described in `docs/whiteout-provider-decision.md` section 5: a future
 * authorized adapter is selected here by `PROVIDER_MODE`, and setting `PROVIDER_MODE=mock`
 * disables it again.
 *
 * The guard is defence in depth. `loadConfig` already rejects any other mode, so a config that
 * reaches here with a different value was not produced by this module.
 */
export function createWhiteoutProvider(
  config: AppConfig,
  options: MockWhiteoutProviderOptions = {},
): WhiteoutProvider {
  if (config.providerMode !== "mock") {
    throw new Error(
      "PROVIDER_MODE must be mock: no authorized production Whiteout provider exists",
    );
  }
  return new MockWhiteoutProvider(options);
}

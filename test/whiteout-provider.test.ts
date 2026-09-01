import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config";
import { loadConfig } from "../src/config";
import { createWhiteoutProvider, MockWhiteoutProvider } from "../src/providers";

const STAGING_CONFIG = loadConfig({
  ENVIRONMENT: "staging",
  PROVIDER_MODE: "mock",
  PRODUCTION_REDEMPTION_ENABLED: false,
  CODE_DISCOVERY_ENABLED: false,
  LOG_LEVEL: "info",
});

describe("createWhiteoutProvider", () => {
  it("returns the mock provider for the staging configuration", () => {
    expect(createWhiteoutProvider(STAGING_CONFIG)).toBeInstanceOf(MockWhiteoutProvider);
  });

  it("passes fixtures through to the mock", async () => {
    const provider = createWhiteoutProvider(STAGING_CONFIG, {
      fixtures: [{ code: "CODE", outcome: "code_expired" }],
    });

    expect(await provider.redeem({ playerId: "1", state: "1621" }, "CODE", "k1")).toStrictEqual({
      outcome: "permanent",
      reasonCode: "code_expired",
    });
  });

  it("refuses any provider mode other than mock", () => {
    // loadConfig cannot produce this value; the cast exercises the factory defence in depth
    // against an AppConfig assembled elsewhere.
    const tampered = { ...STAGING_CONFIG, providerMode: "live" } as unknown as AppConfig;

    expect(() => createWhiteoutProvider(tampered)).toThrow(/PROVIDER_MODE must be mock/);
  });
});

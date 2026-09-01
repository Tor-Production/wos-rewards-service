import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config";

const SAFE_ENV = {
  ENVIRONMENT: "staging",
  PROVIDER_MODE: "mock",
  PRODUCTION_REDEMPTION_ENABLED: false,
  CODE_DISCOVERY_ENABLED: false,
  LOG_LEVEL: "info",
};

function issuesFor(raw: unknown): readonly string[] {
  try {
    loadConfig(raw);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("expected loadConfig to reject this configuration");
}

describe("loadConfig accepts the intended staging configuration", () => {
  it("accepts JSON booleans for the disabled flags", () => {
    expect(loadConfig(SAFE_ENV)).toStrictEqual({
      environment: "staging",
      providerMode: "mock",
      productionRedemptionEnabled: false,
      codeDiscoveryEnabled: false,
      logLevel: "info",
    });
  });

  it('accepts the string "false" for the disabled flags', () => {
    const config = loadConfig({
      ...SAFE_ENV,
      PRODUCTION_REDEMPTION_ENABLED: "false",
      CODE_DISCOVERY_ENABLED: "false",
    });

    expect(config.productionRedemptionEnabled).toBe(false);
    expect(config.codeDiscoveryEnabled).toBe(false);
  });

  it("accepts every documented log level", () => {
    for (const logLevel of ["debug", "info", "warn", "error"]) {
      expect(loadConfig({ ...SAFE_ENV, LOG_LEVEL: logLevel }).logLevel).toBe(logLevel);
    }
  });
});

describe("loadConfig rejects unsafe environments", () => {
  it("rejects ENVIRONMENT=production: this phase is staging-only", () => {
    expect(issuesFor({ ...SAFE_ENV, ENVIRONMENT: "production" })).toContain(
      "ENVIRONMENT must be one of: staging",
    );
  });

  it("rejects any other ENVIRONMENT", () => {
    for (const environment of ["Staging", "dev", "", " staging"]) {
      expect(issuesFor({ ...SAFE_ENV, ENVIRONMENT: environment })).toContain(
        "ENVIRONMENT must be one of: staging",
      );
    }
  });

  it("rejects a PROVIDER_MODE other than mock: no authorized provider exists", () => {
    for (const providerMode of ["live", "production", "whiteout", ""]) {
      expect(issuesFor({ ...SAFE_ENV, PROVIDER_MODE: providerMode })).toContain(
        "PROVIDER_MODE must be one of: mock",
      );
    }
  });

  it("rejects enabled production redemption", () => {
    for (const value of [true, "true"]) {
      expect(issuesFor({ ...SAFE_ENV, PRODUCTION_REDEMPTION_ENABLED: value })).toContain(
        "PRODUCTION_REDEMPTION_ENABLED must be false",
      );
    }
  });

  it("rejects enabled code discovery", () => {
    for (const value of [true, "true"]) {
      expect(issuesFor({ ...SAFE_ENV, CODE_DISCOVERY_ENABLED: value })).toContain(
        "CODE_DISCOVERY_ENABLED must be false",
      );
    }
  });

  it("rejects an unknown LOG_LEVEL", () => {
    expect(issuesFor({ ...SAFE_ENV, LOG_LEVEL: "trace" })).toContain(
      "LOG_LEVEL must be one of: debug, info, warn, error",
    );
  });
});

describe("loadConfig rejects malformed input", () => {
  it("rejects a missing environment object", () => {
    for (const raw of [undefined, null, "staging", 42]) {
      expect(issuesFor(raw).length).toBeGreaterThan(0);
    }
  });

  it("rejects an empty environment and reports every missing variable", () => {
    expect(issuesFor({})).toStrictEqual([
      "ENVIRONMENT must be one of: staging",
      "PROVIDER_MODE must be one of: mock",
      "LOG_LEVEL must be one of: debug, info, warn, error",
      "PRODUCTION_REDEMPTION_ENABLED must be false",
      "CODE_DISCOVERY_ENABLED must be false",
    ]);
  });

  it("never treats a non-boolean value as disabled", () => {
    for (const value of ["0", "no", "off", "", 0, null, undefined, "FALSE"]) {
      expect(issuesFor({ ...SAFE_ENV, CODE_DISCOVERY_ENABLED: value })).toContain(
        "CODE_DISCOVERY_ENABLED must be false",
      );
    }
  });
});

describe("ConfigurationError does not leak supplied values", () => {
  it("reports variable names and expectations only", () => {
    const supplied = "a-value-that-must-not-be-echoed";
    const issues = issuesFor({
      ...SAFE_ENV,
      ENVIRONMENT: supplied,
      PROVIDER_MODE: supplied,
      LOG_LEVEL: supplied,
      PRODUCTION_REDEMPTION_ENABLED: supplied,
      CODE_DISCOVERY_ENABLED: supplied,
    });

    expect(issues.length).toBe(5);
    for (const issue of issues) {
      expect(issue).not.toContain(supplied);
    }
  });

  it("keeps the supplied value out of the error message too", () => {
    const supplied = "another-value-that-must-not-be-echoed";
    let message = "";
    try {
      loadConfig({ ...SAFE_ENV, LOG_LEVEL: supplied });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("LOG_LEVEL");
    expect(message).not.toContain(supplied);
  });
});

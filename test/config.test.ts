import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";

import { ConfigurationError, loadConfig } from "../src/config";

const SAFE_ENV = {
  ...env,
  ENVIRONMENT: "staging",
  PROVIDER_MODE: "mock",
  PRODUCTION_REDEMPTION_ENABLED: false,
  CODE_DISCOVERY_ENABLED: false,
  LOG_LEVEL: "info",
  DISCORD_GUILD_ID: env.DISCORD_GUILD_ID,
  DISCORD_REGISTRATION_CHANNEL_ID: env.DISCORD_REGISTRATION_CHANNEL_ID,
  DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID,
  DEFAULT_STATE: "0",
  SPIKE_SENDER_ALLOWLIST: "",
  INGESTION_SHARED_SECRET: env.INGESTION_SHARED_SECRET,
  DISCORD_MESSAGE_MAX_LENGTH: 2000,
  OPERATION_DEADLINE_SECONDS: 3600,
  REDEMPTION_MAX_REEVAL: 3,
  OUTBOX_DISPATCH_MAX_ATTEMPTS: 5,
};

describe("Phase 3 configuration guardrails", () => {
  it.each([
    "DISCORD_GUILD_ID",
    "DISCORD_REGISTRATION_CHANNEL_ID",
    "DISCORD_MVP_ADMIN_CHANNEL_ID",
    "DISCORD_APPLICATION_ID",
    "DEFAULT_STATE",
  ])("requires bounded digit strings for %s", (name) => {
    const max = name === "DEFAULT_STATE" ? 16 : 20;
    for (const value of [
      null,
      undefined,
      123,
      "",
      "12a",
      "-1",
      " 12",
      "12\n",
      "1".repeat(max + 1),
    ]) {
      expect(() => loadConfig({ ...SAFE_ENV, [name]: value })).toThrow(ConfigurationError);
    }
    if (name === "DEFAULT_STATE")
      expect(() => loadConfig({ ...SAFE_ENV, [name]: "0".repeat(max) })).not.toThrow();
    else {
      expect(() => loadConfig({ ...SAFE_ENV, [name]: "0".repeat(max) })).toThrow(
        ConfigurationError,
      );
      expect(() => loadConfig({ ...SAFE_ENV, [name]: "1".repeat(17) })).not.toThrow();
    }
  });
  it("preserves default-state zeros, accepts integer strings and deduplicates the allow-list", () => {
    const config = loadConfig({
      ...SAFE_ENV,
      DEFAULT_STATE: "0007",
      SPIKE_SENDER_ALLOWLIST: "123,456,123",
      DISCORD_MESSAGE_MAX_LENGTH: "500",
      OPERATION_DEADLINE_SECONDS: "604800",
      REDEMPTION_MAX_REEVAL: "0",
      OUTBOX_DISPATCH_MAX_ATTEMPTS: "1",
    });
    expect(config.defaultState).toBe("0007");
    expect(config.spikeSenderAllowlist).toEqual(["123", "456"]);
    expect(config.discordMessageMaxLength).toBe(500);
    expect(config.operationDeadlineSeconds).toBe(604800);
    expect(config.redemptionMaxReeval).toBe(0);
    expect(config.outboxDispatchMaxAttempts).toBe(1);
  });
  it.each([
    "123,",
    ",123",
    "123, 456",
    "123,,456",
    "abc",
    "123\n",
    env.DISCORD_APPLICATION_ID,
    `123,${env.DISCORD_APPLICATION_ID}`,
    null,
  ])("rejects malformed or own-application allow-lists (%#)", (value) => {
    expect(() => loadConfig({ ...SAFE_ENV, SPIKE_SENDER_ALLOWLIST: value })).toThrow(
      ConfigurationError,
    );
  });
  it.each([
    ["DISCORD_MESSAGE_MAX_LENGTH", 500, 2000],
    ["OPERATION_DEADLINE_SECONDS", 1, 604800],
    ["REDEMPTION_MAX_REEVAL", 0, 100],
    ["OUTBOX_DISPATCH_MAX_ATTEMPTS", 1, 5],
  ] as const)("bounds %s", (name, min, max) => {
    for (const value of [min, max])
      expect(() => loadConfig({ ...SAFE_ENV, [name]: value })).not.toThrow();
    for (const value of [min - 1, max + 1, 1.5, Infinity, NaN, "1.0", " 1", "1\n", true, null])
      expect(() => loadConfig({ ...SAFE_ENV, [name]: value })).toThrow(ConfigurationError);
  });
  it("rejects unusable secrets and never echoes secret or allow-list values", () => {
    for (const value of [undefined, null, "", " ", "synthetic\n", "synthetic value", 123])
      expect(() => loadConfig({ ...SAFE_ENV, INGESTION_SHARED_SECRET: value })).toThrow(
        ConfigurationError,
      );
    const supplied = "synthetic value never echoed";
    const issues = issuesFor({
      ...SAFE_ENV,
      INGESTION_SHARED_SECRET: supplied,
      SPIKE_SENDER_ALLOWLIST: supplied,
    });
    expect(issues).toHaveLength(2);
    expect(issues.join(" ")).not.toContain(supplied);
  });
});

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
      followSource: null,
      communityJsonSource: null,
      logLevel: "info",
      discordGuildId: env.DISCORD_GUILD_ID,
      discordRegistrationChannelId: env.DISCORD_REGISTRATION_CHANNEL_ID,
      discordMvpAdminChannelId: env.DISCORD_MVP_ADMIN_CHANNEL_ID,
      discordMvpAdminUserAllowlist: [env.DISCORD_MVP_ADMIN_USER_ALLOWLIST],
      discordApplicationId: env.DISCORD_APPLICATION_ID,
      defaultState: "0",
      spikeSenderAllowlist: [],
      ingestionSharedSecret: env.INGESTION_SHARED_SECRET,
      discordMessageMaxLength: 2000,
      operationDeadlineSeconds: 3600,
      redemptionMaxReeval: 3,
      outboxDispatchMaxAttempts: 5,
      providerMaxInvocations: 4,
      providerMaxRetries: 3,
      itemLeaseSeconds: 120,
      redemptionLeaseSeconds: 120,
      providerTimeoutSeconds: 10,
      outputLeaseSeconds: 60,
      outputTimeoutSeconds: 10,
      outputMaxAttempts: 5,
      summaryMaxChunks: 10,
      discordDeliveryEnabled: false,
      discordBotToken: null,
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
  it("rejects placeholder Discord IDs even while outbound delivery is disabled", () => {
    for (const name of [
      "DISCORD_GUILD_ID",
      "DISCORD_REGISTRATION_CHANNEL_ID",
      "DISCORD_MVP_ADMIN_CHANNEL_ID",
      "DISCORD_APPLICATION_ID",
    ])
      expect(issuesFor({ ...SAFE_ENV, [name]: "0".repeat(18) })).toContain(
        `${name} must be a non-placeholder Discord snowflake`,
      );
    expect(issuesFor({ ...SAFE_ENV, DISCORD_MVP_ADMIN_USER_ALLOWLIST: "0".repeat(18) })).toContain(
      "DISCORD_MVP_ADMIN_USER_ALLOWLIST must contain only non-placeholder Discord snowflakes",
    );
  });

  it("requires a human administrator allow-list and distinct staging channels", () => {
    expect(issuesFor({ ...SAFE_ENV, DISCORD_MVP_ADMIN_USER_ALLOWLIST: "" })).toContain(
      "DISCORD_MVP_ADMIN_USER_ALLOWLIST must contain at least one administrator",
    );
    expect(
      issuesFor({
        ...SAFE_ENV,
        DISCORD_MVP_ADMIN_USER_ALLOWLIST: env.DISCORD_APPLICATION_ID,
      }),
    ).toContain("DISCORD_MVP_ADMIN_USER_ALLOWLIST must not contain DISCORD_APPLICATION_ID");
    expect(
      issuesFor({
        ...SAFE_ENV,
        DISCORD_MVP_ADMIN_CHANNEL_ID: env.DISCORD_REGISTRATION_CHANNEL_ID,
      }),
    ).toContain("registration and MVP admin channels must be different");
  });

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

  it("rejects enabled code discovery without its source tuple", () => {
    for (const value of [true, "true"]) {
      expect(issuesFor({ ...SAFE_ENV, CODE_DISCOVERY_ENABLED: value })).toContain(
        "DISCORD_CODE_FEED_CHANNEL_ID must be a non-placeholder Discord snowflake",
      );
    }
  });

  it("keeps the community JSON adapter behind discovery and staging/mock gates", () => {
    expect(
      loadConfig({ ...SAFE_ENV, COMMUNITY_JSON_SOURCE_ENABLED: true }).communityJsonSource,
    ).not.toBeNull();
    expect(
      loadConfig({
        ...SAFE_ENV,
        CODE_DISCOVERY_ENABLED: true,
        COMMUNITY_JSON_SOURCE_ENABLED: true,
        DISCORD_CODE_FEED_CHANNEL_ID: "100000000000000006",
        DISCORD_CODE_FOLLOWER_WEBHOOK_ID: "100000000000000007",
        DISCORD_CODE_SOURCE_GUILD_ID: "100000000000000008",
        DISCORD_CODE_SOURCE_CHANNEL_ID: "100000000000000009",
      }).communityJsonSource,
    ).not.toBeNull();
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
      "DISCORD_GUILD_ID must be a digit string of 1 to 20 digits",
      "DISCORD_REGISTRATION_CHANNEL_ID must be a digit string of 1 to 20 digits",
      "DISCORD_MVP_ADMIN_CHANNEL_ID must be a digit string of 1 to 20 digits",
      "DISCORD_APPLICATION_ID must be a digit string of 1 to 20 digits",
      "DEFAULT_STATE must be a digit string of 1 to 16 digits",
      "INGESTION_SHARED_SECRET must be a non-empty string without whitespace",
      "SPIKE_SENDER_ALLOWLIST must be empty or comma-separated snowflakes",
      "DISCORD_MVP_ADMIN_USER_ALLOWLIST must be comma-separated snowflakes",
      "DISCORD_MESSAGE_MAX_LENGTH must be an integer from 500 to 2000",
      "OPERATION_DEADLINE_SECONDS must be an integer from 1 to 604800",
      "REDEMPTION_MAX_REEVAL must be an integer from 0 to 100",
      "OUTBOX_DISPATCH_MAX_ATTEMPTS must be an integer from 1 to 5",
      "PROVIDER_MAX_INVOCATIONS must be an integer from 1 to 101",
      "PROVIDER_MAX_RETRIES must be an integer from 0 to 100",
      "ITEM_CLAIM_LEASE_SECONDS must be an integer from 30 to 3600",
      "REDEMPTION_CLAIM_LEASE_SECONDS must be an integer from 30 to 3600",
      "PROVIDER_TIMEOUT_SECONDS must be an integer from 1 to 60",
      "OUTPUT_CLAIM_LEASE_SECONDS must be an integer from 30 to 3600",
      "OUTPUT_TIMEOUT_SECONDS must be an integer from 1 to 60",
      "OUTPUT_DISPATCH_MAX_ATTEMPTS must be an integer from 1 to 20",
      "SUMMARY_MAX_CHUNKS must be an integer from 1 to 100",
      "DISCORD_DELIVERY_ENABLED must be true or false",
      "REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED must be false",
    ]);
  });

  it("never treats a non-boolean value as disabled", () => {
    for (const value of ["0", "no", "off", "", 0, null, "FALSE"]) {
      expect(issuesFor({ ...SAFE_ENV, CODE_DISCOVERY_ENABLED: value })).toContain(
        "CODE_DISCOVERY_ENABLED must be true or false",
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

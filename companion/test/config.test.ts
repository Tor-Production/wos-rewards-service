import { describe, expect, it } from "vitest";

import { CompanionConfigurationError, loadCompanionConfig } from "../src/config.js";
import { CONFIG } from "./fixtures.js";

const ENV = {
  DISCORD_BOT_TOKEN: CONFIG.discordBotToken,
  INGESTION_SHARED_SECRET: CONFIG.ingestionSharedSecret,
  COMPANION_WORKER_BASE_URL: CONFIG.workerBaseUrl,
  DISCORD_GUILD_ID: CONFIG.discordGuildId,
  DISCORD_REGISTRATION_CHANNEL_ID: CONFIG.discordRegistrationChannelId,
  DISCORD_MVP_ADMIN_CHANNEL_ID: CONFIG.discordMvpAdminChannelId,
  DISCORD_MVP_ADMIN_USER_ALLOWLIST: CONFIG.discordMvpAdminUserAllowlist.join(","),
  DISCORD_APPLICATION_ID: CONFIG.discordApplicationId,
};

describe("companion configuration", () => {
  it("accepts the complete staging configuration and deduplicates administrators", () => {
    expect(
      loadCompanionConfig({
        ...ENV,
        DISCORD_MVP_ADMIN_USER_ALLOWLIST: `${ENV.DISCORD_MVP_ADMIN_USER_ALLOWLIST},${ENV.DISCORD_MVP_ADMIN_USER_ALLOWLIST}`,
      }),
    ).toEqual(CONFIG);
  });

  it.each([
    ["COMPANION_WORKER_BASE_URL", "http://service.example.workers.dev"],
    ["COMPANION_WORKER_BASE_URL", "https://example.com"],
    ["DISCORD_GUILD_ID", "000000000000000001"],
    ["DISCORD_REGISTRATION_CHANNEL_ID", "not-an-id"],
    ["DISCORD_MVP_ADMIN_USER_ALLOWLIST", ""],
    ["DISCORD_MVP_ADMIN_USER_ALLOWLIST", "423456789012345678, bad"],
  ])("rejects malformed or placeholder %s", (name, value) => {
    expect(() => loadCompanionConfig({ ...ENV, [name]: value })).toThrow(
      CompanionConfigurationError,
    );
  });

  it("never echoes secret values in issues or the error message", () => {
    const secret = "sensitive value must not appear";
    let caught: CompanionConfigurationError | null = null;
    try {
      loadCompanionConfig({
        ...ENV,
        DISCORD_BOT_TOKEN: secret,
        INGESTION_SHARED_SECRET: secret,
      });
    } catch (error) {
      caught = error as CompanionConfigurationError;
    }
    expect(caught).toBeInstanceOf(CompanionConfigurationError);
    expect(caught?.issues).toHaveLength(2);
    expect(caught?.message).not.toContain(secret);
  });
});

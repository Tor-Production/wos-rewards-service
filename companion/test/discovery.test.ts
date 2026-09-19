import { describe, expect, it, vi } from "vitest";
import { loadCompanionConfig } from "../src/config.js";
import { routeMessage } from "../src/message-router.js";
import { forwardToWorker } from "../src/worker-client.js";
import { CONFIG, message } from "./fixtures.js";

const now = new Date("2026-09-19T00:00:00Z");
const config = {
  ...CONFIG,
  followSource: {
    guildId: CONFIG.discordGuildId,
    channelId: "100000000000000006",
    webhookId: "100000000000000007",
    sourceGuildId: "100000000000000008",
    sourceChannelId: "100000000000000009",
  },
};
const event = () =>
  message({
    channelId: config.followSource.channelId,
    webhookId: config.followSource.webhookId,
    authorIsBot: true,
    messageType: 0,
    flags: 2,
    reference: {
      type: 0,
      guildId: config.followSource.sourceGuildId,
      channelId: config.followSource.sourceChannelId,
      messageId: "100000000000000010",
    },
    content:
      "📌 Code: TestCode18A\n⏰Valid Until: February 29, 23:59 (UTC+0)\n🥳 Redemption page: https://wos-giftcode.centurygame.com/",
    createdAt: now,
  });
const vars = {
  DISCORD_BOT_TOKEN: CONFIG.discordBotToken,
  INGESTION_SHARED_SECRET: CONFIG.ingestionSharedSecret,
  COMPANION_WORKER_BASE_URL: CONFIG.workerBaseUrl,
  DISCORD_GUILD_ID: CONFIG.discordGuildId,
  DISCORD_REGISTRATION_CHANNEL_ID: CONFIG.discordRegistrationChannelId,
  DISCORD_MVP_ADMIN_CHANNEL_ID: CONFIG.discordMvpAdminChannelId,
  DISCORD_MVP_ADMIN_USER_ALLOWLIST: CONFIG.discordMvpAdminUserAllowlist.join(","),
  DISCORD_APPLICATION_ID: CONFIG.discordApplicationId,
  CODE_DISCOVERY_ENABLED: "true",
  ENVIRONMENT: "staging",
  PROVIDER_MODE: "mock",
  DISCORD_CODE_FEED_CHANNEL_ID: config.followSource.channelId,
  DISCORD_CODE_FOLLOWER_WEBHOOK_ID: config.followSource.webhookId,
  DISCORD_CODE_SOURCE_GUILD_ID: config.followSource.sourceGuildId,
  DISCORD_CODE_SOURCE_CHANNEL_ID: config.followSource.sourceChannelId,
};

describe("companion Follow source route", () => {
  it("routes only the configured source envelope; forwards original content, never extracted claims", () => {
    const routed = routeMessage(event(), config, now);
    expect(routed).toMatchObject({
      kind: "discovered_code",
      path: "/discovered-code",
      payload: { content: event().content, source_message_id: "100000000000000010", flags: 2 },
    });
    expect(Object.keys(routed!.payload)).toHaveLength(12);
    expect(routeMessage(event(), CONFIG, now)).toBeNull();
    expect(routeMessage({ ...event(), authorIsBot: false }, config, now)).not.toBeNull();
    expect(routeMessage({ ...event(), flags: 6 }, config, now)).not.toBeNull();
  });
  it.each([
    { guildId: "200000000000000001" },
    { channelId: "200000000000000001" },
    { webhookId: "200000000000000001" },
    { webhookId: null },
    { reference: null },
    {
      reference: {
        type: 1,
        guildId: "100000000000000008",
        channelId: "100000000000000009",
        messageId: "100000000000000010",
      },
    },
    { reference: { type: 0, channelId: "100000000000000009" } },
    { messageType: 19 },
    { messageType: 12 },
    { flags: 0 },
    { flags: 10 },
    { flags: 16386 },
    { authorIsSystem: true },
    { messageIsSystem: true },
    { applicationId: CONFIG.discordApplicationId },
    { content: "" },
    { content: "📌 Code: Other" },
    { createdAt: new Date(now.getTime() - 300001) },
    { createdAt: new Date(now.getTime() + 60001) },
  ])("drops untrusted or stale Follow traffic (%#)", (override) => {
    expect(routeMessage({ ...event(), ...override }, config, now)).toBeNull();
  });
  it("keeps registration and manual commands human-only with discovery enabled", () => {
    expect(
      routeMessage({ ...event(), channelId: config.discordRegistrationChannelId }, config, now),
    ).toBeNull();
    expect(
      routeMessage(
        {
          ...event(),
          channelId: config.discordMvpAdminChannelId,
          content: "!wos-code Test18",
          authorId: config.discordMvpAdminUserAllowlist[0]!,
        },
        config,
        now,
      ),
    ).toBeNull();
  });
  it("validates the complete synthetic tuple separately from Worker configuration", () => {
    expect(loadCompanionConfig(vars).followSource).toEqual(config.followSource);
    expect(
      loadCompanionConfig({
        ...vars,
        CODE_DISCOVERY_ENABLED: "false",
        DISCORD_CODE_FOLLOWER_WEBHOOK_ID: undefined,
      }).followSource,
    ).toBeNull();
    for (const key of [
      "DISCORD_CODE_FEED_CHANNEL_ID",
      "DISCORD_CODE_FOLLOWER_WEBHOOK_ID",
      "DISCORD_CODE_SOURCE_GUILD_ID",
      "DISCORD_CODE_SOURCE_CHANNEL_ID",
      "ENVIRONMENT",
      "PROVIDER_MODE",
    ])
      expect(() => loadCompanionConfig({ ...vars, [key]: undefined })).toThrow();
    for (const extra of [
      { CODE_DISCOVERY_ENABLED: "TRUE" },
      { ENVIRONMENT: "production" },
      { PROVIDER_MODE: "real" },
      { DISCORD_CODE_FEED_CHANNEL_ID: config.discordMvpAdminChannelId },
      { DISCORD_CODE_FEED_CHANNEL_ID: config.discordRegistrationChannelId },
    ])
      expect(() => loadCompanionConfig({ ...vars, ...extra })).toThrow();
  });
  it("retains bounded timeout retries and fixed outcomes without logging payloads", async () => {
    const routed = routeMessage(event(), config, now)!;
    const logs = [vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    let calls = 0;
    const delays: number[] = [];
    const result = await forwardToWorker(config, routed, {
      timeoutMs: 5,
      delay: async (ms) => {
        delays.push(ms);
      },
      fetcher: async (req) => {
        calls++;
        expect(new URL(req.url).pathname).toBe("/discovered-code");
        return new Promise<Response>(() => {});
      },
    });
    expect(result).toBe("unavailable");
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
    for (const log of logs) {
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    }
  });
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config";
import { createDiscordRestTransport, createMessage } from "../src/discord/delivery";

const LIVE_IDS = {
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_REGISTRATION_CHANNEL_ID: "223456789012345678",
  DISCORD_MVP_ADMIN_CHANNEL_ID: "323456789012345678",
  DISCORD_MVP_ADMIN_USER_ALLOWLIST: "423456789012345678",
  DISCORD_APPLICATION_ID: "523456789012345678",
};

describe("opt-in staging Discord REST transport", () => {
  it("emits the API v10 request shape through an injected fetch", async () => {
    const observed: Record<string, unknown> = {};
    const transport = createDiscordRestTransport("synthetic-test-token", async (request) => {
      observed.url = request.url;
      observed.method = request.method;
      observed.authorization = request.headers.get("authorization")?.replace(/ .+$/, " <redacted>");
      observed.body = await request.json();
      return Response.json({
        id: "623456789012345678",
        channel_id: LIVE_IDS.DISCORD_MVP_ADMIN_CHANNEL_ID,
      });
    });
    const result = await createMessage(
      transport,
      {
        channel_id: LIVE_IDS.DISCORD_MVP_ADMIN_CHANNEL_ID,
        content: "synthetic summary",
        nonce: "deterministic-nonce",
      },
      1,
    );
    expect(result).toEqual({
      kind: "sent",
      messageId: "623456789012345678",
      delay: 0,
      reason: null,
    });
    expect(observed).toEqual({
      url: `https://discord.com/api/v10/channels/${LIVE_IDS.DISCORD_MVP_ADMIN_CHANNEL_ID}/messages`,
      method: "POST",
      authorization: "Bot <redacted>",
      body: {
        content: "synthetic summary",
        nonce: "deterministic-nonce",
        enforce_nonce: true,
        allowed_mentions: { parse: [] },
      },
    });
  });

  it("keeps disabled delivery inert and requires the secret plus real IDs when enabled", () => {
    const disabled = loadConfig({ ...env, DISCORD_BOT_TOKEN: undefined });
    expect(disabled.discordDeliveryEnabled).toBe(false);
    expect(disabled.discordBotToken).toBeNull();
    const supplied = "synthetic secret value";
    for (const token of [undefined, supplied]) {
      let error: ConfigurationError | null = null;
      try {
        loadConfig({
          ...env,
          ...LIVE_IDS,
          DISCORD_DELIVERY_ENABLED: true,
          DISCORD_BOT_TOKEN: token,
        });
      } catch (caught) {
        error = caught as ConfigurationError;
      }
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error?.message).not.toContain(supplied);
    }
    const enabled = loadConfig({
      ...env,
      ...LIVE_IDS,
      DISCORD_DELIVERY_ENABLED: true,
      DISCORD_BOT_TOKEN: "synthetic-test-token",
    });
    expect(enabled.discordDeliveryEnabled).toBe(true);
    expect(enabled.discordBotToken).toBe("synthetic-test-token");
  });

  it("maps a thrown live fetch to a closed retry reason without leaking the credential", async () => {
    const token = "synthetic-token-canary";
    const result = await createMessage(
      createDiscordRestTransport(token, async () => {
        throw new Error(token);
      }),
      { channel_id: LIVE_IDS.DISCORD_MVP_ADMIN_CHANNEL_ID, content: "test", nonce: "n" },
      1,
    );
    expect(result).toEqual({ kind: "retry", delay: 60, reason: "discord_network_failed" });
    expect(JSON.stringify(result)).not.toContain(token);
  });
});

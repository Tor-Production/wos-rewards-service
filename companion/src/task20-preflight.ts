import { Client, Events, GatewayIntentBits } from "discord.js";

import { loadFollowSource } from "../../shared/discord-follow.js";
import { loadCompanionConfig } from "./config.js";
import { matchesSelectedFollowCopy } from "./task20-preflight-validation.js";

// This standalone entrypoint intentionally has no MessageCreate listener or Worker client.
// It is approval-gated and run once before any Cloudflare cutover mutation.
const config = loadCompanionConfig(process.env);
const issues: string[] = [];
const source = loadFollowSource({ ...process.env, CODE_DISCOVERY_ENABLED: "true" }, issues);
const destinationMessageId = process.env.TASK20_DESTINATION_MESSAGE_ID ?? "";
const sourceMessageId = process.env.TASK20_SOURCE_MESSAGE_ID ?? "";
if (issues.length > 0 || !source || !config.discordBotToken) {
  console.error("task20_preflight_configuration_failed");
  process.exitCode = 1;
} else {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client.on(Events.Error, () => {});
  client.on(Events.ShardError, () => {});
  try {
    const ready = new Promise<string>((resolve, reject) => {
      client.once(Events.ClientReady, (session) => resolve(session.application?.id ?? ""));
      client.once(Events.ShardDisconnect, () => reject(new Error("disconnect")));
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("timeout")), 20_000).unref();
    });
    const login = client.login(config.discordBotToken);
    const applicationId = await Promise.race([ready, login.then(() => timeout), timeout]);
    if (applicationId !== config.discordApplicationId) throw new Error("identity");
    const response = await fetch(
      `https://discord.com/api/v10/channels/${source.channelId}/messages/${destinationMessageId}`,
      {
        headers: { Authorization: `Bot ${config.discordBotToken}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error("selected message inaccessible");
    const message: unknown = await response.json();
    if (!matchesSelectedFollowCopy(message, source, destinationMessageId, sourceMessageId))
      throw new Error("selected message mismatch");
    console.info("task20_preflight_ready");
  } catch {
    // Never print API bodies, IDs, credentials, or library exception text.
    console.error("task20_preflight_failed");
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
}

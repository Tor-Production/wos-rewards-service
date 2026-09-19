import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import type { FollowCodeEvent } from "../../shared/discord-follow";
import { uniqueId } from "./fixtures";

export const discoveryVars = {
  CODE_DISCOVERY_ENABLED: true,
  DISCORD_CODE_FEED_CHANNEL_ID: "100000000000000006",
  DISCORD_CODE_FOLLOWER_WEBHOOK_ID: "100000000000000007",
  DISCORD_CODE_SOURCE_GUILD_ID: "100000000000000008",
  DISCORD_CODE_SOURCE_CHANNEL_ID: "100000000000000009",
};
export const followId = () => "1" + uniqueId().padStart(19, "0").slice(-19);
export const content = (code = "TestCode18A", expiry = "September 20, 23:59 (UTC+0)") =>
  `📌 Code: ${code}\n⏰Valid Until: ${expiry}\n🥳 Redemption page: https://wos-giftcode.centurygame.com/`;
export function followEvent(overrides: Partial<FollowCodeEvent> = {}): FollowCodeEvent {
  return {
    event_id: followId(),
    guild_id: env.DISCORD_GUILD_ID,
    channel_id: discoveryVars.DISCORD_CODE_FEED_CHANNEL_ID,
    webhook_id: discoveryVars.DISCORD_CODE_FOLLOWER_WEBHOOK_ID,
    source_guild_id: discoveryVars.DISCORD_CODE_SOURCE_GUILD_ID,
    source_channel_id: discoveryVars.DISCORD_CODE_SOURCE_CHANNEL_ID,
    source_message_id: followId(),
    message_type: 0,
    reference_type: 0,
    flags: 2,
    content: content(`Test18_${followId()}`),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
export function discoveryEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...env, ...discoveryVars, ...overrides } as unknown as Env;
}
export function discoveryRequest(value: unknown): Request {
  return new Request("https://synthetic.invalid/discovered-code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.INGESTION_SHARED_SECRET}`,
    },
    body: JSON.stringify(value),
  });
}
export const sendDiscovery = (value: unknown, runtime = discoveryEnv()) =>
  worker.fetch(discoveryRequest(value), runtime, createExecutionContext());

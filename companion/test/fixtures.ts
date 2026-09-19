import type { CompanionConfig } from "../src/config.js";
import type { DiscordMessageView } from "../src/message-router.js";

export const CONFIG: CompanionConfig = {
  followSource: null,
  discordBotToken: "synthetic-test-token",
  ingestionSharedSecret: "synthetic-test-secret",
  workerBaseUrl: "https://wos-rewards-service-staging.example.workers.dev",
  discordGuildId: "123456789012345678",
  discordRegistrationChannelId: "223456789012345678",
  discordMvpAdminChannelId: "323456789012345678",
  discordMvpAdminUserAllowlist: ["423456789012345678"],
  discordApplicationId: "523456789012345678",
};

export function message(overrides: Partial<DiscordMessageView> = {}): DiscordMessageView {
  return {
    id: "623456789012345678",
    messageType: 0,
    flags: 0,
    reference: null,
    guildId: CONFIG.discordGuildId,
    channelId: CONFIG.discordRegistrationChannelId,
    authorId: "723456789012345678",
    authorIsBot: false,
    authorIsSystem: false,
    messageIsSystem: false,
    webhookId: null,
    applicationId: null,
    content: "1234567890 7 Frost Wolf",
    createdAt: new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  };
}

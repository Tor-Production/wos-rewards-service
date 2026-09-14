import type { CompanionConfig } from "./config.js";

export interface DiscordMessageView {
  readonly id: string;
  readonly guildId: string | null;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly authorIsSystem: boolean;
  readonly messageIsSystem: boolean;
  readonly webhookId: string | null;
  readonly applicationId: string | null;
  readonly content: string;
  readonly createdAt: Date;
}

interface CommonPayload {
  readonly event_id: string;
  readonly guild_id: string;
  readonly channel_id: string;
  readonly author_id: string;
  readonly author_is_bot: boolean;
  readonly author_is_system: boolean;
  readonly webhook_id: string | null;
  readonly application_id: string | null;
  readonly created_at: string;
}

export type RoutedMessage =
  | {
      readonly kind: "registration";
      readonly path: "/ingest";
      readonly payload: CommonPayload & { readonly content: string };
    }
  | {
      readonly kind: "manual_code";
      readonly path: "/manual-code";
      readonly payload: CommonPayload & { readonly code: string };
    };

export function routeMessage(
  message: DiscordMessageView,
  config: CompanionConfig,
): RoutedMessage | null {
  if (message.guildId !== config.discordGuildId || !isHumanMessage(message)) return null;
  const common = {
    event_id: message.id,
    guild_id: message.guildId,
    channel_id: message.channelId,
    author_id: message.authorId,
    author_is_bot: message.authorIsBot,
    author_is_system: message.authorIsSystem,
    webhook_id: message.webhookId,
    application_id: message.applicationId,
    created_at: message.createdAt.toISOString(),
  };
  if (message.channelId === config.discordRegistrationChannelId)
    return {
      kind: "registration",
      path: "/ingest",
      payload: { ...common, content: message.content },
    };
  if (
    message.channelId !== config.discordMvpAdminChannelId ||
    !config.discordMvpAdminUserAllowlist.includes(message.authorId)
  )
    return null;
  const code = parseManualCodeCommand(message.content);
  return code === null
    ? null
    : { kind: "manual_code", path: "/manual-code", payload: { ...common, code } };
}

export function parseManualCodeCommand(content: string): string | null {
  const match = /^!wos-code[ \t]+([A-Za-z0-9_-]{1,64})$/.exec(content.trim());
  return match?.[1] ?? null;
}

function isHumanMessage(message: DiscordMessageView): boolean {
  return (
    !message.authorIsBot &&
    !message.authorIsSystem &&
    !message.messageIsSystem &&
    message.webhookId === null &&
    message.applicationId === null
  );
}

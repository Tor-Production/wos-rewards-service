import { isFollowSnowflake, type FollowSourceConfig } from "../../shared/discord-follow.js";

/** Readiness checks a single historical destination copy; it never forwards an event. */
export function matchesSelectedFollowCopy(
  value: unknown,
  source: FollowSourceConfig,
  destinationMessageId: string,
  sourceMessageId: string,
): boolean {
  if (!isFollowSnowflake(destinationMessageId) || !isFollowSnowflake(sourceMessageId)) return false;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (typeof message.message_reference !== "object" || message.message_reference === null)
    return false;
  const reference = message.message_reference as Record<string, unknown>;
  return (
    message.id === destinationMessageId &&
    message.channel_id === source.channelId &&
    message.webhook_id === source.webhookId &&
    message.type === 0 &&
    message.flags === 2 &&
    reference.type === 0 &&
    reference.guild_id === source.sourceGuildId &&
    reference.channel_id === source.sourceChannelId &&
    reference.message_id === sourceMessageId
  );
}

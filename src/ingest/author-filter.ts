import type { AppConfig } from "../config";
import type { RegistrationMessageEvent } from "../domain/discord-event";

export type AcceptanceClass = "normal" | "staging_spike";

/**
 * The Worker-side author gate. Callers must pass the result of the ingestion authentication
 * boundary explicitly; an unauthenticated request can never acquire a spike classification.
 */
export function classifyAcceptedAuthor(
  event: RegistrationMessageEvent,
  config: AppConfig,
  authenticated: boolean,
): AcceptanceClass | null {
  if (!authenticated) return null;
  if (
    event.guild_id !== config.discordGuildId ||
    event.channel_id !== config.discordRegistrationChannelId
  )
    return null;
  if (
    event.author_id === config.discordApplicationId ||
    event.application_id === config.discordApplicationId ||
    event.author_is_system
  )
    return null;

  const automated = event.author_is_bot || event.webhook_id !== null;
  if (!automated) return "normal";

  // An explicit staging equality remains fail-closed even if the config type is widened later.
  if (config.environment !== "staging") return null;

  // A webhook must match its webhook id, never merely the bot-shaped author carried by the
  // webhook message. A non-webhook bot must match its author id.
  const senderId = event.webhook_id ?? (event.author_is_bot ? event.author_id : null);
  return senderId !== null && config.spikeSenderAllowlist.includes(senderId)
    ? "staging_spike"
    : null;
}

export function shouldAcceptAuthor(
  event: RegistrationMessageEvent,
  config: AppConfig,
  authenticated: boolean,
): boolean {
  return classifyAcceptedAuthor(event, config, authenticated) !== null;
}

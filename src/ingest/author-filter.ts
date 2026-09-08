import type { AppConfig } from "../config";
import type { RegistrationMessageEvent } from "../domain/discord-event";

export function shouldAcceptAuthor(event: RegistrationMessageEvent, config: AppConfig): boolean {
  if (
    event.guild_id !== config.discordGuildId ||
    event.channel_id !== config.discordRegistrationChannelId
  )
    return false;
  if (
    event.author_id === config.discordApplicationId ||
    event.application_id === config.discordApplicationId ||
    event.author_is_system
  )
    return false;
  // An explicit staging equality remains fail-closed even if the config type is widened later.
  const allowListed =
    config.environment === "staging" &&
    (config.spikeSenderAllowlist.includes(event.author_id) ||
      (event.webhook_id !== null && config.spikeSenderAllowlist.includes(event.webhook_id)));
  return !(event.author_is_bot || event.webhook_id !== null) || allowListed;
}

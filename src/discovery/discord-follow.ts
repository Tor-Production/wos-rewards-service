import { isFollowCodeEvent, parseFollowContent } from "../../shared/discord-follow";
import type { GiftCodeSource } from "../domain/gift-code-source";

export const discordFollowSource: GiftCodeSource = {
  candidate(event, config, now) {
    if (!isFollowCodeEvent(event, config, now)) return null;
    const candidate = parseFollowContent(event.content);
    return candidate ? { event, candidate } : null;
  },
};

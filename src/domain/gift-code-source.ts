import type {
  FollowCandidate,
  FollowCodeEvent,
  FollowSourceConfig,
} from "../../shared/discord-follow";

/** Push-event discovery is separate from WhiteoutProvider; it performs no network access. */
export interface GiftCodeSource {
  candidate(
    event: unknown,
    config: FollowSourceConfig | null,
    now: Date,
  ): { readonly event: FollowCodeEvent; readonly candidate: FollowCandidate } | null;
}

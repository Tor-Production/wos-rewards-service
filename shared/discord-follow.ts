import { isValidCreatedAt } from "../src/ingest/timestamp.js";
import {
  GIFT_CODE_MAX_LENGTH,
  MANUAL_CODE_MAX_AGE_MS,
  MANUAL_CODE_MAX_FUTURE_MS,
} from "../src/limits.js";

export const DISCOVERY_MAX_CONTENT_BYTES = 512;
export const DISCOVERY_MAX_BODY_BYTES = 2048;
export const DISCOVERY_SOURCE = "discord-follow-staging";

export interface FollowSourceConfig {
  readonly guildId: string;
  readonly channelId: string;
  readonly webhookId: string;
  readonly sourceGuildId: string;
  readonly sourceChannelId: string;
}

/** Null is the disabled state; both processes load this gate independently. */
export function loadFollowSource(
  source: Readonly<Record<string, unknown>>,
  issues: string[],
): FollowSourceConfig | null {
  const enabled = source.CODE_DISCOVERY_ENABLED;
  if (enabled === undefined || enabled === false || enabled === "false") return null;
  if (enabled !== true && enabled !== "true") {
    issues.push("CODE_DISCOVERY_ENABLED must be true or false");
    return null;
  }
  if (source.ENVIRONMENT !== "staging" || source.PROVIDER_MODE !== "mock")
    issues.push("discovery requires staging and mock mode");
  const fields = {
    guildId: "DISCORD_GUILD_ID",
    channelId: "DISCORD_CODE_FEED_CHANNEL_ID",
    webhookId: "DISCORD_CODE_FOLLOWER_WEBHOOK_ID",
    sourceGuildId: "DISCORD_CODE_SOURCE_GUILD_ID",
    sourceChannelId: "DISCORD_CODE_SOURCE_CHANNEL_ID",
  } as const;
  const result = {} as Record<keyof FollowSourceConfig, string>;
  for (const [key, name] of Object.entries(fields)) {
    const value = source[name];
    if (!isFollowSnowflake(value))
      issues.push(`${name} must be a non-placeholder Discord snowflake`);
    result[key as keyof FollowSourceConfig] = typeof value === "string" ? value : "";
  }
  if (
    result.channelId === source.DISCORD_REGISTRATION_CHANNEL_ID ||
    result.channelId === source.DISCORD_MVP_ADMIN_CHANNEL_ID
  )
    issues.push("discovery feed must differ from registration and admin channels");
  return result;
}

export interface FollowCodeEvent {
  readonly event_id: string;
  readonly guild_id: string;
  readonly channel_id: string;
  readonly webhook_id: string;
  readonly source_guild_id: string;
  readonly source_channel_id: string;
  readonly source_message_id: string;
  readonly message_type: 0;
  readonly reference_type: 0;
  readonly flags: number;
  readonly content: string;
  readonly created_at: string;
}

export interface FollowCandidate {
  readonly code: string;
  readonly expiryLabel: string;
  readonly expiryYear: null;
}

export function isFollowSnowflake(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && /^[1-9]\d{16,19}$/.test(value);
}

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Only ASCII horizontal whitespace around lines/tokens; exactly three LF or CRLF lines. */
export function parseFollowContent(content: string): FollowCandidate | null {
  if (new TextEncoder().encode(content).byteLength > DISCOVERY_MAX_CONTENT_BYTES) return null;
  const normalized = content.replaceAll("\r\n", "\n");
  // JS end anchors also match before a final line separator. Only LF/CRLF are allowed.
  if (/[\r\u2028\u2029]/.test(normalized)) return null;
  const lines = normalized.split("\n").map((line) => line.replace(/^[ \t]+|[ \t]+$/g, ""));
  if (lines.length !== 3) return null;
  const code = /^📌[ \t]*Code:[ \t]*([A-Za-z0-9_-]+)$/.exec(lines[0]!);
  const expiry =
    /^⏰[ \t]*Valid Until:[ \t]*([A-Za-z]+)[ \t]+([0-9]{1,2}),[ \t]*([0-9]{2}):([0-9]{2})[ \t]+\(UTC\+0\)$/.exec(
      lines[1]!,
    );
  if (
    !code ||
    code[1]!.length > GIFT_CODE_MAX_LENGTH ||
    !expiry ||
    !/^🥳[ \t]*Redemption page:[ \t]*https:\/\/wos-giftcode\.centurygame\.com\/$/.test(lines[2]!)
  )
    return null;
  const month = months.indexOf(expiry[1]!);
  const day = Number(expiry[2]);
  if (
    month < 0 ||
    day < 1 ||
    day > days[month]! ||
    Number(expiry[3]) > 23 ||
    Number(expiry[4]) > 59
  )
    return null;
  return {
    code: code[1]!,
    expiryLabel: `${months[month]} ${day}, ${expiry[3]}:${expiry[4]} (UTC+0)`,
    expiryYear: null,
  };
}

const keys = [
  "event_id",
  "guild_id",
  "channel_id",
  "webhook_id",
  "source_guild_id",
  "source_channel_id",
  "source_message_id",
  "message_type",
  "reference_type",
  "flags",
  "content",
  "created_at",
];

/** Exact transport schema plus source trust, called at each process boundary. */
export function isFollowCodeEvent(
  value: unknown,
  config: FollowSourceConfig | null,
  now: Date,
): value is FollowCodeEvent {
  if (!config || typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(r, key)) ||
    !keys.slice(0, 7).every((key) => isFollowSnowflake(r[key])) ||
    r.guild_id !== config.guildId ||
    r.channel_id !== config.channelId ||
    r.webhook_id !== config.webhookId ||
    r.source_guild_id !== config.sourceGuildId ||
    r.source_channel_id !== config.sourceChannelId ||
    r.message_type !== 0 ||
    r.reference_type !== 0 ||
    // Allow only IS_CROSSPOST and the harmless SUPPRESS_EMBEDS flag. Unknown flags fail closed.
    (r.flags !== 2 && r.flags !== 6) ||
    typeof r.content !== "string" ||
    !parseFollowContent(r.content) ||
    !isValidCreatedAt(r.created_at, now)
  )
    return false;
  const instant = Date.parse(r.created_at);
  return (
    instant >= now.getTime() - MANUAL_CODE_MAX_AGE_MS &&
    instant <= now.getTime() + MANUAL_CODE_MAX_FUTURE_MS
  );
}

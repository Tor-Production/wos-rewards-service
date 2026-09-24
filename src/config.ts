/**
 * Runtime configuration.
 *
 * Variable names come from `docs/architecture/configuration.md` section 4. This module is the
 * only place that reads configuration values from the Worker environment. It accepts
 * `unknown` on purpose: the
 * generated `Env` type describes what the checked-in `wrangler.jsonc` declares, but the gates
 * below must also hold for a Worker deployed with tampered variables, so they are enforced at
 * runtime rather than assumed from a type.
 *
 * The service fails closed. Phase 3 is staging-only, no authorized production provider
 * exists; discovery is restricted to a configured staging/mock Follow source, so anything outside the
 * safe combination is rejected.
 */

import { loadFollowSource, type FollowSourceConfig } from "../shared/discord-follow";
import {
  loadCommunityJsonSource,
  type CommunityJsonSourceConfig,
} from "./discovery/community-json";

import { STATE_MAX_DIGITS } from "./limits";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ENVIRONMENTS = ["staging"] as const;
const PROVIDER_MODES = ["mock"] as const;
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/**
 * The validated configuration.
 *
 * The literal types are part of the safety story: there is no representable `AppConfig` in
 * which production redemption is enabled, or the environment is not `staging`.
 * Widening any of them requires an explicitly authorized task that also provisions the
 * corresponding stack and safeguards.
 */
export interface AppConfig {
  readonly environment: "staging";
  readonly providerMode: "mock";
  readonly productionRedemptionEnabled: false;
  readonly codeDiscoveryEnabled: boolean;
  readonly followSource: FollowSourceConfig | null;
  readonly communityJsonSource: CommunityJsonSourceConfig | null;
  readonly logLevel: LogLevel;
  readonly discordGuildId: string;
  readonly discordRegistrationChannelId: string;
  readonly discordMvpAdminChannelId: string;
  readonly discordMvpAdminUserAllowlist: readonly string[];
  readonly discordApplicationId: string;
  readonly defaultState: string;
  readonly spikeSenderAllowlist: readonly string[];
  readonly ingestionSharedSecret: string;
  readonly discordMessageMaxLength: number;
  readonly operationDeadlineSeconds: number;
  readonly redemptionMaxReeval: number;
  readonly outboxDispatchMaxAttempts: number;
  readonly providerMaxInvocations: number;
  readonly providerMaxRetries: number;
  readonly itemLeaseSeconds: number;
  readonly redemptionLeaseSeconds: number;
  readonly providerTimeoutSeconds: number;
  readonly outputLeaseSeconds: number;
  readonly outputTimeoutSeconds: number;
  readonly outputMaxAttempts: number;
  readonly summaryMaxChunks: number;
  readonly discordDeliveryEnabled: boolean;
  readonly discordBotToken: string | null;
}

/**
 * Raised when the environment does not satisfy the safety gates.
 *
 * `issues` names variables and states what was expected. It never contains a supplied value,
 * so it is safe to log; it is still not returned over HTTP.
 */
export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
}

function readEnum<T extends string>(
  source: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
  issues: string[],
): T | undefined {
  const value = source[name];
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  issues.push(`${name} must be one of: ${allowed.join(", ")}`);
  return undefined;
}

/**
 * Require a flag to be disabled.
 *
 * Wrangler can surface a `vars` entry as a JSON boolean or as a string depending on how it was
 * set, so both `false` and `"false"` are accepted. Every other value is an error: nothing is
 * allowed to be treated as disabled by accident.
 */
function requireDisabled(source: Record<string, unknown>, name: string, issues: string[]): void {
  const value = source[name];
  if (value === false || value === "false") {
    return;
  }
  issues.push(`${name} must be false`);
}

function readBoolean(
  source: Record<string, unknown>,
  name: string,
  issues: string[],
): boolean | undefined {
  const value = source[name];
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  issues.push(`${name} must be true or false`);
  return undefined;
}

export function loadConfig(raw: unknown): AppConfig {
  const source = asRecord(raw);
  if (source === null) {
    throw new ConfigurationError(["configuration must be an object of environment variables"]);
  }

  const issues: string[] = [];
  const environment = readEnum(source, "ENVIRONMENT", ENVIRONMENTS, issues);
  const providerMode = readEnum(source, "PROVIDER_MODE", PROVIDER_MODES, issues);
  const logLevel = readEnum(source, "LOG_LEVEL", LOG_LEVELS, issues);
  requireDisabled(source, "PRODUCTION_REDEMPTION_ENABLED", issues);
  const followSource = loadFollowSource(source, issues);
  const communityJsonSource = loadCommunityJsonSource(source, issues);
  const discordGuildId = readDigitString(source, "DISCORD_GUILD_ID", 20, issues);
  const discordRegistrationChannelId = readDigitString(
    source,
    "DISCORD_REGISTRATION_CHANNEL_ID",
    20,
    issues,
  );
  const discordMvpAdminChannelId = readDigitString(
    source,
    "DISCORD_MVP_ADMIN_CHANNEL_ID",
    20,
    issues,
  );
  const discordApplicationId = readDigitString(source, "DISCORD_APPLICATION_ID", 20, issues);
  const defaultState = readDigitString(source, "DEFAULT_STATE", STATE_MAX_DIGITS, issues);
  const ingestionSharedSecret = source.INGESTION_SHARED_SECRET;
  if (typeof ingestionSharedSecret !== "string" || !/^[^\s]+$/.test(ingestionSharedSecret)) {
    issues.push("INGESTION_SHARED_SECRET must be a non-empty string without whitespace");
  }
  const spikeSenderAllowlist: string[] = [];
  const allowlist = source.SPIKE_SENDER_ALLOWLIST;
  if (
    typeof allowlist !== "string" ||
    (allowlist !== "" && !/^\d{1,20}(?:,\d{1,20})*$/.test(allowlist))
  ) {
    issues.push("SPIKE_SENDER_ALLOWLIST must be empty or comma-separated snowflakes");
  } else if (allowlist !== "") {
    spikeSenderAllowlist.push(...new Set(allowlist.split(",")));
    if (spikeSenderAllowlist.includes(discordApplicationId)) {
      issues.push("SPIKE_SENDER_ALLOWLIST must not contain DISCORD_APPLICATION_ID");
    }
  }
  const discordMvpAdminUserAllowlist: string[] = [];
  const adminAllowlist = source.DISCORD_MVP_ADMIN_USER_ALLOWLIST;
  const adminAllowlistMalformed =
    typeof adminAllowlist !== "string" ||
    (adminAllowlist !== "" && !/^\d{1,20}(?:,\d{1,20})*$/.test(adminAllowlist));
  if (adminAllowlistMalformed) {
    issues.push("DISCORD_MVP_ADMIN_USER_ALLOWLIST must be comma-separated snowflakes");
  } else if (adminAllowlist === "") {
    issues.push("DISCORD_MVP_ADMIN_USER_ALLOWLIST must contain at least one administrator");
  } else {
    discordMvpAdminUserAllowlist.push(...new Set(adminAllowlist.split(",")));
  }
  // Keep replies and summaries within Discord limits. The attempt ceiling keeps
  // the complete outbox query-budget proof closed.
  const discordMessageMaxLength = readInteger(
    source,
    "DISCORD_MESSAGE_MAX_LENGTH",
    500,
    2_000,
    issues,
  );
  const operationDeadlineSeconds = readInteger(
    source,
    "OPERATION_DEADLINE_SECONDS",
    1,
    604_800,
    issues,
  );
  const redemptionMaxReeval = readInteger(source, "REDEMPTION_MAX_REEVAL", 0, 100, issues);
  const outboxDispatchMaxAttempts = readInteger(
    source,
    "OUTBOX_DISPATCH_MAX_ATTEMPTS",
    1,
    5,
    issues,
  );

  const phase4 = {
    providerMaxInvocations: readInteger(source, "PROVIDER_MAX_INVOCATIONS", 1, 101, issues),
    providerMaxRetries: readInteger(source, "PROVIDER_MAX_RETRIES", 0, 100, issues),
    itemLeaseSeconds: readInteger(source, "ITEM_CLAIM_LEASE_SECONDS", 30, 3600, issues),
    redemptionLeaseSeconds: readInteger(source, "REDEMPTION_CLAIM_LEASE_SECONDS", 30, 3600, issues),
    providerTimeoutSeconds: readInteger(source, "PROVIDER_TIMEOUT_SECONDS", 1, 60, issues),
    outputLeaseSeconds: readInteger(source, "OUTPUT_CLAIM_LEASE_SECONDS", 30, 3600, issues),
    outputTimeoutSeconds: readInteger(source, "OUTPUT_TIMEOUT_SECONDS", 1, 60, issues),
    outputMaxAttempts: readInteger(source, "OUTPUT_DISPATCH_MAX_ATTEMPTS", 1, 20, issues),
    summaryMaxChunks: readInteger(source, "SUMMARY_MAX_CHUNKS", 1, 100, issues),
  };
  const discordDeliveryEnabled = readBoolean(source, "DISCORD_DELIVERY_ENABLED", issues);
  const discordBotToken = source.DISCORD_BOT_TOKEN;
  if (
    discordDeliveryEnabled === true &&
    (typeof discordBotToken !== "string" || !/^[^\s]+$/.test(discordBotToken))
  )
    issues.push("DISCORD_BOT_TOKEN must be present when DISCORD_DELIVERY_ENABLED is true");
  const liveIds = [
    ["DISCORD_GUILD_ID", discordGuildId],
    ["DISCORD_REGISTRATION_CHANNEL_ID", discordRegistrationChannelId],
    ["DISCORD_MVP_ADMIN_CHANNEL_ID", discordMvpAdminChannelId],
    ["DISCORD_APPLICATION_ID", discordApplicationId],
  ] as const;
  for (const [name, value] of liveIds)
    if (value !== "" && !isDeployableDiscordSnowflake(value))
      issues.push(`${name} must be a non-placeholder Discord snowflake`);
  for (const value of discordMvpAdminUserAllowlist)
    if (!isDeployableDiscordSnowflake(value))
      issues.push(
        "DISCORD_MVP_ADMIN_USER_ALLOWLIST must contain only non-placeholder Discord snowflakes",
      );
  if (discordMvpAdminUserAllowlist.includes(discordApplicationId))
    issues.push("DISCORD_MVP_ADMIN_USER_ALLOWLIST must not contain DISCORD_APPLICATION_ID");
  if (
    discordRegistrationChannelId !== "" &&
    discordRegistrationChannelId === discordMvpAdminChannelId
  )
    issues.push("registration and MVP admin channels must be different");
  requireDisabled(source, "REDEMPTION_AUTO_REOPEN_RETRY_EXHAUSTED", issues);
  if (phase4.itemLeaseSeconds <= phase4.providerTimeoutSeconds)
    issues.push("item lease must exceed provider timeout");
  if (phase4.redemptionLeaseSeconds <= phase4.providerTimeoutSeconds)
    issues.push("redemption lease must exceed provider timeout");
  if (phase4.outputLeaseSeconds <= phase4.outputTimeoutSeconds)
    issues.push("output lease must exceed transport timeout");
  if (
    issues.length > 0 ||
    environment === undefined ||
    providerMode === undefined ||
    logLevel === undefined ||
    discordDeliveryEnabled === undefined ||
    typeof ingestionSharedSecret !== "string"
  ) {
    throw new ConfigurationError(issues);
  }

  return {
    environment,
    providerMode,
    productionRedemptionEnabled: false,
    codeDiscoveryEnabled: followSource !== null || communityJsonSource !== null,
    followSource,
    communityJsonSource,
    logLevel,
    discordGuildId,
    discordRegistrationChannelId,
    discordMvpAdminChannelId,
    discordMvpAdminUserAllowlist,
    discordApplicationId,
    defaultState,
    spikeSenderAllowlist,
    ingestionSharedSecret,
    discordMessageMaxLength,
    operationDeadlineSeconds,
    redemptionMaxReeval,
    outboxDispatchMaxAttempts,
    ...phase4,
    discordDeliveryEnabled,
    discordBotToken:
      discordDeliveryEnabled && typeof discordBotToken === "string" ? discordBotToken : null,
  };
}

function isDeployableDiscordSnowflake(value: string): boolean {
  return /^[1-9]\d{16,19}$/.test(value);
}

function readDigitString(
  source: Record<string, unknown>,
  name: string,
  max: number,
  issues: string[],
): string {
  const value = source[name];
  if (typeof value === "string" && /^\d+$/.test(value) && value.length <= max) return value;
  issues.push(`${name} must be a digit string of 1 to ${max} digits`);
  return "";
}

function readInteger(
  source: Record<string, unknown>,
  name: string,
  min: number,
  max: number,
  issues: string[],
): number {
  const raw = source[name];
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max)
    return value;
  issues.push(`${name} must be an integer from ${min} to ${max}`);
  return min;
}

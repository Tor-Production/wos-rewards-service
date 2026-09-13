export interface CompanionConfig {
  readonly discordBotToken: string;
  readonly ingestionSharedSecret: string;
  readonly workerBaseUrl: string;
  readonly discordGuildId: string;
  readonly discordRegistrationChannelId: string;
  readonly discordMvpAdminChannelId: string;
  readonly discordMvpAdminUserAllowlist: readonly string[];
  readonly discordApplicationId: string;
}

export class CompanionConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid companion configuration: ${issues.join("; ")}`);
    this.name = "CompanionConfigurationError";
    this.issues = issues;
  }
}

export function loadCompanionConfig(
  source: Readonly<Record<string, string | undefined>>,
): CompanionConfig {
  const issues: string[] = [];
  const discordBotToken = readSecret(source, "DISCORD_BOT_TOKEN", issues);
  const ingestionSharedSecret = readSecret(source, "INGESTION_SHARED_SECRET", issues);
  const workerBaseUrl = readWorkerUrl(source.COMPANION_WORKER_BASE_URL, issues);
  const discordGuildId = readSnowflake(source, "DISCORD_GUILD_ID", issues);
  const discordRegistrationChannelId = readSnowflake(
    source,
    "DISCORD_REGISTRATION_CHANNEL_ID",
    issues,
  );
  const discordMvpAdminChannelId = readSnowflake(source, "DISCORD_MVP_ADMIN_CHANNEL_ID", issues);
  const discordApplicationId = readSnowflake(source, "DISCORD_APPLICATION_ID", issues);
  const discordMvpAdminUserAllowlist = readSnowflakeList(
    source.DISCORD_MVP_ADMIN_USER_ALLOWLIST,
    issues,
  );
  if (
    discordRegistrationChannelId !== "" &&
    discordRegistrationChannelId === discordMvpAdminChannelId
  )
    issues.push("registration and MVP admin channels must be different");
  if (discordMvpAdminUserAllowlist.includes(discordApplicationId))
    issues.push("DISCORD_MVP_ADMIN_USER_ALLOWLIST must not contain DISCORD_APPLICATION_ID");
  if (issues.length > 0) throw new CompanionConfigurationError(issues);
  return {
    discordBotToken,
    ingestionSharedSecret,
    workerBaseUrl,
    discordGuildId,
    discordRegistrationChannelId,
    discordMvpAdminChannelId,
    discordMvpAdminUserAllowlist,
    discordApplicationId,
  };
}

function readSecret(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
  issues: string[],
): string {
  const value = source[name];
  if (typeof value === "string" && /^[^\s]+$/.test(value)) return value;
  issues.push(`${name} must be a non-empty string without whitespace`);
  return "";
}

function readSnowflake(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
  issues: string[],
): string {
  const value = source[name];
  if (typeof value === "string" && /^[1-9]\d{16,19}$/.test(value)) return value;
  issues.push(`${name} must be a non-placeholder Discord snowflake`);
  return "";
}

function readSnowflakeList(value: string | undefined, issues: string[]): string[] {
  if (typeof value !== "string" || !/^[1-9]\d{16,19}(?:,[1-9]\d{16,19})*$/.test(value)) {
    issues.push(
      "DISCORD_MVP_ADMIN_USER_ALLOWLIST must be a comma-separated list of non-placeholder Discord snowflakes",
    );
    return [];
  }
  return [...new Set(value.split(","))];
}

function readWorkerUrl(value: string | undefined, issues: string[]): string {
  try {
    if (typeof value !== "string") throw new Error("missing");
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".workers.dev") ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" ||
      url.hash !== ""
    )
      throw new Error("invalid");
    return url.origin;
  } catch {
    issues.push("COMPANION_WORKER_BASE_URL must be an HTTPS workers.dev origin");
    return "";
  }
}

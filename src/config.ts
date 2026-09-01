/**
 * Runtime configuration.
 *
 * Variable names come from `docs/architecture/configuration.md` section 4. This module is the
 * only place that reads the Worker environment. It accepts `unknown` on purpose: the
 * generated `Env` type describes what the checked-in `wrangler.jsonc` declares, but the gates
 * below must also hold for a Worker deployed with tampered variables, so they are enforced at
 * runtime rather than assumed from a type.
 *
 * The scaffold fails closed. Phase 1 is staging-only, no authorized production provider
 * exists, and no gift-code discovery source is authorized, so anything other than the exact
 * safe combination is rejected.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ENVIRONMENTS = ["staging"] as const;
const PROVIDER_MODES = ["mock"] as const;
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/**
 * The validated configuration.
 *
 * The literal types are part of the safety story: there is no representable `AppConfig` in
 * which redemption or discovery is enabled, or in which the environment is not `staging`.
 * Widening any of them requires an explicitly authorized task that also provisions the
 * corresponding stack and safeguards.
 */
export interface AppConfig {
  readonly environment: "staging";
  readonly providerMode: "mock";
  readonly productionRedemptionEnabled: false;
  readonly codeDiscoveryEnabled: false;
  readonly logLevel: LogLevel;
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
  requireDisabled(source, "CODE_DISCOVERY_ENABLED", issues);

  if (
    issues.length > 0 ||
    environment === undefined ||
    providerMode === undefined ||
    logLevel === undefined
  ) {
    throw new ConfigurationError(issues);
  }

  return {
    environment,
    providerMode,
    productionRedemptionEnabled: false,
    codeDiscoveryEnabled: false,
    logLevel,
  };
}

import { GIFT_CODE_MAX_LENGTH } from "../limits";

/** The maintainer-selected endpoint. This adapter never follows links from its payload. */
export const COMMUNITY_JSON_ENDPOINT =
  "https://www.whiteoutsurvival-community.com/tools/data/gift-codes-wosc.json";
export const COMMUNITY_JSON_SOURCE = "community-json-wosc-staging";
export const COMMUNITY_JSON_MAX_BODY_BYTES = 8 * 1024;
export const COMMUNITY_JSON_TIMEOUT_MS = 10_000;
export const COMMUNITY_JSON_MIN_POLL_SECONDS = 30 * 60;

export interface CommunityJsonSourceConfig {
  readonly endpoint: typeof COMMUNITY_JSON_ENDPOINT;
  readonly timeoutMs: number;
  readonly minPollSeconds: number;
}

export interface CommunityCodeCandidate {
  readonly code: string;
  readonly sourceStatus: "active" | "inactive" | "expired";
  /** Source claims, not independently established publication or expiry times. */
  readonly sourceUpdatedAt: string;
  readonly sourceFirstSeenAt: string;
}

export type CommunityFetchResult =
  | { readonly kind: "not_modified" }
  | { readonly kind: "access_denied" }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number | null }
  | { readonly kind: "transient_failure" }
  | { readonly kind: "invalid_payload" }
  | {
      readonly kind: "ok";
      readonly etag: string | null;
      readonly candidates: readonly CommunityCodeCandidate[];
    };

export function loadCommunityJsonSource(
  source: Readonly<Record<string, unknown>>,
  issues: string[],
): CommunityJsonSourceConfig | null {
  const enabled = source.COMMUNITY_JSON_SOURCE_ENABLED;
  if (enabled === undefined || enabled === false || enabled === "false") return null;
  if (enabled !== true && enabled !== "true") {
    issues.push("COMMUNITY_JSON_SOURCE_ENABLED must be true or false");
    return null;
  }
  if (source.ENVIRONMENT !== "staging" || source.PROVIDER_MODE !== "mock")
    issues.push("community JSON source requires staging and mock mode");
  return {
    endpoint: COMMUNITY_JSON_ENDPOINT,
    timeoutMs: COMMUNITY_JSON_TIMEOUT_MS,
    minPollSeconds: COMMUNITY_JSON_MIN_POLL_SECONDS,
  };
}

function isUtcTimestamp(value: unknown): value is string {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  ) {
    const parsed = new Date(value).toISOString();
    return parsed === value || parsed.replace(".000Z", "Z") === value;
  }
  return false;
}

/** Validates only the observed feed schema. Unknown top-level/entry fields fail closed. */
export function parseCommunityJson(value: unknown): readonly CommunityCodeCandidate[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const rootKeys = ["maintainedBy", "source", "updatedAt", "codes"];
  if (
    Object.keys(root).length !== rootKeys.length ||
    !rootKeys.every((key) => Object.hasOwn(root, key))
  )
    return null;
  if (
    typeof root.maintainedBy !== "string" ||
    typeof root.source !== "string" ||
    !isUtcTimestamp(root.updatedAt) ||
    !Array.isArray(root.codes)
  )
    return null;
  const codes: CommunityCodeCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of root.codes) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    const keys = ["code", "status", "firstSeenAt"];
    if (Object.keys(row).length !== keys.length || !keys.every((key) => Object.hasOwn(row, key)))
      return null;
    if (
      typeof row.code !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(row.code) ||
      row.code.length > GIFT_CODE_MAX_LENGTH ||
      (row.status !== "active" && row.status !== "inactive" && row.status !== "expired") ||
      !isUtcTimestamp(row.firstSeenAt) ||
      seen.has(row.code)
    )
      return null;
    seen.add(row.code);
    codes.push({
      code: row.code,
      sourceStatus: row.status,
      sourceUpdatedAt: root.updatedAt,
      sourceFirstSeenAt: row.firstSeenAt,
    });
  }
  return codes;
}

export async function fetchCommunityJson(
  config: CommunityJsonSourceConfig,
  previousEtag: string | null,
  fetcher: typeof fetch = fetch,
): Promise<CommunityFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetcher(config.endpoint, {
      method: "GET",
      redirect: "error",
      headers: previousEtag ? { "if-none-match": previousEtag } : {},
      signal: controller.signal,
    });
    if (response.status === 304) return { kind: "not_modified" };
    if (response.status === 401 || response.status === 403) return { kind: "access_denied" };
    if (response.status === 429)
      return {
        kind: "rate_limited",
        retryAfterSeconds: retryAfter(response.headers.get("retry-after")),
      };
    if (!response.ok) return { kind: "transient_failure" };
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > COMMUNITY_JSON_MAX_BODY_BYTES)
    )
      return { kind: "invalid_payload" };
    const body = await readBoundedBody(response, COMMUNITY_JSON_MAX_BODY_BYTES);
    if (body === null) return { kind: "invalid_payload" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return { kind: "invalid_payload" };
    }
    const candidates = parseCommunityJson(parsed);
    return candidates === null
      ? { kind: "invalid_payload" }
      : { kind: "ok", etag: response.headers.get("etag"), candidates };
  } catch {
    return { kind: "transient_failure" };
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(response: Response, max: number): Promise<ArrayBuffer | null> {
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function retryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now ? Math.ceil((at - now) / 1000) : null;
}

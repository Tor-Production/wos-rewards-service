import type { RegistrationMessageEvent } from "../domain/discord-event";
import { INGEST_CONTENT_MAX_CODE_POINTS, INGEST_MAX_BODY_BYTES } from "../limits";
import { isValidCreatedAt } from "./timestamp";

const EVENT_KEYS = [
  "event_id",
  "guild_id",
  "channel_id",
  "author_id",
  "author_is_bot",
  "author_is_system",
  "webhook_id",
  "application_id",
  "content",
  "created_at",
] as const;
export const isSnowflake = (value: unknown): value is string =>
  typeof value === "string" && /^\d{1,20}$/.test(value);

export function isRegistrationMessageEvent(
  value: unknown,
  now: Date,
): value is RegistrationMessageEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === EVENT_KEYS.length &&
    EVENT_KEYS.every((key) => Object.hasOwn(record, key)) &&
    [record.event_id, record.guild_id, record.channel_id, record.author_id].every(isSnowflake) &&
    typeof record.author_is_bot === "boolean" &&
    typeof record.author_is_system === "boolean" &&
    (record.webhook_id === null || isSnowflake(record.webhook_id)) &&
    (record.application_id === null || isSnowflake(record.application_id)) &&
    typeof record.content === "string" &&
    Array.from(record.content).length <= INGEST_CONTENT_MAX_CODE_POINTS &&
    isValidCreatedAt(record.created_at, now)
  );
}

export type TransportResult =
  | { ok: true; event: RegistrationMessageEvent }
  | { ok: false; error: "unsupported_media_type" | "payload_too_large" | "invalid_request" };

/** Limit the stream itself, including requests without a trustworthy Content-Length. */
export async function readRegistrationEvent(request: Request, now: Date): Promise<TransportResult> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    return { ok: false, error: "unsupported_media_type" };
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > INGEST_MAX_BODY_BYTES)
    return { ok: false, error: "payload_too_large" };
  if (!request.body) return { ok: false, error: "invalid_request" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > INGEST_MAX_BODY_BYTES) {
        // Cancellation failure must not turn a size rejection into an internal error.
        void reader.cancel().catch(() => {});
        return { ok: false, error: "payload_too_large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    return isRegistrationMessageEvent(value, now)
      ? { ok: true, event: value }
      : { ok: false, error: "invalid_request" };
  } catch {
    return { ok: false, error: "invalid_request" };
  } finally {
    reader.releaseLock();
  }
}

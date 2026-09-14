import { isSnowflake } from "../ingest/transport";
import { isValidCreatedAt } from "../ingest/timestamp";
import {
  GIFT_CODE_MAX_LENGTH,
  MANUAL_CODE_MAX_AGE_MS,
  MANUAL_CODE_MAX_BODY_BYTES,
  MANUAL_CODE_MAX_FUTURE_MS,
} from "../limits";
import type { ManualCodeCommandEvent } from "./types";

const COMMAND_KEYS = [
  "event_id",
  "guild_id",
  "channel_id",
  "author_id",
  "author_is_bot",
  "author_is_system",
  "webhook_id",
  "application_id",
  "code",
  "created_at",
] as const;

export function isGiftCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= GIFT_CODE_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function isManualCodeCommandEvent(
  value: unknown,
  now: Date,
): value is ManualCodeCommandEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== COMMAND_KEYS.length ||
    !COMMAND_KEYS.every((key) => Object.hasOwn(record, key)) ||
    ![record.event_id, record.guild_id, record.channel_id, record.author_id].every(isSnowflake) ||
    typeof record.author_is_bot !== "boolean" ||
    typeof record.author_is_system !== "boolean" ||
    (record.webhook_id !== null && !isSnowflake(record.webhook_id)) ||
    (record.application_id !== null && !isSnowflake(record.application_id)) ||
    !isGiftCode(record.code) ||
    !isValidCreatedAt(record.created_at, now)
  )
    return false;
  const createdAt = Date.parse(record.created_at);
  return (
    createdAt >= now.getTime() - MANUAL_CODE_MAX_AGE_MS &&
    createdAt <= now.getTime() + MANUAL_CODE_MAX_FUTURE_MS
  );
}

export async function readManualCodeCommand(
  request: Request,
  now: Date,
): Promise<ManualCodeCommandEvent | null> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    return null;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MANUAL_CODE_MAX_BODY_BYTES))
    return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MANUAL_CODE_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    );
    return isManualCodeCommandEvent(parsed, now) ? parsed : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

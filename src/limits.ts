// Platform floors: https://developers.cloudflare.com/d1/platform/limits/,
// https://developers.cloudflare.com/workers/platform/limits/ and
// https://developers.cloudflare.com/queues/platform/limits/ (verified 2026-09-07).
// These are independent limits; D1 statements inside a batch count individually.
export const D1_QUERIES_PER_INVOCATION_FLOOR = 50;
export const INTERNAL_SUBREQUESTS_PER_INVOCATION_FLOOR = 1_000;
export const REGULAR_SUBREQUESTS_PER_INVOCATION_FLOOR = 50;
export const SIMULTANEOUS_OPEN_CONNECTIONS_LIMIT = 6;
export const D1_MAX_BOUND_PARAMETERS_PER_QUERY = 100;
export const QUEUE_MESSAGE_MAX_BYTES = 128_000;
export const QUEUE_BATCH_MAX_BYTES = 256_000;
export const QUEUE_BATCH_MAX_MESSAGES = 100;
export const QUEUE_MESSAGE_METADATA_BYTES = 100;

export const D1_STATEMENT_BUDGET = 40;
export const SAFE_MESSAGE_BYTES = 96_000;
export const SAFE_BATCH_BYTES = 192_000;
export const SAFE_BATCH_MESSAGES = 90;
export const IDS_PER_UPDATE = 90;
export const OUTBOX_DISPATCH_SCAN_LIMIT = 90;
export const OUTBOX_DISPATCH_MAX_SEND_CALLS = 8;
export const QUEUE_SEND_CONCURRENCY = 1;
export const INLINE_DISPATCH_LIMIT = 90;
export const MAX_REGISTRATION_SNAPSHOT_CODES = 2_000;
export const OUTBOX_BACKOFF_BASE_SECONDS = 60;
export const OUTBOX_BACKOFF_MAX_SECONDS = 3_600;
export const ACCEPTANCE_STATEMENTS_VALID = 6;
export const ACCEPTANCE_STATEMENTS_INVALID = 2;
export const PLAYER_ID_MAX_DIGITS = 32;
export const STATE_MAX_DIGITS = 16;
export const DISPLAY_NAME_MAX_CODE_POINTS = 64;
export const DISPLAY_LABEL_MAX_CODE_POINTS = 80;
export const INGEST_MAX_BODY_BYTES = 16 * 1_024;
export const INGEST_CONTENT_MAX_CODE_POINTS = 4_096;

/** Tight maximum sum of ceil(group size / k) over at most gMax nonempty groups. */
export function markingStatementsMax(rows: number, gMax: number, k = IDS_PER_UPDATE): number {
  if (rows === 0) return 0;
  const g = Math.min(gMax, rows);
  return g + Math.floor((rows - g) / k);
}

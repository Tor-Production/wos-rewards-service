import { OUTBOX_BACKOFF_BASE_SECONDS, OUTBOX_BACKOFF_MAX_SECONDS } from "../limits";

/** Attempts is the new (one-based) failed-send count. No exception text or randomness. */
export function outboxBackoffSeconds(attempts: number): number {
  return Math.min(
    OUTBOX_BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1),
    OUTBOX_BACKOFF_MAX_SECONDS,
  );
}

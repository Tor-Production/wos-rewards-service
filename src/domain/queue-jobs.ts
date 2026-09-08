/** The durable identity travels with every delivery; Queues has no producer dedup key. */
export interface RedemptionJobBody {
  readonly operation_id: string;
  readonly item_key: string;
  readonly job_id: string;
  readonly player_id: string;
  readonly code: string;
  readonly attempt_id: string;
}

export type OutboxJobType = "registration" | "distribution";

/** Implemented structurally by a Workers Queue binding and local test doubles. */
export interface QueueProducer {
  sendBatch(messages: Iterable<{ body: RedemptionJobBody }>): Promise<unknown>;
}

export interface QueueProducers {
  readonly registration: QueueProducer;
  readonly distribution: QueueProducer;
}

const BODY_KEYS = [
  "operation_id",
  "item_key",
  "job_id",
  "player_id",
  "code",
  "attempt_id",
] as const;

/** Persisted payloads must have exactly the six documented string fields. */
export function isRedemptionJobBody(value: unknown): value is RedemptionJobBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === BODY_KEYS.length &&
    BODY_KEYS.every((key) => Object.hasOwn(record, key) && typeof record[key] === "string")
  );
}

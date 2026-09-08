import { progress, rotation, mutableOperation } from "../runtime/db";
import type { AppConfig } from "../config";
import type { QueueProducers } from "../domain/queue-jobs";
import {
  INLINE_DISPATCH_LIMIT,
  OUTBOX_DISPATCH_MAX_SEND_CALLS,
  OUTBOX_DISPATCH_SCAN_LIMIT,
  QUEUE_MESSAGE_METADATA_BYTES,
  SAFE_BATCH_BYTES,
  SAFE_BATCH_MESSAGES,
  SAFE_MESSAGE_BYTES,
} from "../limits";
import { prepareOutboxMarks, type OutboxMark } from "./marking";
import { packOutboxRows, type OutboxRow } from "./packing";

export interface DispatchResult {
  readonly enqueued: number;
  readonly retried: number;
  readonly dead: number;
  readonly deferred: number;
  readonly sendCalls: number;
  readonly d1Statements: number;
  readonly maxInFlightSends: number;
}

export interface DispatchInput {
  readonly db: D1Database;
  readonly queues: QueueProducers;
  readonly config: AppConfig;
  readonly now: Date;
  readonly source:
    | { readonly kind: "scan"; readonly limit: number }
    | { readonly kind: "fair"; readonly limit: number }
    | { readonly kind: "operation"; readonly operationId: string; readonly limit: number };
}

/** Shared inline/Cron producer. Queue rejection is persisted; D1 failures propagate. */
export async function dispatchOutbox(input: DispatchInput): Promise<DispatchResult> {
  const { db, queues, config, now, source } = input;
  const limit = Math.max(
    0,
    Math.min(
      Number.isFinite(source.limit) ? Math.floor(source.limit) : 0,
      source.kind === "scan" ? OUTBOX_DISPATCH_SCAN_LIMIT : INLINE_DISPATCH_LIMIT,
    ),
  );
  // Bound the complete read as well as the eventual Queue sends. One oversized
  // persisted row is still returned so it can become dead instead of starving.
  const prepare = (sql: string) =>
    db.prepare(`WITH page AS (${sql}), ranked AS (SELECT *,ROW_NUMBER() OVER() AS page_row FROM page),
    sized AS (SELECT *,SUM(length(CAST(payload_json AS BLOB))+length(CAST(job_id AS BLOB))+length(CAST(attempt_id AS BLOB))+256) OVER(ORDER BY page_row) AS page_bytes FROM ranked)
    SELECT * FROM sized WHERE page_bytes<=9000000 OR page_row=1 ORDER BY page_row`);
  const query =
    source.kind === "fair"
      ? prepare(`WITH selected AS (SELECT o.operation_id FROM operations o WHERE ${mutableOperation} AND o.deadline_at>?1
          AND EXISTS(SELECT 1 FROM outbox_jobs b WHERE b.operation_id=o.operation_id AND b.status='pending' AND b.available_at<=?1)
          ORDER BY ${rotation("outbox")} LIMIT 1)
        SELECT b.job_id,b.attempt_id,b.type,b.payload_json,b.attempts,b.operation_id FROM outbox_jobs b JOIN selected s ON s.operation_id=b.operation_id
        WHERE b.status='pending' AND b.available_at<=?1 ORDER BY b.available_at,b.job_id LIMIT ?2`).bind(
          now.toISOString(),
          limit,
        )
      : source.kind === "scan"
        ? prepare(
            "SELECT job_id, attempt_id, type, payload_json, attempts FROM outbox_jobs WHERE status='pending' AND available_at <= ?1 ORDER BY available_at, job_id LIMIT ?2",
          ).bind(now.toISOString(), limit)
        : prepare(
            "SELECT job_id, attempt_id, type, payload_json, attempts FROM outbox_jobs WHERE operation_id=?1 AND status='pending' AND attempts=0 AND available_at <= ?2 ORDER BY job_id LIMIT ?3",
          ).bind(source.operationId, now.toISOString(), limit);
  const { results: rows } = await query.all<OutboxRow>();
  const exhausted = rows.filter((row) => row.attempts >= config.outboxDispatchMaxAttempts);
  const packed = packOutboxRows(
    rows.filter((row) => row.attempts < config.outboxDispatchMaxAttempts),
    {
      maxMessages: SAFE_BATCH_MESSAGES,
      maxBatchBytes: SAFE_BATCH_BYTES,
      maxMessageBytes: SAFE_MESSAGE_BYTES,
      metadataBytesPerMessage: QUEUE_MESSAGE_METADATA_BYTES,
      maxSendCalls: OUTBOX_DISPATCH_MAX_SEND_CALLS,
    },
  );
  const marks: OutboxMark[] = [
    ...exhausted.map((row) => ({ kind: "queue_send_failed" as const, row })),
    ...packed.invalid.map((row) => ({ kind: "payload_invalid" as const, row })),
    ...packed.oversized.map((row) => ({ kind: "payload_too_large" as const, row })),
  ];

  // Every send is awaited before the next starts, across both queues. In-flight = 1.
  for (const chunk of packed.chunks) {
    try {
      await queues[chunk.type].sendBatch(chunk.bodies.map((body) => ({ body })));
      marks.push(...chunk.rows.map((row) => ({ kind: "enqueued" as const, row })));
    } catch {
      // Never persist/log the underlying exception: it may contain credential material.
      marks.push(...chunk.rows.map((row) => ({ kind: "queue_send_failed" as const, row })));
    }
  }

  const plan = prepareOutboxMarks(db, marks, now, config.outboxDispatchMaxAttempts);
  const counts = { enqueued: 0, retried: 0, dead: 0 };
  if (plan.statements.length > 0) {
    const results = await db.batch([...plan.statements]);
    results.forEach((result, index) => {
      const outcome = plan.outcomes[index];
      if (outcome) counts[outcome] += result.meta.changes;
    });
  }
  if (source.kind === "fair" && rows.length)
    await progress(
      db,
      "outbox",
      (rows[0] as OutboxRow & { operation_id: string }).operation_id,
    ).run();
  return {
    ...counts,
    deferred: packed.deferred.length,
    sendCalls: packed.chunks.length,
    d1Statements: 1 + plan.statements.length,
    maxInFlightSends: packed.chunks.length === 0 ? 0 : 1,
  };
}

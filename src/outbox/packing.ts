import {
  isRedemptionJobBody,
  type OutboxJobType,
  type RedemptionJobBody,
} from "../domain/queue-jobs";

export interface OutboxRow {
  readonly job_id: string;
  readonly attempt_id?: string;
  readonly type: OutboxJobType;
  readonly payload_json: string;
  readonly attempts: number;
}

export interface PackedChunk {
  readonly type: OutboxJobType;
  readonly rows: readonly OutboxRow[];
  readonly bodies: readonly RedemptionJobBody[];
  readonly chargedBytes: number;
}

export interface PackResult {
  readonly chunks: readonly PackedChunk[];
  readonly invalid: readonly OutboxRow[];
  readonly oversized: readonly OutboxRow[];
  readonly deferred: readonly OutboxRow[];
}

export interface PackingOptions {
  readonly maxMessages: number;
  readonly maxBatchBytes: number;
  readonly maxMessageBytes: number;
  readonly metadataBytesPerMessage: number;
  readonly maxSendCalls: number;
}

/** Compact UTF-8 JSON body estimate; metadata and safety margins are charged separately. */
export function estimateBodyBytes(body: RedemptionJobBody): number {
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}

/** Route in fixed queue order, preserving scan order within each queue. No I/O. */
export function packOutboxRows(rows: readonly OutboxRow[], opts: PackingOptions): PackResult {
  const chunks: PackedChunk[] = [];
  const invalid: OutboxRow[] = [];
  const oversized: OutboxRow[] = [];
  const deferred: OutboxRow[] = [];

  for (const type of ["registration", "distribution"] as const) {
    let chunkRows: OutboxRow[] = [];
    let bodies: RedemptionJobBody[] = [];
    let chargedBytes = 0;
    const seal = (): void => {
      if (chunkRows.length === 0) return;
      if (chunks.length < opts.maxSendCalls) {
        chunks.push({ type, rows: chunkRows, bodies, chargedBytes });
      } else {
        deferred.push(...chunkRows);
      }
      chunkRows = [];
      bodies = [];
      chargedBytes = 0;
    };

    for (const row of rows) {
      if (row.type !== type) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        invalid.push(row);
        continue;
      }
      if (!isRedemptionJobBody(parsed)) {
        invalid.push(row);
        continue;
      }
      // Reconstruct the wire contract in its documented key order, even after a repair
      // rewrites persisted JSON with another order or with insignificant whitespace.
      const body: RedemptionJobBody = {
        operation_id: parsed.operation_id,
        item_key: parsed.item_key,
        job_id: parsed.job_id,
        player_id: parsed.player_id,
        code: parsed.code,
        attempt_id: parsed.attempt_id,
      };
      const bytes = estimateBodyBytes(body) + opts.metadataBytesPerMessage;
      if (bytes > opts.maxMessageBytes || bytes > opts.maxBatchBytes) {
        oversized.push(row);
        continue;
      }
      if (chunkRows.length >= opts.maxMessages || chargedBytes + bytes > opts.maxBatchBytes) {
        seal();
      }
      chunkRows.push(row);
      bodies.push(body);
      chargedBytes += bytes;
    }
    seal();
  }
  return { chunks, invalid, oversized, deferred };
}

import { describe, expect, it } from "vitest";
import { isRedemptionJobBody, type RedemptionJobBody } from "../src/domain/queue-jobs";
import {
  OUTBOX_DISPATCH_MAX_SEND_CALLS,
  QUEUE_BATCH_MAX_BYTES,
  QUEUE_BATCH_MAX_MESSAGES,
  QUEUE_MESSAGE_MAX_BYTES,
  QUEUE_MESSAGE_METADATA_BYTES,
  SAFE_BATCH_BYTES,
  SAFE_BATCH_MESSAGES,
  SAFE_MESSAGE_BYTES,
} from "../src/limits";
import { estimateBodyBytes, packOutboxRows, type OutboxRow } from "../src/outbox/packing";

const options = {
  maxMessages: SAFE_BATCH_MESSAGES,
  maxBatchBytes: SAFE_BATCH_BYTES,
  maxMessageBytes: SAFE_MESSAGE_BYTES,
  metadataBytesPerMessage: QUEUE_MESSAGE_METADATA_BYTES,
  maxSendCalls: OUTBOX_DISPATCH_MAX_SEND_CALLS,
};

function body(code = ""): RedemptionJobBody {
  return { operation_id: "o", item_key: "i", job_id: "j", player_id: "1", code, attempt_id: "a" };
}

function row(code = "", index = 0): OutboxRow {
  return {
    job_id: `job:${index}`,
    type: "registration",
    payload_json: JSON.stringify(body(code)),
    attempts: 0,
  };
}

function chargedRow(bytes: number, index = 0): OutboxRow {
  const overhead = estimateBodyBytes(body()) + QUEUE_MESSAGE_METADATA_BYTES;
  return row("a".repeat(bytes - overhead), index);
}

describe("Queue body contract and packing", () => {
  it("uses decimal byte limits and an explicit per-message metadata charge", () => {
    expect([
      QUEUE_MESSAGE_MAX_BYTES,
      QUEUE_BATCH_MAX_BYTES,
      QUEUE_BATCH_MAX_MESSAGES,
      SAFE_MESSAGE_BYTES,
      SAFE_BATCH_BYTES,
      QUEUE_MESSAGE_METADATA_BYTES,
    ]).toEqual([128_000, 256_000, 100, 96_000, 192_000, 100]);
    // UTF-8 encodes this emoji in 4 bytes and this CJK character in 3 bytes.
    expect(estimateBodyBytes(body("😀中")) - estimateBodyBytes(body())).toBe(7);
  });

  it("requires precisely six string fields and emits their canonical key order", () => {
    for (const value of [null, [], "body", {}, { ...body(), extra: "x" }, { ...body(), code: 1 }]) {
      expect(isRedemptionJobBody(value)).toBe(false);
    }
    const { code: _, ...missing } = body();
    expect(isRedemptionJobBody(missing)).toBe(false);
    const reordered = Object.fromEntries(Object.entries(body()).reverse());
    expect(isRedemptionJobBody(reordered)).toBe(true);
    const result = packOutboxRows([{ ...row(), payload_json: JSON.stringify(reordered) }], options);
    expect(Object.keys(result.chunks[0]!.bodies[0]!)).toEqual([
      "operation_id",
      "item_key",
      "job_id",
      "player_id",
      "code",
      "attempt_id",
    ]);
  });

  it("splits small ASCII messages at the count ceiling", () => {
    const result = packOutboxRows(
      Array.from({ length: 181 }, (_, i) => row("ascii", i)),
      options,
    );
    expect(result.chunks.map((chunk) => chunk.rows.length)).toEqual([90, 90, 1]);
    expect(result.deferred).toEqual([]);
  });

  it.each([-1, 0, 1])("honors a metadata-charged batch boundary offset %i", (offset) => {
    const input = [chargedRow(64_000), chargedRow(64_000, 1), chargedRow(64_000 + offset, 2)];
    const result = packOutboxRows(input, options);
    expect(result.chunks).toHaveLength(offset <= 0 ? 1 : 2);
    expect(result.chunks.reduce((sum, chunk) => sum + chunk.chargedBytes, 0)).toBe(
      SAFE_BATCH_BYTES + offset,
    );
    if (offset <= 0) expect(result.chunks[0]!.chargedBytes).toBe(SAFE_BATCH_BYTES + offset);
  });

  it("charges multibyte content and splits on bytes well before the count limit", () => {
    const input = Array.from({ length: 6 }, (_, i) => row("😀中".repeat(10_000), i));
    const result = packOutboxRows(input, options);
    expect(result.chunks.map((chunk) => chunk.rows.length)).toEqual([2, 2, 2]);
    expect(result.chunks[0]!.chargedBytes).toBe(
      2 * (70_000 + estimateBodyBytes(body()) + QUEUE_MESSAGE_METADATA_BYTES),
    );
  });

  it("accepts the exact message ceiling and permanently rejects one byte above it", () => {
    const input = [chargedRow(95_999), chargedRow(96_000, 1), chargedRow(96_001, 2)];
    const result = packOutboxRows(input, options);
    expect(result.oversized).toEqual([input[2]]);
    expect(result.chunks[0]!.chargedBytes).toBe(191_999);
    expect(packOutboxRows([input[0]!], options).chunks[0]!.rows).toHaveLength(1);
  });

  it("classifies corrupt, missing-key and extra-key JSON without retrying", () => {
    const input = [
      "{",
      "null",
      '{"operation_id":"o"}',
      JSON.stringify({ ...body(), extra: "x" }),
    ].map((payload_json, index) => ({ ...row("", index), payload_json }));
    const result = packOutboxRows(input, options);
    expect(result.invalid).toEqual(input);
    expect(result.chunks).toEqual([]);
  });

  it("deterministically routes each queue and defers chunks over the send-call ceiling", () => {
    const input = Array.from({ length: 90 }, (_, i) => ({
      ...chargedRow(95_999, i),
      type: i % 2 === 0 ? ("registration" as const) : ("distribution" as const),
    }));
    const result = packOutboxRows(input, options);
    expect(result.chunks).toHaveLength(8);
    expect(result.deferred).toHaveLength(74);
    expect(result).toEqual(packOutboxRows(input, options));
    for (const chunk of result.chunks) {
      expect(chunk.rows.every((entry) => entry.type === chunk.type)).toBe(true);
    }
  });

  it("maintains every bound and accounts for every row over seeded size mixtures", () => {
    let seed = 781;
    const next = (): number => (seed = (seed * 16_807) % 2_147_483_647);
    for (let run = 0; run < 8; run++) {
      const input = Array.from({ length: 150 }, (_, index) => ({
        ...row("😀中a".repeat(next() % 13_000), index),
        type: next() % 2 === 0 ? ("registration" as const) : ("distribution" as const),
      }));
      const result = packOutboxRows(input, options);
      expect(result.chunks.length).toBeLessThanOrEqual(OUTBOX_DISPATCH_MAX_SEND_CALLS);
      for (const chunk of result.chunks) {
        expect(chunk.rows.length).toBeLessThanOrEqual(SAFE_BATCH_MESSAGES);
        expect(chunk.chargedBytes).toBeLessThanOrEqual(SAFE_BATCH_BYTES);
        for (const entry of chunk.bodies) {
          expect(estimateBodyBytes(entry) + QUEUE_MESSAGE_METADATA_BYTES).toBeLessThanOrEqual(
            SAFE_MESSAGE_BYTES,
          );
        }
      }
      const partition = [
        ...result.chunks.flatMap((chunk) => chunk.rows),
        ...result.invalid,
        ...result.oversized,
        ...result.deferred,
      ];
      expect(new Set(partition.map((entry) => entry.job_id)).size).toBe(input.length);
      expect(partition).toHaveLength(input.length);
    }
  });
});

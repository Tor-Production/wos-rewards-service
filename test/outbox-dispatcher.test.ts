import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { outboxBackoffSeconds } from "../src/outbox/backoff";
import { dispatchOutbox } from "../src/outbox/dispatcher";
import {
  closeOutbox,
  countD1,
  FailingQueue,
  FIXTURE_NOW,
  RecordingQueue,
  seedOutbox,
  SizeAwareQueue,
  testConfig,
  type OutboxSeed,
} from "./support/fixtures";

const db = env.STAGING_DB;
const operations: string[] = [];

async function seed(seeds: readonly OutboxSeed[]) {
  const result = await seedOutbox(db, seeds);
  operations.push(result.operationId);
  return result;
}

afterEach(async () => {
  await closeOutbox(db, operations.splice(0));
});

async function persisted(operationId: string) {
  return (
    await db
      .prepare(
        "SELECT job_id, status, attempts, available_at, last_error, updated_at FROM outbox_jobs WHERE operation_id=?1 ORDER BY job_id",
      )
      .bind(operationId)
      .all<{
        job_id: string;
        status: string;
        attempts: number;
        available_at: string;
        last_error: string | null;
        updated_at: string;
      }>()
  ).results;
}

describe("transactional outbox dispatcher", () => {
  it("routes registration and distribution independently and preserves attempt counts", async () => {
    const fixture = await seed([
      { type: "registration" },
      { type: "distribution" },
      { type: "registration", attempts: 2 },
    ]);
    const registration = new SizeAwareQueue();
    const distribution = new SizeAwareQueue();
    const result = await dispatchOutbox({
      db,
      queues: { registration, distribution },
      config: testConfig(),
      now: FIXTURE_NOW,
      source: { kind: "scan", limit: 90 },
    });
    expect(registration.bodies).toEqual([fixture.bodies[0], fixture.bodies[2]]);
    expect(distribution.bodies).toEqual([fixture.bodies[1]]);
    expect(result).toMatchObject({ enqueued: 3, retried: 0, dead: 0, sendCalls: 2 });
    expect(
      (await persisted(fixture.operationId)).every((entry) => entry.status === "enqueued"),
    ).toBe(true);
    expect(
      (await persisted(fixture.operationId)).find(
        (entry) => entry.job_id === fixture.rows[2]!.job_id,
      )!.attempts,
    ).toBe(2);
  });

  it("backs off an inline failure and scheduled dispatch recovers exactly when due", async () => {
    const fixture = await seed([{}, {}, {}]);
    const failing = new FailingQueue();
    const config = testConfig();
    const failed = await dispatchOutbox({
      db,
      queues: { registration: failing, distribution: failing },
      config,
      now: FIXTURE_NOW,
      source: { kind: "operation", operationId: fixture.operationId, limit: 90 },
    });
    expect(failed).toMatchObject({ enqueued: 0, retried: 3, dead: 0, sendCalls: 1 });
    const due = new Date(FIXTURE_NOW.getTime() + 60_000);
    for (const entry of await persisted(fixture.operationId)) {
      expect(entry).toMatchObject({
        status: "pending",
        attempts: 1,
        available_at: due.toISOString(),
        last_error: "queue_send_failed",
        updated_at: FIXTURE_NOW.toISOString(),
      });
    }
    const working = new RecordingQueue();
    for (const source of [
      { kind: "scan" as const, limit: 90 },
      { kind: "operation" as const, operationId: fixture.operationId, limit: 90 },
    ]) {
      const early = await dispatchOutbox({
        db,
        queues: { registration: working, distribution: working },
        config,
        now: new Date(due.getTime() - 1),
        source,
      });
      expect(early.sendCalls).toBe(0);
    }
    const recovered = await dispatchOutbox({
      db,
      queues: { registration: working, distribution: working },
      config,
      now: due,
      source: { kind: "scan", limit: 90 },
    });
    expect(recovered).toMatchObject({ enqueued: 3, retried: 0, dead: 0 });
    expect(working.bodies).toEqual(fixture.bodies);
    expect((await persisted(fixture.operationId)).every((entry) => entry.last_error === null)).toBe(
      true,
    );
  });

  it.each([
    [1, 60],
    [2, 120],
    [3, 240],
    [4, 480],
    [5, 960],
    [6, 1920],
    [7, 3600],
    [40, 3600],
  ])("backs off failure %i by %i seconds", (attempts, seconds) => {
    expect(outboxBackoffSeconds(attempts)).toBe(seconds);
  });

  it("exhausts the retry cap, marks dead and never reopens or sends the row again", async () => {
    const fixture = await seed([{}]);
    const queue = new FailingQueue();
    const config = testConfig();
    let now = FIXTURE_NOW;
    for (let attempts = 1; attempts <= config.outboxDispatchMaxAttempts; attempts++) {
      const result = await dispatchOutbox({
        db,
        queues: { registration: queue, distribution: queue },
        config,
        now,
        source: { kind: "scan", limit: 90 },
      });
      const entry = (await persisted(fixture.operationId))[0]!;
      expect(entry.attempts).toBe(attempts);
      expect(entry.status).toBe(attempts === config.outboxDispatchMaxAttempts ? "dead" : "pending");
      expect(result.dead).toBe(attempts === config.outboxDispatchMaxAttempts ? 1 : 0);
      if (entry.status === "dead") expect(entry.available_at).toBe(now.toISOString());
      now = new Date(now.getTime() + outboxBackoffSeconds(attempts) * 1_000);
    }
    const before = await persisted(fixture.operationId);
    const working = new RecordingQueue();
    await dispatchOutbox({
      db,
      queues: { registration: working, distribution: working },
      config,
      now,
      source: { kind: "scan", limit: 90 },
    });
    expect(working.calls).toEqual([]);
    expect(await persisted(fixture.operationId)).toEqual(before);
    expect(queue.calls).toHaveLength(config.outboxDispatchMaxAttempts);
  });

  it("terminalizes malformed and oversized payloads without using retry attempts", async () => {
    const fixture = await seed([
      { payloadJson: "{", attempts: 2 },
      { payloadJson: '{"code":"x"}', attempts: 1 },
      {
        payloadJson: JSON.stringify({
          operation_id: "o",
          item_key: "i",
          job_id: "j",
          player_id: "1",
          code: "c",
          attempt_id: "a",
          extra: "x",
        }),
      },
      { body: { code: "😀".repeat(24_000) }, attempts: 3 },
    ]);
    const queue = new RecordingQueue();
    const result = await dispatchOutbox({
      db,
      queues: { registration: queue, distribution: queue },
      config: testConfig(),
      now: FIXTURE_NOW,
      source: { kind: "scan", limit: 90 },
    });
    expect(result).toMatchObject({ enqueued: 0, retried: 0, dead: 4, sendCalls: 0 });
    expect(queue.calls).toEqual([]);
    const entries = await persisted(fixture.operationId);
    expect(entries.map((entry) => entry.attempts)).toEqual([2, 1, 0, 3]);
    expect(entries.map((entry) => entry.last_error)).toEqual([
      "payload_invalid",
      "payload_invalid",
      "payload_invalid",
      "payload_too_large",
    ]);
    await dispatchOutbox({
      db,
      queues: { registration: queue, distribution: queue },
      config: testConfig(),
      now: new Date(FIXTURE_NOW.getTime() + 10_000_000),
      source: { kind: "scan", limit: 90 },
    });
    expect(await persisted(fixture.operationId)).toEqual(entries);
    expect(queue.calls).toEqual([]);
  });

  it("defers excess byte-sized chunks untouched and clamps an oversized scan limit", async () => {
    const fixture = await seed(
      Array.from({ length: 100 }, () => ({ body: { code: "a".repeat(95_000) } })),
    );
    const before = await persisted(fixture.operationId);
    const queue = new SizeAwareQueue();
    const counted = countD1(db);
    const result = await dispatchOutbox({
      db: counted.db,
      queues: { registration: queue, distribution: queue },
      config: testConfig(),
      now: FIXTURE_NOW,
      source: { kind: "scan", limit: 1_000 },
    });
    expect(result).toMatchObject({ enqueued: 16, deferred: 74, sendCalls: 8 });
    const after = await persisted(fixture.operationId);
    expect(after.filter((entry) => entry.status === "pending")).toEqual(before.slice(16));
    expect(counted.stats.prepared[0]!.bindings).toEqual([FIXTURE_NOW.toISOString(), 90]);
  });

  it("inline reads only fresh due work while scheduled dispatch owns retries", async () => {
    const fixture = await seed([
      {},
      { attempts: 1 },
      { availableAt: new Date(FIXTURE_NOW.getTime() + 1) },
    ]);
    const queue = new RecordingQueue();
    const result = await dispatchOutbox({
      db,
      queues: { registration: queue, distribution: queue },
      config: testConfig(),
      now: FIXTURE_NOW,
      source: { kind: "operation", operationId: fixture.operationId, limit: 90 },
    });
    expect(result.enqueued).toBe(1);
    expect(queue.bodies).toEqual([fixture.bodies[0]]);
    expect((await persisted(fixture.operationId)).map((entry) => entry.status)).toEqual([
      "enqueued",
      "pending",
      "pending",
    ]);
  });

  it("honors a lowered retry cap without sending or regressing older exhausted counters", async () => {
    const fixture = await seed([{ attempts: 3 }, { attempts: 5 }, { attempts: 2 }]);
    const queue = new FailingQueue();
    const result = await dispatchOutbox({
      db,
      queues: { registration: queue, distribution: queue },
      config: testConfig({ outboxDispatchMaxAttempts: 3 }),
      now: FIXTURE_NOW,
      source: { kind: "scan", limit: 90 },
    });
    expect(queue.bodies).toEqual([fixture.bodies[2]]);
    expect(result.dead).toBe(3);
    expect((await persisted(fixture.operationId)).map((entry) => entry.attempts)).toEqual([
      3, 5, 3,
    ]);
    expect(result.d1Statements).toBe(2);
  });
});

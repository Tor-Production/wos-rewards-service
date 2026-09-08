import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import type { QueueProducer } from "../src/domain/queue-jobs";
import { QUEUE_SEND_CONCURRENCY, SIMULTANEOUS_OPEN_CONNECTIONS_LIMIT } from "../src/limits";
import { dispatchOutbox } from "../src/outbox/dispatcher";
import {
  closeOutbox,
  ConcurrencyTrackingQueue,
  FailingQueue,
  FIXTURE_NOW,
  RecordingQueue,
  seedOutbox,
  testConfig,
} from "./support/fixtures";

const db = env.STAGING_DB;
const operations: string[] = [];
afterEach(async () => closeOutbox(db, operations.splice(0)));

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("outbox send concurrency and stale dispatcher writes", () => {
  it.each(["scan", "operation"] as const)(
    "%s awaits each slow batch across both queues (one connection)",
    async (kind) => {
      const fixture = await seedOutbox(
        db,
        Array.from({ length: 12 }, (_, index) => ({
          type: index % 2 === 0 ? ("registration" as const) : ("distribution" as const),
          body: { code: "😀中".repeat(10_000) },
        })),
      );
      operations.push(fixture.operationId);
      const tracker = { inFlight: 0, maxInFlight: 0 };
      const registration = new ConcurrencyTrackingQueue(tracker);
      const distribution = new ConcurrencyTrackingQueue(tracker);
      const result = await dispatchOutbox({
        db,
        queues: { registration, distribution },
        config: testConfig(),
        now: FIXTURE_NOW,
        source:
          kind === "scan"
            ? { kind, limit: 90 }
            : { kind, operationId: fixture.operationId, limit: 90 },
      });
      expect(result.enqueued).toBe(12);
      expect(result.sendCalls).toBe(6);
      expect(registration.calls).toHaveLength(3);
      expect(distribution.calls).toHaveLength(3);
      expect(tracker.inFlight).toBe(0);
      expect(tracker.maxInFlight).toBe(QUEUE_SEND_CONCURRENCY);
      expect(tracker.maxInFlight).toBe(1);
      expect(tracker.maxInFlight).toBeLessThanOrEqual(SIMULTANEOUS_OPEN_CONNECTIONS_LIMIT);
      expect(result.maxInFlightSends).toBe(tracker.maxInFlight);
    },
  );

  it("allows duplicate producer sends while marking a pending row enqueued only once", async () => {
    const fixture = await seedOutbox(db, [{}]);
    operations.push(fixture.operationId);
    const bothStarted = latch();
    let sends = 0;
    const queue: QueueProducer = {
      async sendBatch() {
        sends++;
        if (sends === 2) bothStarted.resolve();
        await bothStarted.promise;
      },
    };
    const input = {
      db,
      queues: { registration: queue, distribution: queue },
      config: testConfig(),
      now: FIXTURE_NOW,
      source: { kind: "operation" as const, operationId: fixture.operationId, limit: 90 },
    };
    const results = await Promise.all([dispatchOutbox(input), dispatchOutbox(input)]);
    expect(sends).toBe(2);
    expect(results.reduce((sum, result) => sum + result.enqueued, 0)).toBe(1);
    expect(
      await db
        .prepare("SELECT status, attempts FROM outbox_jobs WHERE job_id=?1")
        .bind(fixture.rows[0]!.job_id)
        .first(),
    ).toEqual({ status: "enqueued", attempts: 0 });
  });

  it("a slow failure cannot regress a newer retry count or its available_at", async () => {
    const fixture = await seedOutbox(db, [{}]);
    operations.push(fixture.operationId);
    const started = latch();
    const release = latch();
    const slowFailure: QueueProducer = {
      async sendBatch() {
        started.resolve();
        await release.promise;
        throw new Error("synthetic delayed failure");
      },
    };
    const input = {
      db,
      config: testConfig(),
      source: { kind: "scan" as const, limit: 90 },
    };
    const pending = dispatchOutbox({
      ...input,
      now: FIXTURE_NOW,
      queues: { registration: slowFailure, distribution: slowFailure },
    });
    await started.promise;
    const failing = new FailingQueue();
    await dispatchOutbox({
      ...input,
      now: new Date(FIXTURE_NOW.getTime() + 1_000),
      queues: { registration: failing, distribution: failing },
    });
    await dispatchOutbox({
      ...input,
      now: new Date(FIXTURE_NOW.getTime() + 61_000),
      queues: { registration: failing, distribution: failing },
    });
    const statement = db
      .prepare("SELECT status, attempts, available_at, updated_at FROM outbox_jobs WHERE job_id=?1")
      .bind(fixture.rows[0]!.job_id);
    const before = await statement.first();
    expect(before).toEqual({
      status: "pending",
      attempts: 2,
      available_at: new Date(FIXTURE_NOW.getTime() + 181_000).toISOString(),
      updated_at: new Date(FIXTURE_NOW.getTime() + 61_000).toISOString(),
    });
    release.resolve();
    expect((await pending).retried).toBe(0);
    expect(await statement.first()).toEqual(before);
  });

  it("a failure settling after another dispatcher's success cannot revert enqueued", async () => {
    const fixture = await seedOutbox(db, [{}]);
    operations.push(fixture.operationId);
    const started = latch();
    const release = latch();
    const failing: QueueProducer = {
      async sendBatch() {
        started.resolve();
        await release.promise;
        throw new Error("synthetic stale failure");
      },
    };
    const input = {
      db,
      config: testConfig(),
      now: FIXTURE_NOW,
      source: { kind: "operation" as const, operationId: fixture.operationId, limit: 90 },
    };
    const delayed = dispatchOutbox({
      ...input,
      queues: { registration: failing, distribution: failing },
    });
    await started.promise;
    const success = new RecordingQueue();
    await dispatchOutbox({ ...input, queues: { registration: success, distribution: success } });
    release.resolve();
    expect((await delayed).retried).toBe(0);
    expect(
      await db
        .prepare("SELECT status, attempts, last_error FROM outbox_jobs WHERE job_id=?1")
        .bind(fixture.rows[0]!.job_id)
        .first(),
    ).toEqual({ status: "enqueued", attempts: 0, last_error: null });
  });
});

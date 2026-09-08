import { createExecutionContext, createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueProducer, RedemptionJobBody } from "../src/domain/queue-jobs";
import worker from "../src/index";
import { deterministicUuid } from "../src/ingest/identity";
import {
  D1_MAX_BOUND_PARAMETERS_PER_QUERY,
  D1_QUERIES_PER_INVOCATION_FLOOR,
  D1_STATEMENT_BUDGET,
  IDS_PER_UPDATE,
  INTERNAL_SUBREQUESTS_PER_INVOCATION_FLOOR,
  markingStatementsMax,
  OUTBOX_DISPATCH_MAX_SEND_CALLS,
  QUEUE_SEND_CONCURRENCY,
  REGULAR_SUBREQUESTS_PER_INVOCATION_FLOOR,
  SIMULTANEOUS_OPEN_CONNECTIONS_LIMIT,
} from "../src/limits";
import { prepareOutboxMarks, type OutboxMark } from "../src/outbox/marking";
import type { OutboxRow } from "../src/outbox/packing";
import {
  closeOutbox,
  ConcurrencyTrackingQueue,
  countD1,
  disableCodes,
  FIXTURE_NOW,
  ingestRequest,
  makeEvent,
  RecordingQueue,
  seedCodes,
  seedOutbox,
  uniqueId,
} from "./support/fixtures";

const db = env.STAGING_DB;
const codes: string[] = [];
const operations: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await disableCodes(db, codes.splice(0));
  await closeOutbox(db, operations.splice(0));
});

function invocationEnv(
  database: D1Database,
  registration: QueueProducer,
  distribution: QueueProducer,
): Env {
  return {
    ...env,
    STAGING_DB: database,
    REGISTRATION_JOBS_QUEUE: registration as Env["REGISTRATION_JOBS_QUEUE"],
    CODE_FANOUT_JOBS_QUEUE: distribution as Env["CODE_FANOUT_JOBS_QUEUE"],
  };
}

function proveIndependentLimits(
  d1Statements: number,
  queueCalls: number,
  externalCalls: number,
  maxInFlight: number,
): void {
  expect(d1Statements).toBeLessThanOrEqual(D1_STATEMENT_BUDGET);
  expect(d1Statements).toBeLessThanOrEqual(D1_QUERIES_PER_INVOCATION_FLOOR);
  expect(d1Statements + queueCalls).toBeLessThanOrEqual(INTERNAL_SUBREQUESTS_PER_INVOCATION_FLOOR);
  expect(externalCalls).toBe(0);
  expect(externalCalls).toBeLessThanOrEqual(REGULAR_SUBREQUESTS_PER_INVOCATION_FLOOR);
  expect(queueCalls).toBeLessThanOrEqual(OUTBOX_DISPATCH_MAX_SEND_CALLS);
  expect(maxInFlight).toBeLessThanOrEqual(QUEUE_SEND_CONCURRENCY);
  expect(maxInFlight).toBeLessThanOrEqual(SIMULTANEOUS_OPEN_CONNECTIONS_LIMIT);
}

function prohibitFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("external fetch is prohibited in Phase 3");
  });
}

describe("four independent invocation budgets", () => {
  it("bounds full valid ingest with eight byte-limited Queue sends and mixed outcomes", async () => {
    const suffix = uniqueId();
    const activeCodes = Array.from(
      { length: 90 },
      (_, index) => `${suffix}-${String(index).padStart(3, "0")}-${"a".repeat(20_000)}`,
    );
    codes.push(...activeCodes);
    await seedCodes(db, activeCodes);
    const event = makeEvent();
    operations.push(await deterministicUuid(`registration:${event.event_id}`));
    const counted = countD1(db);
    const tracker = { inFlight: 0, maxInFlight: 0 };
    class AlternatingQueue extends ConcurrencyTrackingQueue {
      override async sendBatch(messages: Iterable<{ body: RedemptionJobBody }>): Promise<void> {
        await super.sendBatch(messages);
        if (this.calls.length % 2 === 0) throw new Error("synthetic alternating failure");
      }
    }
    const registration = new AlternatingQueue(tracker);
    const distribution = new RecordingQueue();
    const fetchSpy = prohibitFetch();
    const response = await worker.fetch(
      ingestRequest(event),
      invocationEnv(counted.db, registration, distribution),
      createExecutionContext(),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    expect(counted.stats.batchSizes[0]).toBe(6);
    expect(counted.stats.statements).toBeLessThanOrEqual(11);
    expect(registration.calls).toHaveLength(8);
    expect(distribution.calls).toHaveLength(0);
    expect(counted.stats.statements + registration.calls.length).toBeLessThanOrEqual(19);
    expect(tracker.maxInFlight).toBe(1);
    expect(counted.stats.maxBindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS_PER_QUERY);
    proveIndependentLimits(
      counted.stats.statements,
      registration.calls.length,
      fetchSpy.mock.calls.length,
      tracker.maxInFlight,
    );
  });

  it("invalid ingest executes exactly two statements and no Queue or external call", async () => {
    const counted = countD1(db);
    const queue = new RecordingQueue();
    const fetchSpy = prohibitFetch();
    const response = await worker.fetch(
      ingestRequest(makeEvent({ content: "synthetic-invalid" })),
      invocationEnv(counted.db, queue, queue),
      createExecutionContext(),
    );
    expect(response.status).toBe(202);
    expect(counted.stats.batchSizes).toEqual([2]);
    expect(counted.stats.statements).toBe(2);
    expect(queue.calls).toHaveLength(0);
    proveIndependentLimits(
      counted.stats.statements,
      queue.calls.length,
      fetchSpy.mock.calls.length,
      0,
    );
  });

  it("failed acceptance counts all six attempted batch members and two structural reads", async () => {
    const rejecting = new Proxy(db, {
      get(target, property) {
        if (property === "batch")
          return async () => {
            throw new Error("synthetic D1 failure");
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const counted = countD1(rejecting);
    const queue = new RecordingQueue();
    const fetchSpy = prohibitFetch();
    const response = await worker.fetch(
      ingestRequest(makeEvent()),
      invocationEnv(counted.db, queue, queue),
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(counted.stats.batchSizes).toEqual([6]);
    expect(counted.stats.statements).toBe(8);
    expect(queue.calls).toHaveLength(0);
    proveIndependentLimits(counted.stats.statements, 0, fetchSpy.mock.calls.length, 0);
  });

  it("attains scheduled's nine D1 statements and seventeen internal calls across all eight groups", async () => {
    const fixture = await seedOutbox(db, [
      { body: { code: "a".repeat(95_000) } },
      { payloadJson: "{" },
      { body: { code: "a".repeat(96_001) } },
      ...Array.from({ length: 87 }, (_, index) => ({
        type: "distribution" as const,
        attempts: index % 5,
        body: { code: "a".repeat(95_000) },
      })),
    ]);
    operations.push(fixture.operationId);
    const counted = countD1(db);
    const tracker = { inFlight: 0, maxInFlight: 0 };
    const registration = new ConcurrencyTrackingQueue(tracker);
    class TrackedFailure extends ConcurrencyTrackingQueue {
      override async sendBatch(messages: Iterable<{ body: RedemptionJobBody }>): Promise<void> {
        await super.sendBatch(messages);
        throw new Error("synthetic scheduled queue failure");
      }
    }
    const distribution = new TrackedFailure(tracker);
    const fetchSpy = prohibitFetch();
    await worker.scheduled(
      createScheduledController(),
      invocationEnv(counted.db, registration, distribution),
      createExecutionContext(),
    );
    const sends = registration.calls.length + distribution.calls.length;
    expect(sends).toBe(8);
    expect(counted.stats.batchSizes).toEqual([8]);
    expect(counted.stats.statements).toBe(9);
    expect(counted.stats.statements + sends).toBe(17);
    expect(counted.stats.maxBindings).toBeLessThanOrEqual(94);
    expect(tracker.maxInFlight).toBe(1);
    proveIndependentLimits(
      counted.stats.statements,
      sends,
      fetchSpy.mock.calls.length,
      tracker.maxInFlight,
    );
    const rows = (
      await db
        .prepare(
          "SELECT status, attempts, last_error, COUNT(*) AS n FROM outbox_jobs WHERE operation_id=?1 GROUP BY status, attempts, last_error",
        )
        .bind(fixture.operationId)
        .all<{ status: string; attempts: number; last_error: string | null; n: number }>()
    ).results;
    expect(rows.find((row) => row.status === "enqueued")!.n).toBe(1);
    expect(rows.find((row) => row.last_error === "payload_invalid")!.n).toBe(1);
    expect(rows.find((row) => row.last_error === "payload_too_large")!.n).toBe(1);
    expect(
      rows
        .filter((row) => row.last_error === "queue_send_failed")
        .map((row) => row.attempts)
        .sort(),
    ).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("tight bulk-marking statement bound", () => {
  function marksForGroups(sizes: readonly number[]): OutboxMark[] {
    return sizes.flatMap((size, group) =>
      Array.from({ length: size }, (_, index): OutboxMark => {
        const row: OutboxRow = {
          job_id: `synthetic:${group}:${index}`,
          type: "registration",
          payload_json: "{}",
          attempts: Math.max(0, group - 3),
        };
        if (group === 0) return { kind: "enqueued", row };
        if (group === 1) return { kind: "payload_invalid", row };
        if (group === 2) return { kind: "payload_too_large", row };
        return { kind: "queue_send_failed", row };
      }),
    );
  }

  it.each([
    { name: "all rows in one group", sizes: [90], exact: 1 },
    {
      name: "seven singleton groups plus the attaining large group",
      sizes: [83, 1, 1, 1, 1, 1, 1, 1],
      exact: 8,
    },
    { name: "every group nonempty", sizes: [12, 12, 11, 11, 11, 11, 11, 11], exact: 8 },
    { name: "fewer rows than G_MAX", sizes: [1, 1, 1], exact: 3 },
    { name: "zero rows", sizes: [], exact: 0 },
    {
      name: "more than one ID chunk in the attaining group",
      sizes: [176, 1, 1, 1, 1, 1, 1, 1],
      exact: 9,
    },
  ])("$name", ({ sizes, exact }) => {
    const marks = marksForGroups(sizes);
    const counted = countD1(db);
    const plan = prepareOutboxMarks(counted.db, marks, FIXTURE_NOW, 5);
    expect(plan.statements.length).toBe(exact);
    expect(plan.statements.length).toBeLessThanOrEqual(markingStatementsMax(marks.length, 8));
    expect(counted.stats.maxBindings).toBeLessThanOrEqual(IDS_PER_UPDATE + 4);
    expect(counted.stats.maxBindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS_PER_QUERY);
    expect(markingStatementsMax(90, 8)).toBe(8);
    expect(markingStatementsMax(90, 4)).toBe(4);
    // All prepared marks are guarded, and the smallest/attaining cases prove tightness.
    expect(
      counted.stats.prepared.every((statement) => statement.sql.includes("WHERE status='pending'")),
    ).toBe(true);
    if (sizes.length !== 1)
      expect(plan.statements.length).toBe(markingStatementsMax(marks.length, 8));
  });
});

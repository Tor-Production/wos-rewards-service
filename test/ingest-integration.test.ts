import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { deterministicUuid } from "../src/ingest/identity";
import {
  closeOutbox,
  disableCodes,
  FailingQueue,
  ingestRequest,
  makeEvent,
  RecordingQueue,
  seedCodes,
  seedOutbox,
  uniqueId,
} from "./support/fixtures";

const codes: string[] = [];
const operations: string[] = [];
afterEach(async () => {
  await disableCodes(env.STAGING_DB, codes.splice(0));
  await closeOutbox(env.STAGING_DB, operations.splice(0));
});

describe("full Workers runtime ingestion", () => {
  it("persists invalid registration without sending or exposing business outcome", async () => {
    const event = makeEvent({ content: "invalid synthetic registration" });
    const response = await exports.default.fetch(ingestRequest(event));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    const marker = await env.STAGING_DB.prepare(
      "SELECT status, validation_reason, operation_id FROM processed_events WHERE event_id=?",
    )
      .bind(event.event_id)
      .first();
    expect(marker).toEqual({
      status: "accepted_invalid",
      validation_reason: "player_id_not_numeric",
      operation_id: null,
    });
    expect(
      await env.STAGING_DB.prepare(
        "SELECT status, has_footer FROM discord_output_deliveries WHERE event_id=?",
      )
        .bind(event.event_id)
        .first(),
    ).toEqual({ status: "pending", has_footer: 0 });
  });
  it("accepts zero codes and absorbs the duplicate through the public route", async () => {
    const event = makeEvent();
    const operationId = await deterministicUuid(`registration:${event.event_id}`);
    operations.push(operationId);
    const first = await exports.default.fetch(ingestRequest(event));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "accepted" });
    expect(
      await env.STAGING_DB.prepare(
        "SELECT expected_count, expansion_state FROM operations WHERE operation_id=?",
      )
        .bind(operationId)
        .first(),
    ).toEqual({ expected_count: 0, expansion_state: "expanded" });
    const duplicate = await exports.default.fetch(ingestRequest(event));
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toEqual({ status: "duplicate" });
  });
  it("accepts multiple codes and sends through actual local Queue bindings without consumers", async () => {
    const seeded = [uniqueId(), uniqueId(), uniqueId()];
    codes.push(...seeded);
    await seedCodes(env.STAGING_DB, seeded);
    const event = makeEvent({ content: `${uniqueId()} 0007 Frost Wolf` });
    const operationId = await deterministicUuid(`registration:${event.event_id}`);
    operations.push(operationId);
    const response = await exports.default.fetch(ingestRequest(event));
    expect(response.status).toBe(202);
    const rows = await env.STAGING_DB.prepare(
      "SELECT status, attempts, payload_json FROM outbox_jobs WHERE operation_id=?",
    )
      .bind(operationId)
      .all<{ status: string; attempts: number; payload_json: string }>();
    expect(rows.results).toHaveLength(3);
    for (const row of rows.results) {
      expect(row.status).toBe("enqueued");
      expect(row.attempts).toBe(0);
    }
    // This call uses Miniflare's real binding. Without a consumer messages are discarded locally.
    await env.REGISTRATION_JOBS_QUEUE.sendBatch([
      { body: JSON.parse(rows.results[0]!.payload_json) },
    ]);
  });
  it("keeps accepted HTTP status after inline queue failure and recovers on scheduled run", async () => {
    const code = uniqueId();
    codes.push(code);
    await seedCodes(env.STAGING_DB, [code]);
    const event = makeEvent();
    const operationId = await deterministicUuid(`registration:${event.event_id}`);
    operations.push(operationId);
    const failed = new FailingQueue();
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      ingestRequest(event),
      { ...env, REGISTRATION_JOBS_QUEUE: failed } as unknown as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    const row = await env.STAGING_DB.prepare(
      "SELECT status, attempts, last_error, available_at FROM outbox_jobs WHERE operation_id=?",
    )
      .bind(operationId)
      .first<{ status: string; attempts: number; last_error: string; available_at: string }>();
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_error: "queue_send_failed" });
    expect(Date.parse(row!.available_at)).toBeGreaterThan(Date.now());
    // Advance only this synthetic row to due; no clock sleeps or remote queue.
    await env.STAGING_DB.prepare("UPDATE outbox_jobs SET available_at=? WHERE operation_id=?")
      .bind("2015-01-01T00:00:00.000Z", operationId)
      .run();
    const queue = new RecordingQueue();
    await worker.scheduled(
      createScheduledController(),
      { ...env, REGISTRATION_JOBS_QUEUE: queue } as unknown as Env,
      createExecutionContext(),
    );
    expect(queue.bodies.filter((body) => body.operation_id === operationId)).toHaveLength(1);
    expect(
      await env.STAGING_DB.prepare("SELECT status, attempts FROM outbox_jobs WHERE operation_id=?")
        .bind(operationId)
        .first(),
    ).toEqual({ status: "enqueued", attempts: 1 });
  });
  it("scheduled uses local Queues and fails closed for unsafe configuration", async () => {
    const seeded = await seedOutbox(env.STAGING_DB, [{}, { type: "distribution" }]);
    operations.push(seeded.operationId);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(
      (
        await env.STAGING_DB.prepare("SELECT status FROM outbox_jobs WHERE operation_id=?")
          .bind(seeded.operationId)
          .all()
      ).results,
    ).toEqual([{ status: "enqueued" }, { status: "enqueued" }]);
    await expect(
      worker.scheduled(
        createScheduledController(),
        { ...env, CODE_DISCOVERY_ENABLED: true } as unknown as Env,
        createExecutionContext(),
      ),
    ).rejects.toThrow("CODE_DISCOVERY_ENABLED must be false");
  });
});

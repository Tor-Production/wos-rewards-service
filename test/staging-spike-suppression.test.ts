import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { dispatchOutput } from "../src/discord/delivery";
import {
  contentHash,
  deliveryId,
  deterministicUuid,
  eventDeliveryGroup,
  nonceFor,
} from "../src/ingest/identity";
import { parseRegistration } from "../src/ingest/registration-parser";
import { validationReply } from "../src/ingest/validation-reply";
import {
  countD1,
  ingestRequest,
  makeEvent,
  RecordingQueue,
  testConfig,
  uniqueId,
} from "./support/fixtures";

function spikeEnvironment(
  senderId: string,
  db: D1Database = env.STAGING_DB,
): { runtime: Env; registration: RecordingQueue; distribution: RecordingQueue } {
  const registration = new RecordingQueue();
  const distribution = new RecordingQueue();
  return {
    runtime: {
      ...env,
      STAGING_DB: db,
      SPIKE_SENDER_ALLOWLIST: senderId,
      REGISTRATION_JOBS_QUEUE: registration,
      CODE_FANOUT_JOBS_QUEUE: distribution,
    } as unknown as Env,
    registration,
    distribution,
  };
}

async function expectNoWork(eventId: string): Promise<void> {
  const operationId = await deterministicUuid(`registration:${eventId}`);
  expect(
    await env.STAGING_DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE operation_id=?1")
      .bind(operationId)
      .first("n"),
  ).toBe(0);
  for (const table of ["operation_items", "outbox_jobs"]) {
    expect(
      await env.STAGING_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE operation_id=?1`)
        .bind(operationId)
        .first("n"),
    ).toBe(0);
  }
}

describe("immutable staging-spike acceptance", () => {
  it.each(["bot", "webhook"] as const)(
    "atomically retains exact terminal evidence for an authenticated allow-listed staging %s",
    async (kind) => {
      const senderId = uniqueId();
      const event = makeEvent({
        author_id: kind === "bot" ? senderId : uniqueId(),
        author_is_bot: kind === "bot",
        webhook_id: kind === "webhook" ? senderId : null,
        content: `SPIKE-1-${crypto.randomUUID()}`,
      });
      const counted = countD1(env.STAGING_DB);
      const { runtime, registration, distribution } = spikeEnvironment(senderId, counted.db);
      const response = await worker.fetch(ingestRequest(event), runtime, createExecutionContext());
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "accepted" });
      expect(counted.stats.batchSizes).toEqual([2]);
      expect(counted.stats.statements).toBe(2);

      const parsed = parseRegistration(event.content, testConfig().defaultState);
      if (parsed.ok) throw new Error("spike fixture must remain intentionally invalid");
      const group = eventDeliveryGroup(event.event_id);
      const id = deliveryId(group, 1);
      const content = validationReply(parsed.reason);
      const marker = await env.STAGING_DB.prepare(
        "SELECT * FROM processed_events WHERE event_id=?1",
      )
        .bind(event.event_id)
        .first<Record<string, unknown>>();
      expect(marker).toMatchObject({
        event_id: event.event_id,
        kind: "registration",
        acceptance_class: "staging_spike",
        status: "finalized",
        outcome: "invalid",
        operation_id: null,
        validation_reason: parsed.reason,
        output_delivery_group: group,
        committed_at: null,
      });
      expect(marker?.received_at).toBe(marker?.accepted_at);
      expect(marker?.finalized_at).toBe(marker?.accepted_at);

      expect(
        await env.STAGING_DB.prepare("SELECT * FROM discord_output_deliveries WHERE event_id=?1")
          .bind(event.event_id)
          .first(),
      ).toMatchObject({
        delivery_id: id,
        delivery_group: group,
        event_id: event.event_id,
        operation_id: null,
        channel_id: event.channel_id,
        output_type: "validation_reply",
        chunk_index: 1,
        chunk_total: 1,
        content,
        content_hash: await contentHash(content),
        has_footer: 0,
        nonce: await nonceFor(id),
        status: "superseded",
        dispatch_eligible: 0,
        suppression_reason: "staging_spike_sender",
        suppressed_at: marker?.accepted_at,
        permanent_dispatch_block: 1,
        blocked_at: marker?.accepted_at,
        claim_token: null,
        claim_expires_at: null,
        attempts: 0,
        discord_message_id: null,
        sent_at: null,
        available_at: null,
        last_error: null,
        alerted_at: null,
        created_at: marker?.accepted_at,
        updated_at: marker?.accepted_at,
      });
      expect(counted.stats.prepared[0]?.bindings).toContain("finalized");
      expect(counted.stats.prepared[1]?.bindings).toContain("superseded");
      expect(counted.stats.prepared[1]?.bindings).not.toContain("pending");
      await expectNoWork(event.event_id);
      expect(registration.calls).toEqual([]);
      expect(distribution.calls).toEqual([]);
      expect(await env.STAGING_DB.prepare("SELECT COUNT(*) AS n FROM redemptions").first("n")).toBe(
        0,
      );
      // The configured outbound service throws on any unhandled request; reaching this point also
      // proves acceptance made no Discord, provider, or other network call.
    },
  );

  it("keeps an allow-listed human on the normal invalid path", async () => {
    const authorId = uniqueId();
    const event = makeEvent({
      author_id: authorId,
      author_is_bot: false,
      webhook_id: null,
      content: "invalid human registration",
    });
    const { runtime } = spikeEnvironment(authorId);
    const response = await worker.fetch(ingestRequest(event), runtime, createExecutionContext());
    expect(response.status).toBe(202);
    expect(
      await env.STAGING_DB.prepare(
        "SELECT acceptance_class,status,finalized_at FROM processed_events WHERE event_id=?1",
      )
        .bind(event.event_id)
        .first(),
    ).toEqual({ acceptance_class: "normal", status: "accepted_invalid", finalized_at: null });
    expect(
      await env.STAGING_DB.prepare(
        `SELECT status,dispatch_eligible,suppression_reason,suppressed_at,
                permanent_dispatch_block,blocked_at
         FROM discord_output_deliveries WHERE event_id=?1`,
      )
        .bind(event.event_id)
        .first(),
    ).toEqual({
      status: "pending",
      dispatch_eligible: 1,
      suppression_reason: null,
      suppressed_at: null,
      permanent_dispatch_block: 0,
      blocked_at: null,
    });
  });

  it.each(["bot", "webhook"] as const)(
    "ignores a non-allow-listed staging %s without touching D1",
    async (kind) => {
      const event = makeEvent({
        author_is_bot: kind === "bot",
        webhook_id: kind === "webhook" ? uniqueId() : null,
        content: `SPIKE-2-${crypto.randomUUID()}`,
      });
      const counted = countD1(env.STAGING_DB);
      const { runtime } = spikeEnvironment(uniqueId(), counted.db);
      const response = await worker.fetch(ingestRequest(event), runtime, createExecutionContext());
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "ignored" });
      expect(counted.stats.statements).toBe(0);
    },
  );

  it("rejects production-shaped configuration before classification and D1 access", async () => {
    const senderId = uniqueId();
    const event = makeEvent({
      author_id: senderId,
      author_is_bot: true,
      content: `SPIKE-3-${crypto.randomUUID()}`,
    });
    const counted = countD1(env.STAGING_DB);
    const { runtime } = spikeEnvironment(senderId, counted.db);
    const response = await worker.fetch(
      ingestRequest(event),
      { ...runtime, ENVIRONMENT: "production" } as unknown as Env,
      createExecutionContext(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "invalid_configuration" });
    expect(counted.stats.statements).toBe(0);
  });

  it("rejects an unauthenticated allow-listed bot before parsing, classification, or D1 access", async () => {
    const senderId = uniqueId();
    const event = makeEvent({
      author_id: senderId,
      author_is_bot: true,
      content: `SPIKE-4-${crypto.randomUUID()}`,
    });
    const request = ingestRequest(event);
    request.headers.delete("authorization");
    const counted = countD1(env.STAGING_DB);
    const { runtime } = spikeEnvironment(senderId, counted.db);
    const response = await worker.fetch(request, runtime, createExecutionContext());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(counted.stats.statements).toBe(0);
  });

  it("absorbs a duplicate spike event without another marker or output", async () => {
    const senderId = uniqueId();
    const event = makeEvent({
      author_id: senderId,
      author_is_bot: true,
      content: `SPIKE-5-${crypto.randomUUID()}`,
    });
    const { runtime } = spikeEnvironment(senderId);
    const first = await worker.fetch(ingestRequest(event), runtime, createExecutionContext());
    const before = await env.STAGING_DB.prepare(
      `SELECT e.*,d.* FROM processed_events e
       JOIN discord_output_deliveries d ON d.event_id=e.event_id WHERE e.event_id=?1`,
    )
      .bind(event.event_id)
      .first();
    const second = await worker.fetch(ingestRequest(event), runtime, createExecutionContext());
    expect(await first.json()).toEqual({ status: "accepted" });
    expect(await second.json()).toEqual({ status: "duplicate" });
    expect(
      await env.STAGING_DB.prepare("SELECT COUNT(*) AS n FROM processed_events WHERE event_id=?1")
        .bind(event.event_id)
        .first("n"),
    ).toBe(1);
    expect(
      await env.STAGING_DB.prepare(
        "SELECT COUNT(*) AS n FROM discord_output_deliveries WHERE event_id=?1",
      )
        .bind(event.event_id)
        .first("n"),
    ).toBe(1);
    expect(
      await env.STAGING_DB.prepare(
        `SELECT e.*,d.* FROM processed_events e
         JOIN discord_output_deliveries d ON d.event_id=e.event_id WHERE e.event_id=?1`,
      )
        .bind(event.event_id)
        .first(),
    ).toEqual(before);
  });

  it("rolls back both directions when either statement in the spike batch fails", async () => {
    const firstSender = uniqueId();
    const firstEvent = makeEvent({
      author_id: firstSender,
      author_is_bot: true,
      content: `SPIKE-6-${crypto.randomUUID()}`,
    });
    await env.STAGING_DB.prepare(
      `INSERT INTO processed_events
       (event_id,kind,status,outcome,validation_reason,output_delivery_group,received_at,accepted_at)
       VALUES (?1,'registration','accepted_invalid','invalid','player_id_not_numeric',?2,?3,?3)`,
    )
      .bind(firstEvent.event_id, eventDeliveryGroup(firstEvent.event_id), new Date().toISOString())
      .run();
    const { runtime: firstRuntime } = spikeEnvironment(firstSender);
    const firstFailure = await worker.fetch(
      ingestRequest(firstEvent),
      firstRuntime,
      createExecutionContext(),
    );
    expect(await firstFailure.json()).toEqual({ status: "duplicate" });
    expect(
      await env.STAGING_DB.prepare(
        "SELECT COUNT(*) AS n FROM discord_output_deliveries WHERE event_id=?1",
      )
        .bind(firstEvent.event_id)
        .first("n"),
    ).toBe(0);

    const secondSender = uniqueId();
    const secondEvent = makeEvent({
      author_id: secondSender,
      author_is_bot: true,
      content: `SPIKE-7-${crypto.randomUUID()}`,
    });
    const group = eventDeliveryGroup(secondEvent.event_id);
    await env.STAGING_DB.prepare(
      `INSERT INTO discord_output_deliveries
       (delivery_id,delivery_group,channel_id,output_type,chunk_index,chunk_total,
        content,content_hash,nonce)
       VALUES (?1,?2,?3,'validation_reply',1,1,'collision','hash','nonce')`,
    )
      .bind(deliveryId(group, 1), group, secondEvent.channel_id)
      .run();
    const { runtime: secondRuntime } = spikeEnvironment(secondSender);
    const secondFailure = await worker.fetch(
      ingestRequest(secondEvent),
      secondRuntime,
      createExecutionContext(),
    );
    expect(secondFailure.status).toBe(503);
    expect(await secondFailure.json()).toEqual({ error: "unavailable" });
    expect(
      await env.STAGING_DB.prepare("SELECT 1 FROM processed_events WHERE event_id=?1")
        .bind(secondEvent.event_id)
        .first(),
    ).toBeNull();
    expect(
      await env.STAGING_DB.prepare(
        "SELECT event_id FROM discord_output_deliveries WHERE delivery_id=?1",
      )
        .bind(deliveryId(group, 1))
        .first(),
    ).toEqual({ event_id: null });
  });

  it("fails closed if a spike sender unexpectedly emits valid registration syntax", async () => {
    const senderId = uniqueId();
    const event = makeEvent({ author_id: senderId, author_is_bot: true, content: uniqueId() });
    const counted = countD1(env.STAGING_DB);
    const { runtime, registration, distribution } = spikeEnvironment(senderId, counted.db);
    const response = await worker.fetch(ingestRequest(event), runtime, createExecutionContext());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(counted.stats.statements).toBe(0);
    expect(registration.calls).toEqual([]);
    expect(distribution.calls).toEqual([]);
    await expectNoWork(event.event_id);
  });

  it("sends a normal eligible reply while every dispatcher guard leaves spike evidence untouched", async () => {
    const db = env.PHASE5_DISPATCH_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    const senderId = uniqueId();
    const spike = makeEvent({
      author_id: senderId,
      author_is_bot: true,
      content: `SPIKE-8-${crypto.randomUUID()}`,
    });
    const normal = makeEvent({ content: "invalid normal registration" });
    const { runtime } = spikeEnvironment(senderId, db);
    expect(
      await (await worker.fetch(ingestRequest(spike), runtime, createExecutionContext())).json(),
    ).toEqual({
      status: "accepted",
    });
    expect(
      await (await worker.fetch(ingestRequest(normal), runtime, createExecutionContext())).json(),
    ).toEqual({
      status: "accepted",
    });
    const spikeBefore = await db
      .prepare("SELECT * FROM discord_output_deliveries WHERE event_id=?1")
      .bind(spike.event_id)
      .first();
    const transport = vi.fn(async () => Response.json({ id: uniqueId() }));
    const counted = countD1(db);
    await dispatchOutput(
      counted.db,
      testConfig({ spikeSenderAllowlist: [senderId] }),
      () => new Date(),
      transport,
    );
    expect(transport).toHaveBeenCalledOnce();
    expect(
      await db
        .prepare("SELECT status,attempts FROM discord_output_deliveries WHERE event_id=?1")
        .bind(normal.event_id)
        .first(),
    ).toEqual({ status: "sent", attempts: 1 });
    expect(
      await db
        .prepare("SELECT * FROM discord_output_deliveries WHERE event_id=?1")
        .bind(spike.event_id)
        .first(),
    ).toEqual(spikeBefore);

    const selection = counted.stats.prepared.find((entry) =>
      entry.sql.startsWith("SELECT d.* FROM discord_output_deliveries"),
    )?.sql;
    const claim = counted.stats.prepared.find((entry) =>
      entry.sql.startsWith("UPDATE discord_output_deliveries SET status='claimed'"),
    )?.sql;
    for (const sql of [selection, claim]) {
      expect(sql).toContain("dispatch_eligible=1");
      expect(sql).toContain("permanent_dispatch_block=0");
      expect(sql).toContain("suppression_reason IS NULL");
      expect(sql).toContain("suppressed_at IS NULL");
    }
  });

  it("returns and records no raw input, sender, authorization, or secret diagnostics", async () => {
    const senderId = uniqueId();
    const event = makeEvent({
      author_id: senderId,
      author_is_bot: true,
      content: `SPIKE-9-${crypto.randomUUID()}`,
    });
    const { runtime } = spikeEnvironment(senderId);
    const spies = (["debug", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const response = await worker.fetch(ingestRequest(event), runtime, createExecutionContext());
      const responseText = await response.text();
      const diagnostics = spies
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .map(String)
        .join("|");
      expect(responseText).toBe('{"status":"accepted"}');
      for (const forbidden of [
        event.content,
        event.author_id,
        env.INGESTION_SHARED_SECRET,
        "authorization",
      ]) {
        expect(responseText).not.toContain(forbidden);
        expect(diagnostics).not.toContain(forbidden);
      }
      expect(diagnostics).toBe("");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

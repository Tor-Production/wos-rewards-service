import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { acceptRegistrationEvent } from "../src/ingest/acceptance";
import {
  contentHash,
  deliveryId,
  deterministicUuid,
  eventDeliveryGroup,
  newAttemptRunId,
  nonceFor,
} from "../src/ingest/identity";
import { parseRegistration } from "../src/ingest/registration-parser";
import { validationReply } from "../src/ingest/validation-reply";
import { countD1, FIXTURE_NOW, makeEvent, testConfig } from "./support/fixtures";

describe("invalid atomic acceptance", () => {
  it.each(["", "not-a-player", "1".repeat(40), `12345 ${"1".repeat(20)}`])(
    "persists only the marker and exact validation reply for %s",
    async (content) => {
      const event = makeEvent({ content });
      const parsed = parseRegistration(content, testConfig().defaultState);
      if (parsed.ok) throw new Error("fixture must be an invalid registration");
      const counted = countD1(env.STAGING_DB);
      expect(
        await acceptRegistrationEvent({
          db: counted.db,
          config: testConfig(),
          event,
          parsed,
          acceptanceClass: "normal",
          now: FIXTURE_NOW,
          attemptRunId: newAttemptRunId(),
        }),
      ).toEqual({ kind: "accepted_invalid" });
      expect(counted.stats.batchSizes).toEqual([2]);
      expect(counted.stats.statements).toBe(2);
      const group = eventDeliveryGroup(event.event_id);
      const id = deliveryId(group, 1);
      const reply = validationReply(parsed.reason);
      expect(
        await env.STAGING_DB.prepare("SELECT * FROM processed_events WHERE event_id=?")
          .bind(event.event_id)
          .first(),
      ).toMatchObject({
        status: "accepted_invalid",
        outcome: "invalid",
        validation_reason: parsed.reason,
        operation_id: null,
        output_delivery_group: group,
        received_at: FIXTURE_NOW.toISOString(),
        accepted_at: FIXTURE_NOW.toISOString(),
        committed_at: null,
        finalized_at: null,
      });
      expect(
        await env.STAGING_DB.prepare("SELECT * FROM discord_output_deliveries WHERE event_id=?")
          .bind(event.event_id)
          .first(),
      ).toMatchObject({
        delivery_id: id,
        delivery_group: group,
        operation_id: null,
        channel_id: event.channel_id,
        output_type: "validation_reply",
        chunk_index: 1,
        chunk_total: 1,
        content: reply,
        content_hash: await contentHash(reply),
        nonce: await nonceFor(id),
        has_footer: 0,
        status: "pending",
        attempts: 0,
        created_at: FIXTURE_NOW.toISOString(),
        updated_at: FIXTURE_NOW.toISOString(),
      });
      const op = await deterministicUuid(`registration:${event.event_id}`);
      for (const table of ["operations", "operation_items", "outbox_jobs"]) {
        expect(
          await env.STAGING_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE operation_id=?`)
            .bind(op)
            .first("n"),
        ).toBe(0);
      }
      // The executed write set never attempts a player upsert for invalid syntax.
      expect(
        counted.stats.prepared.every((statement) => !statement.sql.includes("INSERT INTO players")),
      ).toBe(true);
    },
  );

  it("rolls back the marker when the reply child cannot be inserted", async () => {
    const event = makeEvent({ content: "bad" });
    const group = eventDeliveryGroup(event.event_id);
    // An orphan delivery without an event FK is valid schema state, but its PK blocks this reply.
    await env.STAGING_DB.prepare(
      `INSERT INTO discord_output_deliveries
      (delivery_id, delivery_group, channel_id, output_type, chunk_index, chunk_total, content, content_hash, nonce)
      VALUES (?, ?, ?, 'validation_reply', 1, 1, 'synthetic', 'synthetic', 'synthetic')`,
    )
      .bind(deliveryId(group, 1), group, event.channel_id)
      .run();
    expect(
      await acceptRegistrationEvent({
        db: env.STAGING_DB,
        config: testConfig(),
        event,
        parsed: parseRegistration(event.content, "0"),
        acceptanceClass: "normal",
        now: FIXTURE_NOW,
        attemptRunId: newAttemptRunId(),
      }),
    ).toEqual({ kind: "rejected", reason: "d1_failure" });
    expect(
      await env.STAGING_DB.prepare("SELECT 1 FROM processed_events WHERE event_id=?")
        .bind(event.event_id)
        .first(),
    ).toBeNull();
  });
});

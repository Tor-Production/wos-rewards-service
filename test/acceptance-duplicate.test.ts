import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { acceptRegistrationEvent as acceptEvent } from "../src/ingest/acceptance";
import { newAttemptRunId } from "../src/ingest/identity";
import { parseRegistration } from "../src/ingest/registration-parser";
import {
  closeOutbox,
  countD1,
  disableCodes,
  FIXTURE_NOW,
  makeEvent,
  seedCodes,
  testConfig,
  uniqueId,
} from "./support/fixtures";

const seeded: string[] = [];
const operations: string[] = [];
afterEach(async () => {
  await disableCodes(env.STAGING_DB, seeded.splice(0));
  await closeOutbox(env.STAGING_DB, operations.splice(0));
});

async function acceptRegistrationEvent(input: Parameters<typeof acceptEvent>[0]) {
  const outcome = await acceptEvent(input);
  if (outcome.kind === "accepted_valid") operations.push(outcome.operationId);
  return outcome;
}

describe("duplicate event acceptance", () => {
  it("absorbs a replay structurally and rolls back earlier upsert/T13 work", async () => {
    const playerId = uniqueId();
    const code = `duplicate-${uniqueId()}`;
    seeded.push(code);
    await seedCodes(env.STAGING_DB, [code]);
    const event = makeEvent({ content: `${playerId} 007 @Frost` });
    const config = testConfig();
    const input = {
      db: env.STAGING_DB,
      config,
      event,
      parsed: parseRegistration(event.content, config.defaultState),
      now: FIXTURE_NOW,
      attemptRunId: newAttemptRunId(),
    };
    const accepted = await acceptRegistrationEvent(input);
    if (accepted.kind !== "accepted_valid") throw new Error("acceptance failed");
    const snapshot = async () =>
      Promise.all([
        env.STAGING_DB.prepare("SELECT * FROM players WHERE player_id=?").bind(playerId).all(),
        env.STAGING_DB.prepare("SELECT * FROM processed_events WHERE event_id=?")
          .bind(event.event_id)
          .all(),
        env.STAGING_DB.prepare("SELECT * FROM operations WHERE operation_id=?")
          .bind(accepted.operationId)
          .all(),
        env.STAGING_DB.prepare(
          "SELECT * FROM operation_items WHERE operation_id=? ORDER BY item_key",
        )
          .bind(accepted.operationId)
          .all(),
        env.STAGING_DB.prepare("SELECT * FROM outbox_jobs WHERE operation_id=? ORDER BY job_id")
          .bind(accepted.operationId)
          .all(),
      ]).then((results) => results.map(({ results: rows }) => rows));
    const before = await snapshot();
    const counted = countD1(env.STAGING_DB);
    // Different body and fresh run ID on the same event must not mutate already accepted work.
    const replay = { ...event, content: `${playerId} 008 New Name` };
    expect(
      await acceptRegistrationEvent({
        ...input,
        db: counted.db,
        event: replay,
        parsed: parseRegistration(replay.content, config.defaultState),
        now: new Date(FIXTURE_NOW.getTime() + 1000),
        attemptRunId: newAttemptRunId(),
      }),
    ).toEqual({ kind: "duplicate" });
    expect(await snapshot()).toEqual(before);
    expect(counted.stats.statements).toBe(7);
    expect(
      counted.stats.prepared.some(({ sql }) =>
        sql.startsWith("SELECT 1 AS present FROM processed_events"),
      ),
    ).toBe(true);
    const nextEvent = makeEvent({ content: event.content });
    expect(
      await acceptRegistrationEvent({
        ...input,
        event: nextEvent,
        attemptRunId: newAttemptRunId(),
      }),
    ).toMatchObject({ kind: "accepted_valid" });
  });

  it("absorbs an invalid replay without creating another delivery", async () => {
    const event = makeEvent({ content: "bad" });
    const input = {
      db: env.STAGING_DB,
      config: testConfig(),
      event,
      parsed: parseRegistration(event.content, "0"),
      now: FIXTURE_NOW,
      attemptRunId: newAttemptRunId(),
    };
    expect(await acceptRegistrationEvent(input)).toEqual({ kind: "accepted_invalid" });
    expect(await acceptRegistrationEvent(input)).toEqual({ kind: "duplicate" });
    expect(
      await env.STAGING_DB.prepare(
        "SELECT COUNT(*) AS n FROM discord_output_deliveries WHERE event_id=?",
      )
        .bind(event.event_id)
        .first("n"),
    ).toBe(1);
  });
});

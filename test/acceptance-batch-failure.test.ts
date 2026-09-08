import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { acceptRegistrationEvent } from "../src/ingest/acceptance";
import { deterministicUuid, newAttemptRunId } from "../src/ingest/identity";
import { parseRegistration } from "../src/ingest/registration-parser";
import {
  countD1,
  FIXTURE_NOW,
  makeEvent,
  seedCodes,
  seedOperation,
  seedPlayer,
  testConfig,
  uniqueId,
} from "./support/fixtures";

const db = env.STAGING_DB;

describe("non-duplicate acceptance failures", () => {
  it("an orphan operation PK rolls back the preceding new-player insert", async () => {
    const playerId = uniqueId();
    const event = makeEvent({ content: `${playerId} 002 Name` });
    const operationId = await deterministicUuid(`registration:${event.event_id}`);
    await seedOperation(db, operationId, { triggerRef: event.event_id });
    const before = await db
      .prepare("SELECT * FROM operations WHERE operation_id=?")
      .bind(operationId)
      .first();
    const counted = countD1(db);
    expect(
      await acceptRegistrationEvent({
        db: counted.db,
        config: testConfig(),
        event,
        parsed: parseRegistration(event.content, "0"),
        now: FIXTURE_NOW,
        attemptRunId: newAttemptRunId(),
      }),
    ).toEqual({ kind: "rejected", reason: "d1_failure" });
    expect(counted.stats.batchSizes).toEqual([6]);
    expect(counted.stats.statements).toBe(8);
    expect(
      await db.prepare("SELECT 1 FROM players WHERE player_id=?").bind(playerId).first(),
    ).toBeNull();
    expect(
      await db
        .prepare("SELECT 1 FROM processed_events WHERE event_id=?")
        .bind(event.event_id)
        .first(),
    ).toBeNull();
    expect(
      await db.prepare("SELECT * FROM operations WHERE operation_id=?").bind(operationId).first(),
    ).toEqual(before);
    for (const table of ["operation_items", "outbox_jobs"]) {
      expect(
        await db.prepare(`SELECT 1 FROM ${table} WHERE operation_id=?`).bind(operationId).first(),
      ).toBeNull();
    }
  });

  it("rolls back T13 changes and an existing player's update on the same failure", async () => {
    const playerId = uniqueId();
    const code = `rollback-${uniqueId()}`;
    await seedPlayer(db, playerId, "001", "Original");
    await seedCodes(db, [{ code, status: "disabled" }]);
    await db
      .prepare(
        `INSERT INTO redemptions (player_id, code, idempotency_key, status, reason_code, attempt_state,
      attempts, attempt_generation, reeval_count, terminal_at)
      VALUES (?, ?, ?, 'permanent_failure', 'player_ineligible', '001', 4, 2, 0, ?)`,
      )
      .bind(playerId, code, code, FIXTURE_NOW.toISOString())
      .run();
    const event = makeEvent({ content: `${playerId} 002 Replacement` });
    const op = await deterministicUuid(`registration:${event.event_id}`);
    await seedOperation(db, op);
    const playerBefore = await db
      .prepare("SELECT * FROM players WHERE player_id=?")
      .bind(playerId)
      .first();
    const redemptionBefore = await db
      .prepare("SELECT * FROM redemptions WHERE player_id=? AND code=?")
      .bind(playerId, code)
      .first();
    expect(
      await acceptRegistrationEvent({
        db,
        config: testConfig(),
        event,
        parsed: parseRegistration(event.content, "0"),
        now: new Date(FIXTURE_NOW.getTime() + 1000),
        attemptRunId: newAttemptRunId(),
      }),
    ).toEqual({ kind: "rejected", reason: "d1_failure" });
    expect(
      await db.prepare("SELECT * FROM players WHERE player_id=?").bind(playerId).first(),
    ).toEqual(playerBefore);
    expect(
      await db
        .prepare("SELECT * FROM redemptions WHERE player_id=? AND code=?")
        .bind(playerId, code)
        .first(),
    ).toEqual(redemptionBefore);
    expect(
      await db
        .prepare("SELECT 1 FROM processed_events WHERE event_id=?")
        .bind(event.event_id)
        .first(),
    ).toBeNull();
  });

  it.each(["batch", "marker", "label"])(
    "fails closed for synthetic %s transport failure",
    async (failure) => {
      const event = makeEvent();
      // Only batch() is faked; structural lookups still reach local D1 unless that lookup is the case.
      const broken = new Proxy(db, {
        get(target, property) {
          if (property === "batch")
            return async () => {
              throw new Error("synthetic storage transport failure");
            };
          if (property === "prepare")
            return (sql: string) => {
              if (
                (failure === "marker" && sql.startsWith("SELECT 1 AS present")) ||
                (failure === "label" && sql.startsWith("SELECT COUNT(*) AS count"))
              ) {
                throw new Error("synthetic lookup failure");
              }
              return target.prepare(sql);
            };
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      expect(
        await acceptRegistrationEvent({
          db: broken,
          config: testConfig(),
          event,
          parsed: parseRegistration(event.content, "0"),
          now: FIXTURE_NOW,
          attemptRunId: newAttemptRunId(),
        }),
      ).toEqual({ kind: "rejected", reason: "d1_failure" });
      expect(
        await db.prepare("SELECT 1 FROM players WHERE player_id=?").bind(event.content).first(),
      ).toBeNull();
      expect(
        await db
          .prepare("SELECT 1 FROM processed_events WHERE event_id=?")
          .bind(event.event_id)
          .first(),
      ).toBeNull();
    },
  );
});

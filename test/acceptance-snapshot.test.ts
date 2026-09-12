import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { acceptRegistrationEvent } from "../src/ingest/acceptance";
import { deterministicUuid, newAttemptRunId } from "../src/ingest/identity";
import { parseRegistration } from "../src/ingest/registration-parser";
import { MAX_REGISTRATION_SNAPSHOT_CODES } from "../src/limits";
import {
  closeOutbox,
  countD1,
  disableCodes,
  FIXTURE_NOW,
  makeEvent,
  seedCodes,
  seedOperation,
  testConfig,
  uniqueId,
} from "./support/fixtures";

const db = env.STAGING_DB;
const seeded: string[] = [];
const operations: string[] = [];
afterEach(async () => {
  await disableCodes(db, seeded.splice(0));
  await closeOutbox(db, operations.splice(0));
});

async function accept(database = db) {
  const playerId = uniqueId();
  const event = makeEvent({ content: playerId });
  const operationId = await deterministicUuid(`registration:${event.event_id}`);
  operations.push(operationId);
  const outcome = await acceptRegistrationEvent({
    db: database,
    config: testConfig(),
    event,
    parsed: parseRegistration(event.content, "0"),
    acceptanceClass: "normal",
    now: FIXTURE_NOW,
    attemptRunId: newAttemptRunId(),
  });
  return { playerId, event, operationId, outcome };
}

async function assertUncommitted(
  playerId: string,
  eventId: string,
  operationId: string,
  orphan = false,
) {
  expect(
    await db.prepare("SELECT 1 FROM players WHERE player_id=?").bind(playerId).first(),
  ).toBeNull();
  expect(
    await db.prepare("SELECT 1 FROM processed_events WHERE event_id=?").bind(eventId).first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT COUNT(*) AS n FROM operations WHERE operation_id=?")
      .bind(operationId)
      .first("n"),
  ).toBe(orphan ? 1 : 0);
  for (const table of ["operation_items", "outbox_jobs"]) {
    expect(
      await db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE operation_id=?`)
        .bind(operationId)
        .first("n"),
    ).toBe(0);
  }
}

describe("transactional registration snapshot", () => {
  it("SM-1 freezes exactly the active membership and count despite later status changes and insertions", async () => {
    const prefix = uniqueId();
    const active = Array.from({ length: 5 }, (_, index) => `${prefix}-active-${index}`);
    const inactive = [
      { code: `${prefix}-expired-1`, status: "expired" as const },
      { code: `${prefix}-expired-2`, status: "expired" as const },
      { code: `${prefix}-disabled`, status: "disabled" as const },
    ];
    seeded.push(...active);
    await seedCodes(db, [...active, ...inactive]);
    const { operationId, outcome } = await accept();
    expect(outcome).toEqual({ kind: "accepted_valid", operationId });
    const membership = async () =>
      (
        await db
          .prepare("SELECT code FROM operation_items WHERE operation_id=? ORDER BY code")
          .bind(operationId)
          .all<{ code: string }>()
      ).results.map(({ code }) => code);
    expect(await membership()).toEqual(active.sort());
    expect(
      await db
        .prepare("SELECT expected_count FROM operations WHERE operation_id=?")
        .bind(operationId)
        .first("expected_count"),
    ).toBe(5);
    await disableCodes(db, active);
    const newCode = `${prefix}-later`;
    seeded.push(newCode);
    await seedCodes(db, [newCode]);
    // Referenced codes cannot be deleted: the baseline FK has no delete cascade.
    await expect(
      db.prepare("DELETE FROM gift_codes WHERE code=?").bind(active[0]).run(),
    ).rejects.toThrow();
    expect(await membership()).toEqual(active);
    expect(
      await db
        .prepare("SELECT expected_count FROM operations WHERE operation_id=?")
        .bind(operationId)
        .first("expected_count"),
    ).toBe(5);
    const next = await accept();
    expect(next.outcome).toMatchObject({ kind: "accepted_valid" });
    expect(
      (
        await db
          .prepare("SELECT code FROM operation_items WHERE operation_id=?")
          .bind(next.operationId)
          .all()
      ).results,
    ).toEqual([{ code: newCode }]);
    for (const op of [operationId, next.operationId]) {
      expect(
        await db
          .prepare(
            `SELECT expected_count=(SELECT COUNT(*) FROM operation_items i WHERE i.operation_id=operations.operation_id) AS agrees
        FROM operations WHERE operation_id=?`,
          )
          .bind(op)
          .first("agrees"),
      ).toBe(1);
    }
  });

  it("SM-2 accepts exactly 2,000 codes with six statements and bounded binds", async () => {
    const prefix = uniqueId();
    const codes = Array.from(
      { length: MAX_REGISTRATION_SNAPSHOT_CODES },
      (_, index) => `${prefix}-${index}`,
    );
    seeded.push(...codes);
    await seedCodes(db, codes);
    const counted = countD1(db);
    const { operationId, outcome } = await accept(counted.db);
    expect(outcome).toEqual({ kind: "accepted_valid", operationId });
    expect(counted.stats.batchSizes).toEqual([6]);
    expect(counted.stats.statements).toBe(6);
    expect(counted.stats.maxBindings).toBeLessThanOrEqual(100);
    expect(
      await db
        .prepare("SELECT expected_count FROM operations WHERE operation_id=?")
        .bind(operationId)
        .first("expected_count"),
    ).toBe(2000);
    for (const table of ["operation_items", "outbox_jobs"]) {
      expect(
        await db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE operation_id=?`)
          .bind(operationId)
          .first("n"),
      ).toBe(2000);
    }
  });

  it.each([false, true])(
    "SM-2 rejects 2,001 codes even when orphan operation exists=%s",
    async (orphan) => {
      const prefix = uniqueId();
      const codes = Array.from(
        { length: MAX_REGISTRATION_SNAPSHOT_CODES + 1 },
        (_, index) => `${prefix}-${index}`,
      );
      seeded.push(...codes);
      await seedCodes(db, codes);
      const playerId = uniqueId();
      const event = makeEvent({ content: playerId });
      const operationId = await deterministicUuid(`registration:${event.event_id}`);
      operations.push(operationId);
      if (orphan) await seedOperation(db, operationId, { triggerRef: event.event_id });
      const counted = countD1(db);
      expect(
        await acceptRegistrationEvent({
          db: counted.db,
          config: testConfig(),
          event,
          parsed: parseRegistration(event.content, "0"),
          acceptanceClass: "normal",
          now: FIXTURE_NOW,
          attemptRunId: newAttemptRunId(),
        }),
      ).toEqual({ kind: "rejected", reason: "snapshot_too_large" });
      expect(counted.stats.batchSizes).toEqual([6]);
      expect(counted.stats.statements).toBe(8);
      // There is no preflight query: the first six prepares are the atomic write set.
      expect(
        counted.stats.prepared
          .slice(0, 6)
          .every(({ sql }) => !sql.trimStart().startsWith("SELECT")),
      ).toBe(true);
      expect(counted.stats.prepared[2]!.sql).toContain("CASE WHEN c.n <= ?4 THEN c.n ELSE -1 END");
      await assertUncommitted(playerId, event.event_id, operationId, orphan);
    },
  );

  it("enforces the cap even if the non-authoritative label query reports zero", async () => {
    const prefix = uniqueId();
    const codes = Array.from(
      { length: MAX_REGISTRATION_SNAPSHOT_CODES + 1 },
      (_, index) => `${prefix}-${index}`,
    );
    seeded.push(...codes);
    await seedCodes(db, codes);
    const labelStub = new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.startsWith("SELECT COUNT(*) AS count")) return statement;
            return new Proxy(statement, {
              get(prepared, key) {
                if (key === "first") return async () => ({ count: 0 });
                const value: unknown = Reflect.get(prepared, key, prepared);
                return typeof value === "function" ? value.bind(prepared) : value;
              },
            });
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const { playerId, event, operationId, outcome } = await accept(labelStub);
    expect(outcome).toEqual({ kind: "rejected", reason: "d1_failure" });
    await assertUncommitted(playerId, event.event_id, operationId);
  });
});

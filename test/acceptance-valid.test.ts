import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { acceptRegistrationEvent as acceptEvent } from "../src/ingest/acceptance";
import { deterministicUuid, newAttemptRunId } from "../src/ingest/identity";
import { parseRegistration } from "../src/ingest/registration-parser";
import { renderDisplayLabel } from "../src/ingest/sanitize";
import {
  closeOutbox,
  countD1,
  disableCodes,
  FIXTURE_NOW,
  makeEvent,
  seedCodes,
  seedPlayer,
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

async function acceptRegistrationEvent(input: Parameters<typeof acceptEvent>[0]) {
  const outcome = await acceptEvent(input);
  if (outcome.kind === "accepted_valid") operations.push(outcome.operationId);
  return outcome;
}

describe("valid atomic acceptance", () => {
  it.each([0, 1, 3])(
    "commits %i code memberships with exactly six bounded statements",
    async (count) => {
      const config = testConfig();
      const suffix = uniqueId();
      const codes = Array.from({ length: count }, (_, index) => `${suffix}-${index}-"\\雪`);
      seeded.push(...codes);
      await seedCodes(db, codes);
      const playerId = `000${uniqueId()}`;
      const event = makeEvent({
        content: `${playerId} 000245 @Frost 雪😀`,
        created_at: "2020-01-02T00:00:00Z",
      });
      const run = newAttemptRunId();
      const counted = countD1(db);
      const operationId = await deterministicUuid(`registration:${event.event_id}`);
      expect(
        await acceptRegistrationEvent({
          db: counted.db,
          config,
          event,
          parsed: parseRegistration(event.content, config.defaultState),
          acceptanceClass: "normal",
          now: FIXTURE_NOW,
          attemptRunId: run,
        }),
      ).toEqual({ kind: "accepted_valid", operationId });
      expect(counted.stats.batchSizes).toEqual([6]);
      expect(counted.stats.statements).toBe(6);
      expect(counted.stats.maxBindings).toBeLessThanOrEqual(8);
      expect(
        counted.stats.prepared.every(({ sql }) => new TextEncoder().encode(sql).byteLength < 1500),
      ).toBe(true);
      expect(counted.stats.prepared.every(({ sql }) => !/random(?:blob)?\s*\(/iu.test(sql))).toBe(
        true,
      );
      expect(counted.stats.prepared.flatMap(({ bindings }) => bindings)).not.toContain(
        event.created_at,
      );
      expect(
        await db.prepare("SELECT * FROM players WHERE player_id=?").bind(playerId).first(),
      ).toEqual({
        player_id: playerId,
        state: "000245",
        state_updated_at: FIXTURE_NOW.toISOString(),
        display_name: "@Frost 雪😀",
        created_at: FIXTURE_NOW.toISOString(),
        updated_at: FIXTURE_NOW.toISOString(),
      });
      expect(
        await db.prepare("SELECT * FROM operations WHERE operation_id=?").bind(operationId).first(),
      ).toMatchObject({
        type: "registration_run",
        trigger_kind: "discord_event",
        trigger_ref: event.event_id,
        expected_count: count,
        expansion_state: "expanded",
        expansion_cursor: null,
        state: "pending",
        summary_state: "none",
        snapshot_at: FIXTURE_NOW.toISOString(),
        deadline_at: new Date(
          FIXTURE_NOW.getTime() + config.operationDeadlineSeconds * 1000,
        ).toISOString(),
        summary_delivery_group: null,
      });
      expect(
        await db
          .prepare("SELECT * FROM processed_events WHERE event_id=?")
          .bind(event.event_id)
          .first(),
      ).toMatchObject({
        status: "work_committed",
        outcome: "valid",
        operation_id: operationId,
        output_delivery_group: `evt:${event.event_id}`,
        validation_reason: null,
        received_at: FIXTURE_NOW.toISOString(),
        accepted_at: FIXTURE_NOW.toISOString(),
        committed_at: FIXTURE_NOW.toISOString(),
      });
      const items = await db
        .prepare("SELECT * FROM operation_items WHERE operation_id=? ORDER BY code")
        .bind(operationId)
        .all();
      expect(items.results).toHaveLength(count);
      const outbox = await db
        .prepare("SELECT * FROM outbox_jobs WHERE operation_id=? ORDER BY item_key")
        .bind(operationId)
        .all<{ item_key: string; payload_json: string; attempt_id: string }>();
      expect(outbox.results).toHaveLength(count);
      expect(new Set(outbox.results.map((row) => row.attempt_id)).size).toBe(count);
      for (const code of codes) {
        const jobId = `registration:${operationId}:${code}`;
        expect(items.results.find((item) => item.code === code)).toMatchObject({
          item_key: code,
          code,
          player_id: playerId,
          job_id: jobId,
          status: "pending",
          attempts: 0,
          display_label: renderDisplayLabel("@Frost 雪😀", playerId),
        });
        const row = outbox.results.find((item) => item.item_key === code)!;
        expect(row).toMatchObject({
          status: "pending",
          type: "registration",
          attempts: 0,
          last_error: null,
          attempt_id: `${run}:${code}`,
          available_at: FIXTURE_NOW.toISOString(),
        });
        const body: unknown = JSON.parse(row.payload_json);
        expect(body).toEqual({
          operation_id: operationId,
          item_key: code,
          job_id: jobId,
          player_id: playerId,
          code,
          attempt_id: `${run}:${code}`,
        });
        expect(Object.keys(body as object)).toEqual([
          "operation_id",
          "item_key",
          "job_id",
          "player_id",
          "code",
          "attempt_id",
        ]);
      }
      expect(
        await db
          .prepare("SELECT 1 FROM discord_output_deliveries WHERE event_id=?")
          .bind(event.event_id)
          .first(),
      ).toBeNull();
    },
  );

  it("round-trips a 30-digit player ID and preserves the first operation's label on re-registration", async () => {
    const playerId = `0000000000${uniqueId().padStart(20, "0")}`;
    const code = `label-${uniqueId()}`;
    seeded.push(code);
    await seedCodes(db, [code]);
    const event = makeEvent({ content: `${playerId} Old Name` });
    const config = testConfig();
    const first = await acceptRegistrationEvent({
      db,
      config,
      event,
      parsed: parseRegistration(event.content, config.defaultState),
      acceptanceClass: "normal",
      now: FIXTURE_NOW,
      attemptRunId: newAttemptRunId(),
    });
    if (first.kind !== "accepted_valid") throw new Error("acceptance failed");
    const later = new Date(FIXTURE_NOW.getTime() + 1000);
    const next = makeEvent({ content: playerId });
    const second = await acceptRegistrationEvent({
      db,
      config,
      event: next,
      parsed: parseRegistration(next.content, config.defaultState),
      acceptanceClass: "normal",
      now: later,
      attemptRunId: newAttemptRunId(),
    });
    if (second.kind !== "accepted_valid") throw new Error("acceptance failed");
    expect(
      await db.prepare("SELECT * FROM players WHERE player_id=?").bind(playerId).first(),
    ).toMatchObject({
      player_id: playerId,
      display_name: null,
      created_at: FIXTURE_NOW.toISOString(),
      state_updated_at: FIXTURE_NOW.toISOString(),
      updated_at: later.toISOString(),
    });
    expect(
      await db
        .prepare("SELECT display_label FROM operation_items WHERE operation_id=? AND code=?")
        .bind(first.operationId, code)
        .first("display_label"),
    ).toBe("Old Name");
    expect(
      await db
        .prepare("SELECT display_label FROM operation_items WHERE operation_id=? AND code=?")
        .bind(second.operationId, code)
        .first("display_label"),
    ).toBe(`ID ${playerId}`);
    const body = await db
      .prepare("SELECT payload_json FROM outbox_jobs WHERE operation_id=? AND item_key=?")
      .bind(second.operationId, code)
      .first<string>("payload_json");
    expect(JSON.parse(body!) as { player_id: string }).toMatchObject({ player_id: playerId });
  });

  it("persists a masked link as an immutable literal label while preserving the stored name", async () => {
    const playerId = uniqueId();
    const code = `masked-link-${uniqueId()}`;
    const name = "[Frost](https://example.com)";
    seeded.push(code);
    await seedCodes(db, [code]);
    const config = testConfig();
    const event = makeEvent({ content: `${playerId} ${name}` });
    const accepted = await acceptRegistrationEvent({
      db,
      config,
      event,
      parsed: parseRegistration(event.content, config.defaultState),
      acceptanceClass: "normal",
      now: FIXTURE_NOW,
      attemptRunId: newAttemptRunId(),
    });
    if (accepted.kind !== "accepted_valid") throw new Error("acceptance failed");

    expect(
      await db
        .prepare("SELECT display_name FROM players WHERE player_id=?")
        .bind(playerId)
        .first("display_name"),
    ).toBe(name);
    expect(
      await db
        .prepare("SELECT display_label FROM operation_items WHERE operation_id=? AND code=?")
        .bind(accepted.operationId, code)
        .first("display_label"),
    ).toBe("\\[Frost\\](https://example.com)");

    const next = makeEvent({ content: `${playerId} Renamed` });
    expect(
      await acceptRegistrationEvent({
        db,
        config,
        event: next,
        parsed: parseRegistration(next.content, config.defaultState),
        acceptanceClass: "normal",
        now: new Date(FIXTURE_NOW.getTime() + 1_000),
        attemptRunId: newAttemptRunId(),
      }),
    ).toMatchObject({ kind: "accepted_valid" });
    expect(
      await db
        .prepare("SELECT display_label FROM operation_items WHERE operation_id=? AND code=?")
        .bind(accepted.operationId, code)
        .first("display_label"),
    ).toBe("\\[Frost\\](https://example.com)");
  });

  it("T13 reopens only eligible state failures, before the player upsert", async () => {
    const playerId = uniqueId();
    const otherPlayer = uniqueId();
    const config = testConfig();
    await seedPlayer(db, playerId, "001", "Before");
    await seedPlayer(db, otherPlayer, "001");
    const cases = [
      {
        key: "eligible",
        status: "permanent_failure",
        reason: "player_ineligible",
        state: "001",
        count: 0,
        player: playerId,
        reopen: true,
      },
      {
        key: "unknown-state",
        status: "permanent_failure",
        reason: "player_ineligible",
        state: null,
        count: 0,
        player: playerId,
        reopen: true,
      },
      {
        key: "success",
        status: "success",
        reason: null,
        state: "001",
        count: 0,
        player: playerId,
        reopen: false,
      },
      {
        key: "already",
        status: "already_redeemed",
        reason: null,
        state: "001",
        count: 0,
        player: playerId,
        reopen: false,
      },
      {
        key: "limit",
        status: "permanent_failure",
        reason: "state_reevaluation_limit",
        state: "001",
        count: 0,
        player: playerId,
        reopen: false,
      },
      {
        key: "code",
        status: "permanent_failure",
        reason: "code_invalid",
        state: "001",
        count: 0,
        player: playerId,
        reopen: false,
      },
      {
        key: "provider",
        status: "permanent_failure",
        reason: "provider_bad_request",
        state: "001",
        count: 0,
        player: playerId,
        reopen: false,
      },
      {
        key: "cap",
        status: "permanent_failure",
        reason: "player_ineligible",
        state: "001",
        count: config.redemptionMaxReeval,
        player: playerId,
        reopen: false,
      },
      {
        key: "same-attempt",
        status: "permanent_failure",
        reason: "player_ineligible",
        state: "002",
        count: 0,
        player: playerId,
        reopen: false,
      },
      {
        key: "other-player",
        status: "permanent_failure",
        reason: "player_ineligible",
        state: "001",
        count: 0,
        player: otherPlayer,
        reopen: false,
      },
      {
        key: "in-progress",
        status: "in_progress",
        reason: "player_ineligible",
        state: "001",
        count: 0,
        player: playerId,
        reopen: false,
      },
    ].map((entry) => ({ ...entry, code: `${uniqueId()}-${entry.key}` }));
    await seedCodes(
      db,
      cases.map(({ code }) => ({ code, status: "disabled" as const })),
    );
    await db.batch(
      cases.map((entry) =>
        db
          .prepare(
            `INSERT INTO redemptions
      (player_id, code, idempotency_key, status, reason_code, attempt_state, reeval_count,
       attempts, attempt_generation, current_attempt_id, current_invocation_token, invocation_expires_at,
       retry_due_at, terminal_at, updated_at)
      VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, 4, 2, 'old-attempt', 'old-invocation', ?7, ?7, ?7, ?7)`,
          )
          .bind(
            entry.player,
            entry.code,
            entry.status,
            entry.reason,
            entry.state,
            entry.count,
            FIXTURE_NOW.toISOString(),
          ),
      ),
    );
    const before = (
      await db
        .prepare("SELECT * FROM redemptions WHERE player_id IN (?, ?)")
        .bind(playerId, otherPlayer)
        .all()
    ).results;
    const now = new Date(FIXTURE_NOW.getTime() + 1000);
    const event = makeEvent({ content: `${playerId} 002 After` });
    expect(
      await acceptRegistrationEvent({
        db,
        config,
        event,
        parsed: parseRegistration(event.content, config.defaultState),
        acceptanceClass: "normal",
        now,
        attemptRunId: newAttemptRunId(),
      }),
    ).toMatchObject({ kind: "accepted_valid" });
    for (const entry of cases) {
      const row = await db
        .prepare("SELECT * FROM redemptions WHERE player_id=? AND code=?")
        .bind(entry.player, entry.code)
        .first();
      if (entry.reopen) {
        expect(row).toMatchObject({
          status: "pending",
          reason_code: null,
          terminal_at: null,
          attempts: 0,
          attempt_generation: 3,
          reeval_count: entry.count + 1,
          current_attempt_id: null,
          current_invocation_token: null,
          invocation_expires_at: null,
          retry_due_at: null,
          updated_at: now.toISOString(),
        });
      } else {
        expect(row).toEqual(before.find((old) => old.code === entry.code));
      }
    }
    expect(
      await db
        .prepare("SELECT state_updated_at FROM players WHERE player_id=?")
        .bind(playerId)
        .first("state_updated_at"),
    ).toBe(now.toISOString());
  });

  it("does not reopen stale failures when re-registration leaves the player's state unchanged", async () => {
    const playerId = uniqueId();
    const code = `same-state-${uniqueId()}`;
    await seedPlayer(db, playerId, "002");
    await seedCodes(db, [{ code, status: "disabled" }]);
    await db
      .prepare(
        `INSERT INTO redemptions (player_id, code, idempotency_key, status, reason_code, attempt_state, terminal_at)
      VALUES (?, ?, ?, 'permanent_failure', 'player_ineligible', '001', ?)`,
      )
      .bind(playerId, code, code, FIXTURE_NOW.toISOString())
      .run();
    const before = await db
      .prepare("SELECT * FROM redemptions WHERE player_id=? AND code=?")
      .bind(playerId, code)
      .first();
    const event = makeEvent({ content: `${playerId} 002 Changed Name` });
    expect(
      await acceptRegistrationEvent({
        db,
        config: testConfig(),
        event,
        parsed: parseRegistration(event.content, "0"),
        acceptanceClass: "normal",
        now: new Date(FIXTURE_NOW.getTime() + 1000),
        attemptRunId: newAttemptRunId(),
      }),
    ).toMatchObject({ kind: "accepted_valid" });
    expect(
      await db
        .prepare("SELECT * FROM redemptions WHERE player_id=? AND code=?")
        .bind(playerId, code)
        .first(),
    ).toEqual(before);
    expect(
      await db
        .prepare("SELECT state_updated_at FROM players WHERE player_id=?")
        .bind(playerId)
        .first("state_updated_at"),
    ).toBe(FIXTURE_NOW.toISOString());
  });
});

import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";

it("upgrades populated 0001 without renewing retries or changing frozen records; reapplication is a no-op", async () => {
  const db = env.UPGRADE_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 1));
  await db.batch([
    db.prepare(
      "INSERT INTO players(player_id,state,created_at,updated_at) VALUES ('001','0','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')",
    ),
    db.prepare(
      "INSERT INTO gift_codes(code,discovered_at,source) VALUES ('RETRY','2026-09-01T00:00:00.000Z','synthetic'),('DONE','2026-09-01T00:00:00.000Z','synthetic')",
    ),
    db.prepare(
      "INSERT INTO redemptions(player_id,code,idempotency_key,status,attempts,current_attempt_id,updated_at) VALUES ('001','RETRY','retry','retry_wait',7,'old','2026-09-01T00:00:00.000Z'),('001','DONE','done','success',1,NULL,'2026-09-01T00:00:00.000Z')",
    ),
    db.prepare(
      "INSERT INTO operations(operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,deadline_at,summary_state,state,created_at,updated_at) VALUES ('frozen','registration_run','discord_event','e','2026-09-01T00:00:00.000Z',0,'2026-09-01T01:00:00.000Z','delivered','summarized','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')",
    ),
  ]);
  const old = await db.prepare("SELECT * FROM operations").first();
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 2));
  expect(
    await db
      .prepare(
        "SELECT attempts,provider_invocations,provider_invocation_limit,budget_generation,status,current_attempt_id FROM redemptions WHERE code='RETRY'",
      )
      .first(),
  ).toEqual({
    attempts: 7,
    provider_invocations: 4,
    provider_invocation_limit: 4,
    budget_generation: 1,
    status: "retry_wait",
    current_attempt_id: "old",
  });
  expect(await db.prepare("SELECT * FROM operations").first()).toMatchObject(old!);
  expect(
    await db
      .prepare("SELECT status,cause,budget_generation,mirror_complete FROM terminal_observations")
      .first(),
  ).toEqual({ status: "success", cause: "migration", budget_generation: 1, mirror_complete: 0 });
  const before = (await db.prepare("SELECT * FROM redemptions ORDER BY code").all()).results;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 2));
  expect((await db.prepare("SELECT * FROM redemptions ORDER BY code").all()).results).toEqual(
    before,
  );
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  expect(await db.prepare("SELECT COUNT(*) n FROM d1_migrations").first("n")).toBe(2);
});

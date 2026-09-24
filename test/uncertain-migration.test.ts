import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";

it("0005 upgrades the actual 0004 schema without inventing legacy outcomes or changing receipts", async () => {
  const db = env.UPGRADE_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 4));
  await db.batch([
    db.prepare(
      "INSERT INTO players(player_id,state,created_at,updated_at) VALUES ('001','0','2026-09-01','2026-09-01')",
    ),
    db.prepare(
      "INSERT INTO gift_codes(code,discovered_at,source) VALUES ('ACTIVE','2026-09-01','synthetic'),('DONE','2026-09-01','synthetic'),('RETRY','2026-09-01','synthetic'),('PENDING','2026-09-01','synthetic'),('UNTOUCHED','2026-09-01','synthetic')",
    ),
    db.prepare(`INSERT INTO redemptions(player_id,code,idempotency_key,status,provider_receipt,updated_at,current_invocation_token,current_attempt_id,budget_generation,provider_invocations,invocation_expires_at)
      VALUES ('001','ACTIVE','active','in_progress',NULL,'2026-09-01','legacy-token','legacy-attempt',3,2,'2026-09-02'),
      ('001','DONE','done','success','synthetic-receipt','2026-09-01',NULL,NULL,1,1,NULL),
      ('001','RETRY','retry','retry_wait',NULL,'2026-09-01',NULL,'legacy-retry',2,2,'2026-09-02'),
      ('001','PENDING','pending','pending',NULL,'2026-09-01',NULL,NULL,1,1,NULL),
      ('001','UNTOUCHED','untouched','pending',NULL,'2026-09-01',NULL,NULL,1,0,NULL)`),
    db.prepare(
      "INSERT INTO operations(operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,deadline_at,created_at,updated_at) VALUES ('op','registration_run','discord_event','e','2026-09-01',1,'2026-09-02','2026-09-01','2026-09-01')",
    ),
    db.prepare(
      "INSERT INTO operation_items(operation_id,item_key,player_id,code,job_id,status,display_label,updated_at) VALUES ('op','DONE','001','DONE','job','success','Synthetic','2026-09-01')",
    ),
    db.prepare(
      "INSERT INTO terminal_observations(player_id,code,budget_generation,status,observed_at) VALUES ('001','DONE',1,'success','2026-09-01')",
    ),
    db.prepare(
      "INSERT INTO terminal_receipts(player_id,code,budget_generation,operation_id,item_key,disposition) VALUES ('001','DONE',1,'op','DONE','applied')",
    ),
  ]);
  const before = (
    await db.prepare("SELECT * FROM redemptions ORDER BY code").all<Record<string, unknown>>()
  ).results;
  const receipts = (await db.prepare("SELECT * FROM terminal_receipts").all()).results;
  const observations = (await db.prepare("SELECT * FROM terminal_observations").all()).results;
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  const after = (
    await db.prepare("SELECT * FROM redemptions ORDER BY code").all<Record<string, unknown>>()
  ).results;
  after.forEach((r, index) => expect(r).toMatchObject(before[index]!));
  expect(after[0]).toMatchObject({
    dispatch_hold_token: "legacy-token",
    dispatch_hold_generation: 3,
    dispatch_hold_at: "2026-09-01",
    status: "in_progress",
    reason_code: null,
  });
  expect(after[1]?.dispatch_hold_token).toBeNull();
  expect(after.find((r) => r.code === "PENDING")).toMatchObject({
    status: "pending",
    dispatch_hold_token: "legacy-unattributed",
    dispatch_hold_generation: 1,
  });
  expect(after.find((r) => r.code === "UNTOUCHED")?.dispatch_hold_token).toBeNull();
  expect(after.find((r) => r.code === "RETRY")).toMatchObject({
    status: "retry_wait",
    reason_code: null,
    dispatch_hold_token: "legacy-unattributed",
    dispatch_hold_generation: 2,
  });
  expect((await db.prepare("SELECT * FROM terminal_receipts").all()).results).toEqual(receipts);
  expect((await db.prepare("SELECT * FROM terminal_observations").all()).results).toEqual(
    observations,
  );
  expect(
    await db.prepare("SELECT uncertain_count FROM operations").first("uncertain_count"),
  ).toBeNull();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect((await db.prepare("SELECT * FROM redemptions ORDER BY code").all()).results).toEqual(
    after,
  );
  expect(await db.prepare("SELECT COUNT(*) n FROM d1_migrations").first("n")).toBe(7);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  await expect(db.prepare("UPDATE redemptions SET status='uncertain'").run()).rejects.toThrow();
  await expect(
    db.prepare("UPDATE redemptions SET dispatch_hold_generation=0").run(),
  ).rejects.toThrow();
  await expect(db.prepare("UPDATE operations SET uncertain_count=-1").run()).rejects.toThrow();
});

it("fresh installation retains the original CHECK/FK domains and adds nullable hold/accounting state", async () => {
  const db = env.PHASE4_DB;
  const tables = [
    "redemptions",
    "operation_items",
    "terminal_observations",
    "operation_late_results",
    "summary_item_snapshot",
  ];
  for (const table of tables) {
    const sql = await db
      .prepare("SELECT sql FROM sqlite_schema WHERE name=?1")
      .bind(table)
      .first<string>("sql");
    expect(sql).toContain("CHECK");
    expect(sql).toContain("FOREIGN KEY");
    expect(sql).not.toContain("'uncertain'");
  }
  expect(
    (await db.prepare("PRAGMA table_info(redemptions)").all<{ name: string }>()).results.map(
      (r) => r.name,
    ),
  ).toEqual(
    expect.arrayContaining(["dispatch_hold_token", "dispatch_hold_generation", "dispatch_hold_at"]),
  );
  const before = (await db.prepare("SELECT * FROM d1_migrations").all()).results;
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect((await db.prepare("SELECT * FROM d1_migrations").all()).results).toEqual(before);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

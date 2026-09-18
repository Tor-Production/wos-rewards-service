import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("Task 09 additive manual-command migration", () => {
  it("upgrades populated Phase 5 data, enforces the ledger shape, and reapplies as a no-op", async () => {
    const db = env.MVP_UPGRADE_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 3));
    expect(
      await db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='manual_code_commands'")
        .first(),
    ).toBeNull();
    await db
      .prepare(
        `INSERT INTO players
         (player_id,state,state_updated_at,display_name,created_at,updated_at)
         VALUES ('900000000000000004','3607',NULL,'Preserved Player','2026-09-13T00:00:00Z','2026-09-13T00:00:00Z')`,
      )
      .run();
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 4));
    expect(
      (
        await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()
      ).results.map((row) => row.name),
    ).toEqual([
      "0001_initial_schema.sql",
      "0002_phase4_consumers_and_delivery.sql",
      "0003_phase5_spike_output_suppression.sql",
      "0004_live_staging_manual_commands.sql",
    ]);
    const columns = (
      await db.prepare("PRAGMA table_info(manual_code_commands)").all<{ name: string }>()
    ).results.map((row) => row.name);
    expect(columns).toEqual([
      "event_id",
      "guild_id",
      "channel_id",
      "author_id",
      "code",
      "status",
      "operation_id",
      "discord_created_at",
      "accepted_at",
      "acceptance_id",
    ]);
    expect(
      await db
        .prepare(
          `SELECT player_id,state,state_updated_at,display_name,created_at,updated_at
           FROM players WHERE player_id='900000000000000004'`,
        )
        .first(),
    ).toEqual({
      player_id: "900000000000000004",
      state: "3607",
      state_updated_at: null,
      display_name: "Preserved Player",
      created_at: "2026-09-13T00:00:00Z",
      updated_at: "2026-09-13T00:00:00Z",
    });
    await expect(
      db
        .prepare(
          `INSERT INTO manual_code_commands
           (event_id,guild_id,channel_id,author_id,code,status,discord_created_at,accepted_at,acceptance_id)
           VALUES ('1','2','3','4','bad code','duplicate_code','2026-09-13T00:00:00Z','2026-09-13T00:00:00Z','a')`,
        )
        .run(),
    ).rejects.toThrow("ck_manual_code_commands_code");
    await expect(
      db
        .prepare(
          `INSERT INTO manual_code_commands
           (event_id,guild_id,channel_id,author_id,code,status,operation_id,discord_created_at,accepted_at,acceptance_id)
           VALUES ('2','2','3','4','VALID_CODE','accepted','missing-operation','2026-09-13T00:00:00Z','2026-09-13T00:00:00Z','b')`,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM manual_code_commands").first("n")).toBe(0);
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 4));
    expect(await db.prepare("SELECT COUNT(*) AS n FROM d1_migrations").first("n")).toBe(4);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});

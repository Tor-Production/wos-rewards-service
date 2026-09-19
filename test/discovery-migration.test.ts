import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { openDistribution } from "../src/operations/distribution";
import { seedPlayer } from "./support/fixtures";
import { discoveryEnv, followEvent, followId, sendDiscovery } from "./support/discovery";

it("upgrades populated 0005 without changing manual provenance or uncertainty; migration replay is a no-op", async () => {
  const db = env.MVP_UPGRADE_DB;
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 5));
  const player = followId();
  await seedPlayer(db, player, "7", "Preserved");
  const config = loadConfig(discoveryEnv());
  const now = new Date();
  const command = {
    event_id: followId(),
    guild_id: config.discordGuildId,
    channel_id: config.discordMvpAdminChannelId,
    author_id: config.discordMvpAdminUserAllowlist[0]!,
    author_is_bot: false,
    author_is_system: false,
    webhook_id: null,
    application_id: null,
    code: "Existing18",
    created_at: now.toISOString(),
  };
  await openDistribution(db, config, command.code, now, command);
  await db
    .prepare(
      "INSERT INTO redemptions(player_id,code,idempotency_key,status,dispatch_hold_token,dispatch_hold_generation,dispatch_hold_at) VALUES (?1,?2,'synthetic','in_progress','held',1,?3)",
    )
    .bind(player, command.code, now.toISOString())
    .run();
  const tables = [
    "players",
    "gift_codes",
    "manual_code_commands",
    "operations",
    "operation_players_snapshot",
    "redemptions",
  ];
  const before = await Promise.all(
    tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results),
  );
  expect(
    await db.prepare("SELECT 1 FROM sqlite_schema WHERE name='discovered_code_events'").first(),
  ).toBeNull();
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect(
    await Promise.all(
      tables.map(async (table) => (await db.prepare(`SELECT * FROM ${table}`).all()).results),
    ),
  ).toEqual(before);
  const event = followEvent();
  expect(await (await sendDiscovery(event, discoveryEnv({ STAGING_DB: db }))).json()).toEqual({
    status: "accepted",
  });
  const provenance = (await db.prepare("SELECT * FROM discovered_code_events").all()).results;
  await applyD1Migrations(db, env.TEST_MIGRATIONS);
  expect((await db.prepare("SELECT * FROM discovered_code_events").all()).results).toEqual(
    provenance,
  );
  expect(await db.prepare("SELECT COUNT(*) n FROM d1_migrations").first("n")).toBe(6);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  const base = `INSERT INTO discovered_code_events(event_id,guild_id,channel_id,webhook_id,source_guild_id,source_channel_id,source_message_id,code,expiry_label,status,discord_created_at,accepted_at,acceptance_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'February 29, 23:59 (UTC+0)','duplicate_code',?9,?9,'synthetic')`;
  for (const [id, source, code] of [
    [followId(), event.source_message_id, "Other"],
    ["0", followId(), "Other"],
    [followId(), followId(), "bad code"],
    [followId(), followId(), "A".repeat(65)],
  ])
    await expect(
      db
        .prepare(base)
        .bind(
          id,
          event.guild_id,
          event.channel_id,
          event.webhook_id,
          event.source_guild_id,
          event.source_channel_id,
          source,
          code,
          event.created_at,
        )
        .run(),
    ).rejects.toThrow();
});

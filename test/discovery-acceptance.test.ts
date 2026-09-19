import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { openDistribution } from "../src/operations/distribution";
import { parseFollowContent } from "../shared/discord-follow";
import { forwardToWorker } from "../companion/src/worker-client";
import { routeMessage } from "../companion/src/message-router";
import { CONFIG, message } from "../companion/test/fixtures";
import worker from "../src/index";
import { createExecutionContext } from "cloudflare:test";
import { countD1, seedPlayer } from "./support/fixtures";
import { content, discoveryEnv, followEvent, followId, sendDiscovery } from "./support/discovery";

// Workers storage is isolated per file, not per test. Reset only this synthetic file's rows.
beforeEach(async () => {
  await env.STAGING_DB.prepare("DROP TRIGGER IF EXISTS synthetic_snapshot_failure").run();
  await env.STAGING_DB.prepare(
    "DELETE FROM discovered_code_events WHERE canonical_event_id IS NOT NULL",
  ).run();
  for (const table of [
    "discovered_code_events",
    "manual_code_commands",
    "operation_players_snapshot",
    "operations",
    "gift_codes",
    "players",
  ])
    await env.STAGING_DB.prepare(`DELETE FROM ${table}`).run();
});

const row = (id: string) =>
  env.STAGING_DB.prepare("SELECT * FROM discovered_code_events WHERE event_id=?1")
    .bind(id)
    .first<Record<string, unknown>>();
const codeOf = (event: ReturnType<typeof followEvent>) => parseFollowContent(event.content)!.code;
async function oneOperation(code: string, size: number) {
  const ops = (
    await env.STAGING_DB.prepare("SELECT * FROM operations WHERE trigger_ref=?1")
      .bind(code)
      .all<{ operation_id: string; expected_count: number; summary_context: string }>()
  ).results;
  expect(ops).toHaveLength(1);
  expect(ops[0]!.expected_count).toBe(size);
  expect(JSON.parse(ops[0]!.summary_context).channelId).toBe(env.DISCORD_MVP_ADMIN_CHANNEL_ID);
  expect(
    await env.STAGING_DB.prepare(
      "SELECT COUNT(*) n FROM operation_players_snapshot WHERE operation_id=?1",
    )
      .bind(ops[0]!.operation_id)
      .first("n"),
  ).toBe(size);
}
function manual(code: string) {
  return {
    event_id: followId(),
    guild_id: env.DISCORD_GUILD_ID,
    channel_id: env.DISCORD_MVP_ADMIN_CHANNEL_ID,
    author_id: env.DISCORD_MVP_ADMIN_USER_ALLOWLIST,
    author_is_bot: false,
    author_is_system: false,
    webhook_id: null,
    application_id: null,
    code,
    created_at: new Date().toISOString(),
  };
}

describe("durable Follow acceptance", () => {
  it("freezes exact source provenance, case-sensitive code and admin summary context", async () => {
    const event = followEvent();
    await seedPlayer(env.STAGING_DB, followId(), "7", "A <@123> Player");
    expect(await (await sendDiscovery(event)).json()).toEqual({ status: "accepted" });
    const first = await row(event.event_id);
    expect(first).toEqual({
      event_id: event.event_id,
      guild_id: event.guild_id,
      channel_id: event.channel_id,
      webhook_id: event.webhook_id,
      source_guild_id: event.source_guild_id,
      source_channel_id: event.source_channel_id,
      source_message_id: event.source_message_id,
      code: codeOf(event),
      expiry_label: "September 20, 23:59 (UTC+0)",
      status: "accepted",
      canonical_event_id: null,
      operation_id: expect.any(String),
      discord_created_at: event.created_at,
      accepted_at: expect.any(String),
      acceptance_id: expect.any(String),
    });
    expect(
      await env.STAGING_DB.prepare(
        "SELECT source,first_seen_event_id,status FROM gift_codes WHERE code=?1",
      )
        .bind(codeOf(event))
        .first(),
    ).toEqual({
      source: "discord-follow-staging",
      first_seen_event_id: event.event_id,
      status: "active",
    });
    await oneOperation(codeOf(event), 1);
    expect(
      await (
        await sendDiscovery({
          ...event,
          content: content("ChangedCode", "February 29, 01:00 (UTC+0)"),
        })
      ).json(),
    ).toEqual({ status: "duplicate" });
    expect(await row(event.event_id)).toEqual(first);
    expect(
      await env.STAGING_DB.prepare("SELECT 1 FROM gift_codes WHERE code='ChangedCode'").first(),
    ).toBeNull();
    await expect(
      env.STAGING_DB.prepare(
        "UPDATE discovered_code_events SET code='ChangedCode' WHERE event_id=?1",
      )
        .bind(event.event_id)
        .run(),
    ).rejects.toThrow("discovery_provenance_immutable");
    const lower = followEvent({ content: content(codeOf(event).toLowerCase()) });
    expect(await (await sendDiscovery(lower)).json()).toEqual({ status: "accepted" });
  });
  it("claims canonical source copies and their destination aliases, including changed replays", async () => {
    const first = followEvent();
    expect(await (await sendDiscovery(first)).json()).toEqual({ status: "accepted" });
    // A separately configured destination copy still shares the canonical source identity.
    const alias = {
      ...first,
      event_id: followId(),
      channel_id: "100000000000000016",
      webhook_id: "100000000000000017",
      content: content("ChangedSourceCode"),
    };
    const aliasRuntime = discoveryEnv({
      DISCORD_CODE_FEED_CHANNEL_ID: alias.channel_id,
      DISCORD_CODE_FOLLOWER_WEBHOOK_ID: alias.webhook_id,
    });
    expect(await (await sendDiscovery(alias, aliasRuntime)).json()).toEqual({
      status: "duplicate",
    });
    const frozen = await row(alias.event_id);
    expect(frozen).toMatchObject({
      status: "duplicate_source",
      canonical_event_id: first.event_id,
      operation_id: null,
    });
    expect(
      await (
        await sendDiscovery(
          {
            ...alias,
            source_message_id: followId(),
            content: content("ChangedAliasCode"),
          },
          aliasRuntime,
        )
      ).json(),
    ).toEqual({ status: "duplicate" });
    expect(await row(alias.event_id)).toEqual(frozen);
    expect(await env.STAGING_DB.prepare("SELECT COUNT(*) n FROM gift_codes").first("n")).toBe(1);
    await oneOperation(codeOf(first), 0);
  });
  it("serializes simultaneous event/source/code duplicates into one operation", async () => {
    await seedPlayer(env.STAGING_DB, followId());
    const first = followEvent();
    const events = [
      first,
      first,
      { ...first, event_id: followId() },
      followEvent({ content: first.content }),
    ];
    const results = await Promise.all(
      events.map(async (event) => (await sendDiscovery(event)).json()),
    );
    expect(results.filter((r) => (r as { status: string }).status === "accepted")).toHaveLength(1);
    expect(results.filter((r) => (r as { status: string }).status === "duplicate")).toHaveLength(3);
    expect(
      await env.STAGING_DB.prepare("SELECT COUNT(*) n FROM discovered_code_events").first("n"),
    ).toBe(3);
    await oneOperation(codeOf(first), 1);
  });
  it.each(["manual-first", "discovery-first", "concurrent"])(
    "preserves first metadata across a %s code collision",
    async (order) => {
      await seedPlayer(env.STAGING_DB, followId());
      const event = followEvent();
      const code = codeOf(event);
      const command = manual(code);
      const manualRun = () =>
        openDistribution(env.STAGING_DB, loadConfig(discoveryEnv()), code, new Date(), command);
      const discoveryRun = async () =>
        (await sendDiscovery(event)).json() as Promise<{ status: string }>;
      if (order === "manual-first") {
        expect((await manualRun()).kind).toBe("accepted");
        expect((await discoveryRun()).status).toBe("duplicate");
      } else if (order === "discovery-first") {
        expect((await discoveryRun()).status).toBe("accepted");
        expect((await manualRun()).kind).toBe("duplicate_code");
      } else {
        const [m, d] = await Promise.all([manualRun(), discoveryRun()]);
        expect(Number(m.kind === "accepted") + Number(d.status === "accepted")).toBe(1);
      }
      const stored = await env.STAGING_DB.prepare("SELECT * FROM gift_codes WHERE code=?1")
        .bind(code)
        .first();
      const discovery = await row(event.event_id);
      const manualRow = await env.STAGING_DB.prepare(
        "SELECT status FROM manual_code_commands WHERE event_id=?1",
      )
        .bind(command.event_id)
        .first<string>("status");
      expect([discovery!.status, manualRow].sort()).toEqual(["accepted", "duplicate_code"]);
      await discoveryRun();
      await manualRun();
      expect(
        await env.STAGING_DB.prepare("SELECT * FROM gift_codes WHERE code=?1").bind(code).first(),
      ).toEqual(stored);
      expect(stored).toMatchObject(
        discovery!.status === "accepted"
          ? { source: "discord-follow-staging", first_seen_event_id: event.event_id }
          : { source: "manual-staging", first_seen_event_id: command.event_id },
      );
      // Even a source whose original code lost to manual intake cannot later introduce another code.
      const changedCode = `Changed_${followId()}`;
      expect(
        await (
          await sendDiscovery(
            followEvent({
              source_message_id: event.source_message_id,
              content: content(changedCode),
            }),
          )
        ).json(),
      ).toEqual({ status: "duplicate" });
      expect(
        await env.STAGING_DB.prepare("SELECT 1 FROM gift_codes WHERE code=?1")
          .bind(changedCode)
          .first(),
      ).toBeNull();
      await oneOperation(code, 1);
    },
  );
  it("retries a lost response through the real companion client and HTTP endpoint", async () => {
    const event = followEvent();
    const config = loadConfig(discoveryEnv());
    const companion = {
      ...CONFIG,
      discordGuildId: event.guild_id,
      followSource: config.followSource,
      ingestionSharedSecret: env.INGESTION_SHARED_SECRET,
    };
    const routed = routeMessage(
      message({
        id: event.event_id,
        guildId: event.guild_id,
        channelId: event.channel_id,
        webhookId: event.webhook_id,
        authorIsBot: true,
        flags: 2,
        reference: {
          type: 0,
          guildId: event.source_guild_id,
          channelId: event.source_channel_id,
          messageId: event.source_message_id,
        },
        content: event.content,
        createdAt: new Date(event.created_at),
      }),
      companion,
    );
    expect(routed?.kind).toBe("discovered_code");
    let attempts = 0;
    const result = await forwardToWorker(companion, routed!, {
      delay: async () => {},
      fetcher: async (req) => {
        attempts++;
        const response = await worker.fetch(req, discoveryEnv(), createExecutionContext());
        if (attempts === 1) {
          expect(await response.json()).toEqual({ status: "accepted" });
          throw new Error("synthetic lost response");
        }
        return response;
      },
    });
    expect(result).toBe("duplicate");
    expect(attempts).toBe(2);
    await oneOperation(codeOf(event), 0);
  });
  it("rolls back the source claim, code, operation and snapshot when acceptance fails", async () => {
    const event = followEvent();
    await seedPlayer(env.STAGING_DB, followId());
    await env.STAGING_DB.prepare(
      "CREATE TRIGGER synthetic_snapshot_failure BEFORE INSERT ON operation_players_snapshot BEGIN SELECT RAISE(ABORT,'synthetic'); END",
    ).run();
    expect((await sendDiscovery(event)).status).toBe(503);
    for (const table of [
      "discovered_code_events",
      "gift_codes",
      "operations",
      "operation_players_snapshot",
    ])
      expect(await env.STAGING_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n")).toBe(0);
    await env.STAGING_DB.prepare("DROP TRIGGER synthetic_snapshot_failure").run();
    expect(await (await sendDiscovery(event)).json()).toEqual({ status: "accepted" });
    await oneOperation(codeOf(event), 1);
  });
  it("enforces the 2000-player bound inside the transaction", async () => {
    await env.STAGING_DB.prepare(
      `INSERT INTO players(player_id,state,created_at,updated_at) SELECT CAST(value AS TEXT),'7',?1,?1 FROM json_each(?2)`,
    )
      .bind(new Date().toISOString(), JSON.stringify(Array.from({ length: 2001 }, (_, i) => i + 1)))
      .run();
    const event = followEvent();
    expect((await sendDiscovery(event)).status).toBe(503);
    for (const table of [
      "discovered_code_events",
      "gift_codes",
      "operations",
      "operation_players_snapshot",
    ])
      expect(await env.STAGING_DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n")).toBe(0);
    await env.STAGING_DB.prepare("DELETE FROM players WHERE player_id='2001'").run();
    const counted = countD1(env.STAGING_DB);
    expect(
      await (await sendDiscovery(event, discoveryEnv({ STAGING_DB: counted.db }))).json(),
    ).toEqual({ status: "accepted" });
    expect(counted.stats.statements).toBe(6);
    expect(counted.stats.batchSizes).toEqual([5]);
    expect(counted.stats.maxBindings).toBe(12);
    await oneOperation(codeOf(event), 2000);
  });
});

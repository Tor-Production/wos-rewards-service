import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { runCommunityJsonSource } from "../src/discovery/community-json-runtime";
import type { ManualCodeCommandEvent } from "../src/manual-code/types";
import { expandPage, openDistribution } from "../src/operations/distribution";
import { scheduledWork } from "../src/runtime/handlers";
import { content, discoveryEnv, followEvent, followId, sendDiscovery } from "./support/discovery";
import { seedPlayer } from "./support/fixtures";

const db = env.STAGING_DB;
const origin = Date.parse("2026-09-22T00:00:00.000Z");
const at = (minutes: number) => new Date(origin + minutes * 60_000);
const config = () => loadConfig({ ...env, COMMUNITY_JSON_SOURCE_ENABLED: true });
const feed = (entries: readonly (string | { code: string; status: string })[]) => ({
  maintainedBy: "synthetic",
  source: "synthetic",
  updatedAt: "2026-09-22T00:00:00Z",
  codes: entries.map((entry) => ({
    code: typeof entry === "string" ? entry : entry.code,
    status: typeof entry === "string" ? "active" : entry.status,
    firstSeenAt: "2026-09-22T00:00:00Z",
  })),
});
const response = (entries: readonly (string | { code: string; status: string })[]) => async () =>
  new Response(JSON.stringify(feed(entries)), { headers: { etag: '"synthetic"' } });
const tick = (minutes: number, entries: readonly (string | { code: string; status: string })[]) =>
  runCommunityJsonSource(db, config(), at(minutes), response(entries));
const state = () =>
  db.prepare("SELECT * FROM community_json_source_state").first<Record<string, unknown>>();
const observation = (code: string) =>
  db
    .prepare("SELECT * FROM community_json_code_observations WHERE code=?1")
    .bind(code)
    .first<Record<string, unknown>>();
const code = (value: string) =>
  db.prepare("SELECT * FROM gift_codes WHERE code=?1").bind(value).first<Record<string, unknown>>();
const count = (table: string) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>("n");

beforeEach(async () => {
  await db.prepare("DROP TRIGGER IF EXISTS synthetic_community_operation_failure").run();
  await db.prepare("DELETE FROM discovered_code_events WHERE canonical_event_id IS NOT NULL").run();
  for (const table of [
    "terminal_receipts",
    "terminal_observations",
    "operation_late_results",
    "summary_item_snapshot",
    "summary_chunk_layout",
    "discord_output_deliveries",
    "outbox_jobs",
    "operation_items",
    "operation_players_snapshot",
    "community_json_code_observations",
    "discovered_code_events",
    "manual_code_commands",
    "redemptions",
    "processed_events",
    "operations",
    "gift_codes",
    "players",
    "community_json_source_state",
    "scheduler_progress",
    "dispatch_control",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

describe("disabled community source, real D1 and scheduler budget", () => {
  it("logs one closed failure category and preserves the request gate if logging throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("synthetic log sink failure");
    });
    try {
      await runCommunityJsonSource(
        db,
        config(),
        at(0),
        async () => new Response(JSON.stringify({ ...feed([]), extra: "private-canary" })),
      );
      expect(warn).toHaveBeenCalledExactlyOnceWith({
        event: "community_fetch_outcome",
        environment: "staging",
        outcome: "schema_invalid",
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private-canary");
      expect(await state()).toMatchObject({
        initialized: 0,
        stopped: 0,
        claim_token: null,
        next_fetch_at: at(30).toISOString(),
      });
      expect(await count("community_json_code_observations")).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("does no D1 or HTTP work while disabled", async () => {
    let requests = 0;
    await runCommunityJsonSource(db, loadConfig(env), at(0), async () => {
      requests++;
      return new Response("{}");
    });
    expect(requests).toBe(0);
    expect(await count("community_json_source_state")).toBe(0);
  });

  it("reserves a 30-minute slot before HTTP and reconciles a larger snapshot under the scheduler budget", async () => {
    const runtime = { ...env, COMMUNITY_JSON_SOURCE_ENABLED: true } as Env;
    const baseline = ["Base1", "Base2", "Base3", "Base4"];
    let requests = 0;
    const fetcher = async () => {
      requests++;
      return new Response(JSON.stringify(feed(requests === 1 ? baseline : [...baseline, "New23"])));
    };
    for (const minute of [0, 15, 29, 30, 30, 30]) {
      await scheduledWork(runtime, { now: () => at(minute), communityFetcher: fetcher });
    }
    expect(requests).toBe(2);
    expect((await code("New23"))?.source).toBe("community-json-wosc-staging");
    expect((await observation("New23"))?.operation_id).toEqual(expect.any(String));
    expect(await count("operations")).toBe(1);
    expect((await state())?.next_fetch_at).toBe(at(60).toISOString());
    await expect(
      db
        .prepare(
          "UPDATE community_json_code_observations SET first_source_updated_at='2026-09-23T00:00:00Z' WHERE code='New23'",
        )
        .run(),
    ).rejects.toThrow("community_provenance_immutable");
  });

  it("retires expired and removed entries before expansion, then reappears without another operation", async () => {
    await tick(0, []);
    await tick(30, ["New23"]);
    await tick(30, ["New23"]);
    await tick(30, ["New23"]); // finalize the durable snapshot after its one-code action
    const original = await observation("New23");
    expect((await code("New23"))?.status).toBe("active");
    await tick(60, [{ code: "New23", status: "expired" }]);
    await tick(60, []);
    expect((await code("New23"))?.status).toBe("disabled");
    expect((await observation("New23"))?.source_active).toBe(0);
    await expandPage(db, at(60).toISOString());
    expect(await count("operation_items")).toBe(0);
    expect(await count("outbox_jobs")).toBe(0);
    await tick(60, []);
    await tick(90, ["New23"]);
    await tick(90, []);
    expect((await code("New23"))?.status).toBe("active");
    expect((await observation("New23"))?.operation_id).toBe(original?.operation_id);
    expect(await count("operations")).toBe(1);
  });

  it("preserves another Follow source in either discovery order", async () => {
    await tick(0, []);
    await tick(30, ["Shared23"]);
    await tick(30, []);
    await tick(30, []);
    const event = followEvent({ content: content("Shared23") });
    expect(
      await (
        await sendDiscovery(
          event,
          discoveryEnv({
            COMMUNITY_JSON_SOURCE_ENABLED: true,
          }),
        )
      ).json(),
    ).toEqual({ status: "duplicate" });
    await tick(60, []);
    await tick(60, []);
    await tick(60, []);
    expect((await code("Shared23"))?.status).toBe("active");
    expect((await code("Shared23"))?.source).toBe("community-json-wosc-staging");

    const other = followEvent({ content: content("FollowFirst23") });
    expect(await (await sendDiscovery(other)).json()).toEqual({ status: "accepted" });
    await tick(90, ["FollowFirst23"]);
    await tick(90, []);
    await tick(90, []);
    await tick(120, []);
    await tick(120, []);
    expect((await code("FollowFirst23"))?.status).toBe("active");
    expect((await code("FollowFirst23"))?.source).toBe("discord-follow-staging");
    expect((await observation("FollowFirst23"))?.source_active).toBe(0);
  });

  for (const source of ["follow", "manual"] as const)
    for (const populated of [true, false])
      it(`${source}-first ${populated ? "populated" : "empty"} membership stays frozen after a late join and duplicate feed sighting`, async () => {
        const duplicate = `A${source}${populated ? "Pop" : "Empty"}23`;
        const later = `Z${source}${populated ? "Pop" : "Empty"}23`;
        const firstPlayer = "9100000000000000001";
        const latePlayer = "9100000000000000002";
        const runtime = {
          ...env,
          COMMUNITY_JSON_SOURCE_ENABLED: true,
          DISCORD_DELIVERY_ENABLED: false,
        } as unknown as Env;
        let requests = 0;
        const fetcher = async () =>
          new Response(JSON.stringify(feed(++requests === 1 ? [] : [duplicate, later])));
        await scheduledWork(runtime, { now: () => at(0), communityFetcher: fetcher });
        if (populated) await seedPlayer(db, firstPlayer, "1", "Original", at(1));

        if (source === "follow") {
          const event = followEvent({ content: content(duplicate) });
          expect(await (await sendDiscovery(event)).json()).toEqual({ status: "accepted" });
        } else {
          const command: ManualCodeCommandEvent = {
            event_id: followId(),
            guild_id: env.DISCORD_GUILD_ID,
            channel_id: env.DISCORD_MVP_ADMIN_CHANNEL_ID,
            author_id: "1000000000000000011",
            author_is_bot: false,
            author_is_system: false,
            webhook_id: null,
            application_id: null,
            code: duplicate,
            created_at: at(1).toISOString(),
          };
          expect(await openDistribution(db, config(), duplicate, at(1), command)).toEqual({
            kind: "accepted",
            operationId: expect.any(String),
          });
        }

        const original = await db
          .prepare(
            `SELECT operation_id,trigger_kind,trigger_ref,snapshot_at,expected_count,
              deadline_at,created_at,summary_context FROM operations WHERE trigger_ref=?1`,
          )
          .bind(duplicate)
          .first<Record<string, unknown>>();
        expect(original?.expected_count).toBe(populated ? 1 : 0);
        const originalMembers = (
          await db
            .prepare(
              "SELECT player_id,display_name FROM operation_players_snapshot WHERE operation_id=?1 ORDER BY player_id",
            )
            .bind(original?.operation_id)
            .all()
        ).results;
        expect(originalMembers).toHaveLength(populated ? 1 : 0);
        await seedPlayer(db, latePlayer, "1", "Late", at(2));

        // The real scheduled wrapper enforces the 12-statement source budget on each tick.
        for (let i = 0; i < 4; i++)
          await scheduledWork(runtime, { now: () => at(30), communityFetcher: fetcher });

        expect(requests).toBe(2);
        expect((await state())?.pending_snapshot_json).toBeNull();
        expect(await observation(duplicate)).toMatchObject({
          baseline: 0,
          source_active: 1,
          operation_id: null,
        });
        expect((await code(duplicate))?.source).toBe(
          source === "follow" ? "discord-follow-staging" : "manual-staging",
        );
        expect(
          await db
            .prepare(
              `SELECT operation_id,trigger_kind,trigger_ref,snapshot_at,expected_count,
                deadline_at,created_at,summary_context FROM operations WHERE trigger_ref=?1`,
            )
            .bind(duplicate)
            .first(),
        ).toEqual(original);
        expect(
          (
            await db
              .prepare(
                "SELECT player_id,display_name FROM operation_players_snapshot WHERE operation_id=?1 ORDER BY player_id",
              )
              .bind(original?.operation_id)
              .all()
          ).results,
        ).toEqual(originalMembers);
        expect((await observation(later))?.operation_id).toEqual(expect.any(String));
        const newOperation = await db
          .prepare("SELECT operation_id,expected_count FROM operations WHERE trigger_ref=?1")
          .bind(later)
          .first<{ operation_id: string; expected_count: number }>();
        expect(newOperation?.expected_count).toBe(populated ? 2 : 1);
        expect(
          (
            await db
              .prepare(
                "SELECT player_id FROM operation_players_snapshot WHERE operation_id=?1 ORDER BY player_id",
              )
              .bind(newOperation?.operation_id)
              .all<{ player_id: string }>()
          ).results.map((row) => row.player_id),
        ).toEqual(populated ? [firstPlayer, latePlayer] : [latePlayer]);
      });

  it("reactivates a withdrawn community-first code when Follow later accepts the same code", async () => {
    await tick(0, []);
    await tick(30, ["LateFollow23"]);
    await tick(30, []);
    await tick(30, []);
    await tick(60, []);
    await tick(60, []);
    expect((await code("LateFollow23"))?.status).toBe("disabled");
    const event = followEvent({ content: content("LateFollow23") });
    expect(await (await sendDiscovery(event)).json()).toEqual({ status: "duplicate" });
    expect((await code("LateFollow23"))?.status).toBe("active");
    expect((await code("LateFollow23"))?.source).toBe("community-json-wosc-staging");
    expect((await observation("LateFollow23"))?.source_active).toBe(0);
  });

  it("stops partial expansion and retains held/in-flight rows without repeating player/code work", async () => {
    await tick(0, []);
    const stamp = at(30).toISOString();
    await db
      .prepare(
        `INSERT INTO players(player_id,state,created_at,updated_at)
      SELECT CAST(value AS TEXT),'1',?1,?1 FROM json_each(?2)`,
      )
      .bind(stamp, JSON.stringify(Array.from({ length: 129 }, (_, n) => n + 1)))
      .run();
    await tick(30, ["Partial23"]);
    await tick(30, []);
    await tick(30, []);
    const op = (await observation("Partial23"))?.operation_id as string;
    await expandPage(db, at(31).toISOString());
    expect(await count("operation_items")).toBe(128);
    const held = await db
      .prepare(
        `SELECT item_key,player_id FROM operation_items
      WHERE operation_id=?1 ORDER BY item_key LIMIT 1`,
      )
      .bind(op)
      .first<{ item_key: string; player_id: string }>();
    expect(held).not.toBeNull();
    await db
      .prepare(
        `UPDATE operation_items SET status='in_progress'
      WHERE operation_id=?1 AND item_key=?2`,
      )
      .bind(op, held!.item_key)
      .run();
    await db
      .prepare(
        `INSERT INTO redemptions
      (player_id,code,idempotency_key,status,reason_code,dispatch_hold_token,dispatch_hold_generation,updated_at)
      VALUES (?1,'Partial23',?2,'permanent_failure','outcome_uncertain','held',1,?3)`,
      )
      .bind(held!.player_id, `redeem:v1:${held!.player_id}:Partial23`, stamp)
      .run();
    await tick(60, []);
    await tick(60, []);
    await expandPage(db, at(60).toISOString());
    expect(await count("operation_items")).toBe(128);
    expect(
      await db
        .prepare("SELECT expansion_state FROM operations WHERE operation_id=?1")
        .bind(op)
        .first("expansion_state"),
    ).toBe("expanded");
    expect(
      await db
        .prepare("SELECT expected_count FROM operations WHERE operation_id=?1")
        .bind(op)
        .first("expected_count"),
    ).toBe(128);
    expect(
      await db
        .prepare(
          `SELECT status FROM operation_items WHERE operation_id=?1
      AND item_key=?2`,
        )
        .bind(op, held!.item_key)
        .first("status"),
    ).toBe("in_progress");
    expect(
      await db
        .prepare(
          `SELECT dispatch_hold_token FROM redemptions
      WHERE player_id=?1 AND code='Partial23'`,
        )
        .bind(held!.player_id)
        .first("dispatch_hold_token"),
    ).toBe("held");
    expect(
      await db
        .prepare(
          `SELECT COUNT(*) n FROM operation_items
      WHERE operation_id=?1 AND status='permanent_failure' AND reason_code='source_withdrawn'`,
        )
        .bind(op)
        .first("n"),
    ).toBe(127);
  });

  it("cancels only the withdrawn code's pending registration item and job", async () => {
    await tick(0, []);
    await tick(30, ["Withdraw23"]);
    await tick(30, []);
    await tick(30, []);
    const stamp = at(30).toISOString();
    await db
      .prepare(
        "INSERT INTO players(player_id,state,created_at,updated_at) VALUES ('90023','1',?1,?1)",
      )
      .bind(stamp)
      .run();
    await db
      .prepare(
        "INSERT INTO gift_codes(code,status,discovered_at,source) VALUES ('Keep23','active',?1,'manual-staging')",
      )
      .bind(stamp)
      .run();
    await db
      .prepare(
        `INSERT INTO operations
      (operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,deadline_at,created_at,updated_at)
      VALUES ('reg23','registration_run','discord_event','event23',?1,2,?2,?1,?1)`,
      )
      .bind(stamp, at(90).toISOString())
      .run();
    for (const name of ["Withdraw23", "Keep23"]) {
      await db
        .prepare(
          `INSERT INTO operation_items
        (operation_id,item_key,player_id,code,job_id,status,display_label,updated_at)
        VALUES ('reg23',?1,'90023',?1,?2,'pending','ID 90023',?3)`,
        )
        .bind(name, `reg23:${name}`, stamp)
        .run();
      await db
        .prepare(
          `INSERT INTO outbox_jobs
        (job_id,operation_id,item_key,type,attempt_id,payload_json,status,available_at,created_at,updated_at)
        VALUES (?1,'reg23',?2,'registration',?3,'{}','pending',?4,?4,?4)`,
        )
        .bind(`reg23:${name}`, name, `attempt:${name}`, stamp)
        .run();
    }
    await tick(60, []);
    await tick(60, []);
    const items = (
      await db
        .prepare("SELECT code,status FROM operation_items WHERE operation_id='reg23' ORDER BY code")
        .all()
    ).results;
    expect(items).toEqual([
      { code: "Keep23", status: "pending" },
      { code: "Withdraw23", status: "permanent_failure" },
    ]);
    const jobs = (
      await db
        .prepare(
          "SELECT item_key,status FROM outbox_jobs WHERE operation_id='reg23' ORDER BY item_key",
        )
        .all()
    ).results;
    expect(jobs).toEqual([
      { item_key: "Keep23", status: "pending" },
      { item_key: "Withdraw23", status: "dead" },
    ]);
  });

  it("does not refetch after a lost post-fetch state write or let a stale claimant overwrite a newer snapshot", async () => {
    await tick(0, []);
    let calls = 0;
    const failing = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("SET pending_snapshot_json="))
              throw new Error("synthetic state write failure");
            return target.prepare(sql);
          };
        return Reflect.get(target, key, target);
      },
    }) as D1Database;
    await expect(
      runCommunityJsonSource(failing, config(), at(30), async () => {
        calls++;
        return new Response(JSON.stringify(feed(["Lost23"])));
      }),
    ).rejects.toThrow("synthetic state write failure");
    await runCommunityJsonSource(db, config(), at(31.1), async () => {
      calls++;
      return new Response(JSON.stringify(feed(["Early23"])));
    });
    expect(calls).toBe(1);
    expect((await state())?.next_fetch_at).toBe(at(60).toISOString());

    let resolveFirst: ((response: Response) => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let clock = at(60);
    const first = runCommunityJsonSource(
      db,
      config(),
      at(60),
      async () => {
        started?.();
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      },
      () => clock,
    );
    await startedPromise;
    clock = at(90);
    await runCommunityJsonSource(db, config(), at(90), response(["Current23"]));
    resolveFirst?.(new Response(JSON.stringify(feed(["Stale23"]))));
    await first;
    expect(JSON.stringify((await state())?.pending_snapshot_json)).toContain("Current23");
    expect(JSON.stringify((await state())?.pending_snapshot_json)).not.toContain("Stale23");
  });

  it("rolls back provenance, code and operation together after an acceptance failure, then resumes without refetch", async () => {
    await tick(0, []);
    await tick(30, ["Fail23"]);
    await db
      .prepare(
        `CREATE TRIGGER synthetic_community_operation_failure
      BEFORE INSERT ON operations WHEN NEW.trigger_ref='Fail23'
      BEGIN SELECT RAISE(ABORT,'synthetic acceptance failure'); END`,
      )
      .run();
    await expect(tick(30, [])).rejects.toThrow("synthetic acceptance failure");
    expect(await observation("Fail23")).toBeNull();
    expect(await code("Fail23")).toBeNull();
    expect(await count("operations")).toBe(0);
    expect((await state())?.pending_snapshot_json).toContain("Fail23");
    await db.prepare("DROP TRIGGER synthetic_community_operation_failure").run();
    let requests = 0;
    await runCommunityJsonSource(db, config(), at(31.1), async () => {
      requests++;
      return new Response("{}");
    });
    expect(requests).toBe(0);
    expect((await observation("Fail23"))?.operation_id).toEqual(expect.any(String));
    expect((await code("Fail23"))?.status).toBe("active");
    expect(await count("operations")).toBe(1);
  });

  it("contains a community database failure after the existing scheduled lanes", async () => {
    const runtime = { ...env, COMMUNITY_JSON_SOURCE_ENABLED: true } as Env;
    await scheduledWork(runtime, { now: () => at(0), communityFetcher: response([]) });
    await db
      .prepare(
        `INSERT INTO gift_codes(code,status,discovered_at,source)
      VALUES ('Independent23','active',?1,'synthetic-local')`,
      )
      .bind(at(0).toISOString())
      .run();
    await db
      .prepare(
        `INSERT INTO operations
      (operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,deadline_at,created_at,updated_at)
      VALUES ('independent23','code_distribution_run','discovered_code','Independent23',
        ?1,0,?2,?1,?1)`,
      )
      .bind(at(0).toISOString(), at(90).toISOString())
      .run();
    const failing = new Proxy(db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("community_json_source_state"))
              throw new Error("synthetic community D1 failure");
            return target.prepare(sql);
          };
        return Reflect.get(target, key, target);
      },
    }) as D1Database;
    await expect(
      scheduledWork(
        { ...runtime, STAGING_DB: failing },
        {
          now: () => at(30),
          communityFetcher: response(["Never23"]),
        },
      ),
    ).resolves.toBeUndefined();
    expect(await code("Never23")).toBeNull();
    expect(
      await db
        .prepare(
          `SELECT expansion_state FROM operations
      WHERE operation_id='independent23'`,
        )
        .first("expansion_state"),
    ).toBe("expanded");
  });

  it("honors long numeric and HTTP-date Retry-After values without shortening the request gate", async () => {
    await tick(0, []);
    await runCommunityJsonSource(
      db,
      config(),
      at(30),
      async () => new Response(null, { status: 429, headers: { "retry-after": "172800" } }),
    );
    expect((await state())?.next_fetch_at).toBe(at(2910).toISOString());
    let requests = 0;
    await runCommunityJsonSource(db, config(), at(2909), async () => {
      requests++;
      return new Response("{}");
    });
    expect(requests).toBe(0);
    await runCommunityJsonSource(
      db,
      config(),
      at(2910),
      async () =>
        new Response(null, {
          status: 429,
          headers: {
            "retry-after": at(3150).toUTCString(),
          },
        }),
    );
    expect((await state())?.next_fetch_at).toBe(at(3150).toISOString());
  });

  it("stops automatically when Retry-After cannot be represented as a date", async () => {
    await tick(0, []);
    await runCommunityJsonSource(
      db,
      config(),
      at(30),
      async () =>
        new Response(null, { status: 429, headers: { "retry-after": "9007199254740991" } }),
    );
    expect((await state())?.stopped).toBe(1);
    let calls = 0;
    await runCommunityJsonSource(db, config(), at(90), async () => {
      calls++;
      return new Response("{}");
    });
    expect(calls).toBe(0);
  });

  it("stops durably on access denial and preserves eligibility on 304 and invalid payloads", async () => {
    await tick(0, []);
    await tick(30, ["Known23"]);
    await tick(30, []);
    await tick(30, []);
    await runCommunityJsonSource(
      db,
      config(),
      at(60),
      async () => new Response(JSON.stringify({ ...feed([]), updatedAt: "2026-09-21T00:00:00Z" })),
    );
    expect((await code("Known23"))?.status).toBe("active");
    expect((await state())?.pending_snapshot_json).toBeNull();
    await runCommunityJsonSource(
      db,
      config(),
      at(90),
      async () => new Response(null, { status: 304 }),
    );
    expect((await code("Known23"))?.status).toBe("active");
    await runCommunityJsonSource(db, config(), at(120), async () => new Response("{"));
    expect((await code("Known23"))?.status).toBe("active");
    await runCommunityJsonSource(
      db,
      config(),
      at(150),
      async () => new Response(null, { status: 403 }),
    );
    expect((await state())?.stopped).toBe(1);
    let calls = 0;
    await runCommunityJsonSource(db, config(), at(210), async () => {
      calls++;
      return new Response("{}");
    });
    expect(calls).toBe(0);
  });

  it("compares source timestamps as instants, not lexical strings", async () => {
    await tick(0, []);
    await runCommunityJsonSource(
      db,
      config(),
      at(30),
      async () =>
        new Response(
          JSON.stringify({ ...feed(["Precise23"]), updatedAt: "2026-09-22T00:00:00.500Z" }),
        ),
    );
    await tick(30, []);
    await tick(30, []);
    await tick(60, []);
    expect((await state())?.pending_snapshot_json).toBeNull();
    expect((await code("Precise23"))?.status).toBe("active");
  });
});

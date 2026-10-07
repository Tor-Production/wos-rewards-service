import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { runRssSource } from "../src/discovery/rss-runtime";
import { runCommunityJsonSource } from "../src/discovery/community-json-runtime";
import { RSS_SOURCE } from "../src/discovery/rss";
import { scheduledWork } from "../src/runtime/handlers";
import { content, followEvent, sendDiscovery } from "./support/discovery";
import { rssFeed, type SyntheticRssItem } from "./support/rss";

const db = env.STAGING_DB;
const rssRuntime = { ...env, RSS_SOURCE_ENABLED: true } as unknown as Env;
const bothSources = {
  ...env,
  RSS_SOURCE_ENABLED: true,
  COMMUNITY_JSON_SOURCE_ENABLED: true,
} as unknown as Env;
const config = () => loadConfig(rssRuntime);
const bothConfig = () => loadConfig(bothSources);
const at = (minutes: number) => new Date(Date.parse("2026-10-01T00:00:00.000Z") + minutes * 60_000);
const count = (table: string) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).first<number>("n");
const state = () =>
  db
    .prepare("SELECT * FROM rss_source_state WHERE source_id=?1")
    .bind(RSS_SOURCE)
    .first<Record<string, unknown>>();
const rssCode = (code: string) =>
  db
    .prepare("SELECT * FROM rss_code_observations WHERE code=?1")
    .bind(code)
    .first<Record<string, unknown>>();
const giftCode = (code: string) =>
  db.prepare("SELECT * FROM gift_codes WHERE code=?1").bind(code).first<Record<string, unknown>>();
const feedResponse = (items: readonly SyntheticRssItem[]) =>
  new Response(rssFeed(items), {
    headers: { "content-type": "application/rss+xml; charset=UTF-8" },
  });
const rssTick = (minutes: number, items: readonly SyntheticRssItem[], fetcher?: typeof fetch) =>
  runRssSource(db, config(), at(minutes), fetcher ?? (async () => feedResponse(items)), () =>
    at(minutes),
  );
const jsonFeed = (entries: readonly { code: string; status: string }[]) => ({
  maintainedBy: "synthetic fixture",
  source: "synthetic fixture",
  updatedAt: "2026-10-01T00:00:00Z",
  codes: entries.map((entry) => ({ ...entry, firstSeenAt: "2026-09-30T00:00:00Z" })),
});
const jsonTick = (minutes: number, entries: readonly { code: string; status: string }[]) =>
  runCommunityJsonSource(
    db,
    bothConfig(),
    at(minutes),
    async () => new Response(JSON.stringify(jsonFeed(entries))),
    () => at(minutes),
  );

beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await db.prepare("DELETE FROM terminal_receipts").run();
  await db.prepare("DELETE FROM terminal_observations").run();
  await db.prepare("DELETE FROM operation_late_results").run();
  await db.prepare("DELETE FROM summary_item_snapshot").run();
  await db.prepare("DELETE FROM summary_chunk_layout").run();
  await db.prepare("DELETE FROM discord_output_deliveries").run();
  await db.prepare("DELETE FROM outbox_jobs").run();
  await db.prepare("DELETE FROM operation_items").run();
  await db.prepare("DELETE FROM operation_players_snapshot").run();
  await db.prepare("DELETE FROM rss_code_observations").run();
  await db.prepare("DELETE FROM rss_item_observations").run();
  await db.prepare("DELETE FROM rss_source_state").run();
  await db.prepare("DELETE FROM community_json_code_observations").run();
  await db.prepare("DELETE FROM discovered_code_events WHERE canonical_event_id IS NOT NULL").run();
  await db.prepare("DELETE FROM discovered_code_events").run();
  await db.prepare("DELETE FROM manual_code_commands").run();
  await db.prepare("DELETE FROM redemptions").run();
  await db.prepare("DELETE FROM processed_events").run();
  await db.prepare("DELETE FROM operations").run();
  await db.prepare("DELETE FROM gift_codes").run();
  await db.prepare("DELETE FROM players").run();
  await db.prepare("DELETE FROM community_json_source_state").run();
});

afterEach(() => vi.restoreAllMocks());

describe("disabled staging/mock RSS source", () => {
  it("does no D1 or HTTP work while disabled", async () => {
    let requests = 0;
    await runRssSource(db, loadConfig(env), at(0), async () => {
      requests++;
      return feedResponse([]);
    });
    expect(requests).toBe(0);
    expect(await count("rss_source_state")).toBe(0);
  });

  it("reserves one durable 30-minute slot across concurrent polls", async () => {
    let requests = 0;
    const fetcher = async () => {
      requests++;
      await Promise.resolve();
      return feedResponse([]);
    };
    await Promise.all([
      runRssSource(db, config(), at(0), fetcher, () => at(0)),
      runRssSource(db, config(), at(0), fetcher, () => at(0)),
    ]);
    expect(requests).toBe(1);
    expect(await state()).toMatchObject({
      initialized: 0,
      next_fetch_at: at(30).toISOString(),
      pending_snapshot_json: "[]",
    });
  });

  it("keeps the scheduled Worker lane within its independent query budget", async () => {
    let requests = 0;
    await scheduledWork(rssRuntime, {
      now: () => at(0),
      rssFetcher: async () => {
        requests++;
        return feedResponse([]);
      },
    });
    expect(requests).toBe(1);
    expect(await state()).toMatchObject({ next_fetch_at: at(30).toISOString() });
  });

  it("keeps the first feed as a non-distributing historical baseline", async () => {
    const historic = [
      { code: "HISTORY23", guid: "synthetic-old-a" },
      { code: "HISTORY42", guid: "synthetic-old-b" },
    ];
    await rssTick(0, historic);
    await rssTick(1, historic);
    await rssTick(2, historic);
    await rssTick(3, historic);
    expect(await state()).toMatchObject({ initialized: 1, pending_snapshot_json: null });
    expect(await count("rss_item_observations")).toBe(2);
    expect(await count("rss_code_observations")).toBe(2);
    expect(await count("gift_codes")).toBe(0);
    expect(await count("operations")).toBe(0);
    expect(await rssCode("HISTORY23")).toMatchObject({ baseline: 1, source_active: 1 });
  });

  it("distributes a new item once, keeps disappearance active and treats edits/reappearance idempotently", async () => {
    await rssTick(0, []);
    await rssTick(1, []);
    await rssTick(30, [{ code: "ACTIVE23", guid: "synthetic-stable-guid" }]);
    await rssTick(31, [{ code: "ACTIVE23", guid: "synthetic-stable-guid" }]);
    await rssTick(32, [{ code: "ACTIVE23", guid: "synthetic-stable-guid" }]);
    expect((await giftCode("ACTIVE23"))?.status).toBe("active");
    expect(await count("operations")).toBe(1);

    await rssTick(60, []);
    await rssTick(61, []);
    expect((await giftCode("ACTIVE23"))?.status).toBe("active");

    await rssTick(90, [{ code: "EDITED23", guid: "synthetic-stable-guid" }]);
    await rssTick(91, [{ code: "EDITED23", guid: "synthetic-stable-guid" }]);
    await rssTick(92, [{ code: "EDITED23", guid: "synthetic-stable-guid" }]);
    expect((await giftCode("ACTIVE23"))?.status).toBe("active");
    expect((await giftCode("EDITED23"))?.status).toBe("active");
    expect(await count("operations")).toBe(2);

    await rssTick(120, [{ code: "ACTIVE23", guid: "synthetic-stable-guid" }]);
    await rssTick(121, [{ code: "ACTIVE23", guid: "synthetic-stable-guid" }]);
    await rssTick(122, [{ code: "ACTIVE23", guid: "synthetic-stable-guid" }]);
    expect(await count("operations")).toBe(2);
    expect(await count("rss_item_observations")).toBe(2);
  });

  it("deduplicates duplicate items within the feed and codes already accepted by Follow", async () => {
    await rssTick(0, []);
    await rssTick(1, []);
    const event = followEvent({ content: content("SHARED23") });
    expect(await (await sendDiscovery(event)).json()).toEqual({ status: "accepted" });
    expect(await count("operations")).toBe(1);

    const duplicates = [
      { code: "SHARED23", guid: "synthetic-shared-a" },
      { code: "SHARED23", guid: "synthetic-shared-b" },
    ];
    await rssTick(30, duplicates);
    await rssTick(31, duplicates);
    await rssTick(32, duplicates);
    await rssTick(33, duplicates);
    expect(await count("rss_item_observations")).toBe(2);
    expect(await count("rss_code_observations")).toBe(1);
    expect((await giftCode("SHARED23"))?.source).toBe("discord-follow-staging");
    expect(await count("operations")).toBe(1);
  });

  it("extends the durable poll gap for Retry-After and stops on an unparseable restriction", async () => {
    let requests = 0;
    const throttled = async () => {
      requests++;
      return new Response(null, { status: 429, headers: { "retry-after": "7200" } });
    };
    await rssTick(0, [], throttled);
    expect(await state()).toMatchObject({ next_fetch_at: at(120).toISOString(), stopped: 0 });
    await rssTick(60, [], throttled);
    await rssTick(119, [], throttled);
    expect(requests).toBe(1);
    await rssTick(120, [], async () => {
      requests++;
      return new Response(null, { status: 429, headers: { "retry-after": "unknown" } });
    });
    expect(requests).toBe(2);
    expect(await state()).toMatchObject({ stopped: 1 });
    await rssTick(180, [], async () => {
      requests++;
      return feedResponse([]);
    });
    expect(requests).toBe(2);
  });

  it("leaves existing codes untouched after malformed network payloads", async () => {
    await rssTick(0, []);
    await rssTick(1, []);
    await rssTick(30, [{ code: "SAFE23", guid: "synthetic-safe-item" }]);
    await rssTick(31, [{ code: "SAFE23", guid: "synthetic-safe-item" }]);
    await rssTick(32, [{ code: "SAFE23", guid: "synthetic-safe-item" }]);
    const malformed = async () =>
      new Response("<!DOCTYPE rss><rss />", {
        headers: { "content-type": "application/rss+xml" },
      });
    await rssTick(60, [], malformed);
    expect((await giftCode("SAFE23"))?.status).toBe("active");
    expect(await count("operations")).toBe(1);
    expect((await state())?.pending_snapshot_json).toBeNull();
  });

  it("preserves an active RSS sighting when the JSON source withdraws the same code", async () => {
    await rssTick(0, []);
    await rssTick(1, []);
    await jsonTick(0, []);
    await jsonTick(1, []);
    const code = "RSSFIRST23";
    const item = [{ code, guid: "synthetic-rss-first" }];
    await rssTick(30, item);
    await rssTick(31, item);
    await rssTick(32, item);
    await jsonTick(30, [{ code, status: "active" }]);
    await jsonTick(31, [{ code, status: "active" }]);
    await jsonTick(32, [{ code, status: "active" }]);
    await jsonTick(60, [{ code, status: "expired" }]);
    await jsonTick(61, [{ code, status: "expired" }]);
    await jsonTick(62, [{ code, status: "expired" }]);
    expect((await giftCode(code))?.status).toBe("active");
    expect((await rssCode(code))?.source_active).toBe(1);
    expect(await count("operations")).toBe(1);
  });

  it("reactivates a JSON-first code when the RSS baseline records it without replaying distribution", async () => {
    const code = "JSONFIRST23";
    await jsonTick(0, []);
    await jsonTick(1, []);
    await jsonTick(30, [{ code, status: "active" }]);
    await jsonTick(31, [{ code, status: "active" }]);
    await jsonTick(32, [{ code, status: "active" }]);
    expect(await count("operations")).toBe(1);
    await jsonTick(60, [{ code, status: "expired" }]);
    await jsonTick(61, [{ code, status: "expired" }]);
    await jsonTick(62, [{ code, status: "expired" }]);
    expect((await giftCode(code))?.status).toBe("disabled");

    const item = [{ code, guid: "synthetic-json-first" }];
    await rssTick(60, item);
    await rssTick(61, item);
    await rssTick(62, item);
    await rssTick(63, item);
    expect((await giftCode(code))?.status).toBe("active");
    expect((await rssCode(code))?.baseline).toBe(1);
    expect(await count("operations")).toBe(1);
  });
});

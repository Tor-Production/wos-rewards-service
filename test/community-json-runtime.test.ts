import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { runCommunityJsonSource } from "../src/discovery/community-json-runtime";

const now = new Date("2026-09-22T00:00:00.000Z");
const config = () => loadConfig({ ...env, COMMUNITY_JSON_SOURCE_ENABLED: true } as unknown as Env);
const feed = (codes: string[]) => ({
  maintainedBy: "synthetic",
  source: "synthetic",
  updatedAt: "2026-09-22T00:00:00Z",
  codes: codes.map((code) => ({ code, status: "active", firstSeenAt: "2026-09-22T00:00:00Z" })),
});
const response = (codes: string[]) => async () =>
  new Response(JSON.stringify(feed(codes)), { headers: { etag: '"synthetic"' } });

beforeEach(async () => {
  for (const table of [
    "community_json_code_observations",
    "community_json_source_state",
    "operation_players_snapshot",
    "operations",
    "gift_codes",
  ])
    await env.STAGING_DB.prepare(`DELETE FROM ${table}`).run();
});

describe("disabled community JSON scheduled path", () => {
  it("records a first baseline only, then accepts one new code and preserves withdrawal history", async () => {
    await runCommunityJsonSource(env.STAGING_DB, config(), now, response(["Baseline23"]));
    expect(await env.STAGING_DB.prepare("SELECT COUNT(*) n FROM gift_codes").first("n")).toBe(0);
    await runCommunityJsonSource(
      env.STAGING_DB,
      config(),
      new Date(now.getTime() + 1_800_000),
      response(["Baseline23", "New23"]),
    );
    expect(
      await env.STAGING_DB.prepare("SELECT source FROM gift_codes WHERE code='New23'").first(
        "source",
      ),
    ).toBe("synthetic-local");
    await runCommunityJsonSource(
      env.STAGING_DB,
      config(),
      new Date(now.getTime() + 3_600_000),
      response(["Baseline23"]),
    );
    expect(
      await env.STAGING_DB.prepare(
        "SELECT source_active FROM community_json_code_observations WHERE code='New23'",
      ).first("source_active"),
    ).toBe(0);
  });
});

import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";
import { MANUAL_CODE_MAX_BODY_BYTES } from "../src/limits";
import type { ManualCodeCommandEvent } from "../src/manual-code/types";
import { openDistribution } from "../src/operations/distribution";
import { seedPlayer, testConfig, uniqueId } from "./support/fixtures";

function command(overrides: Partial<ManualCodeCommandEvent> = {}): ManualCodeCommandEvent {
  return {
    event_id: uniqueId(),
    guild_id: env.DISCORD_GUILD_ID,
    channel_id: env.DISCORD_MVP_ADMIN_CHANNEL_ID,
    author_id: uniqueId(),
    author_is_bot: false,
    author_is_system: false,
    webhook_id: null,
    application_id: null,
    code: `MVP_${uniqueId()}`,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function request(body: unknown, secret = env.INGESTION_SHARED_SECRET): Request {
  return new Request("https://synthetic.invalid/manual-code", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
}

function runtimeEnv(adminId: string, db = env.STAGING_DB): Env {
  return {
    ...env,
    STAGING_DB: db,
    DISCORD_MVP_ADMIN_USER_ALLOWLIST: adminId,
  } as unknown as Env;
}

async function send(body: unknown, adminId: string, db = env.STAGING_DB): Promise<Response> {
  return worker.fetch(request(body), runtimeEnv(adminId, db), createExecutionContext());
}

describe("authenticated staging manual-code endpoint", () => {
  it("rejects missing or wrong bearer credentials generically", async () => {
    const event = command();
    for (const authorization of [null, "Bearer wrong-test-value"]) {
      const incoming = request(event);
      if (authorization === null) incoming.headers.delete("authorization");
      else incoming.headers.set("authorization", authorization);
      const response = await worker.fetch(
        incoming,
        runtimeEnv(event.author_id),
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ status: "unauthorized" });
    }
    expect(
      await env.STAGING_DB.prepare("SELECT 1 FROM manual_code_commands WHERE event_id=?1")
        .bind(event.event_id)
        .first(),
    ).toBeNull();
  });

  it("ignores malformed, stale, wrong-scope, and non-human commands", async () => {
    const base = command();
    const cases: unknown[] = [
      { ...base, extra: true },
      { ...base, code: "contains spaces" },
      { ...base, code: "A".repeat(65) },
      { ...base, created_at: new Date(Date.now() - 6 * 60_000).toISOString() },
      { ...base, created_at: new Date(Date.now() + 2 * 60_000).toISOString() },
      { ...base, event_id: "not-a-snowflake" },
      { ...base, author_is_bot: "false" },
      { ...base, guild_id: uniqueId() },
      { ...base, channel_id: env.DISCORD_REGISTRATION_CHANNEL_ID },
      { ...base, author_is_bot: true },
      { ...base, author_is_system: true },
      { ...base, webhook_id: uniqueId() },
      { ...base, application_id: env.DISCORD_APPLICATION_ID },
    ];
    for (const candidate of cases) {
      const response = await send(candidate, base.author_id);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "ignored" });
    }
  });

  it("bounds and validates the request media before parsing", async () => {
    const event = command();
    const wrongMedia = request(event);
    wrongMedia.headers.set("content-type", "text/plain");
    const declaredOversize = request(event);
    declaredOversize.headers.set("content-length", String(MANUAL_CODE_MAX_BODY_BYTES + 1));
    const streamedOversize = new Request("https://synthetic.invalid/manual-code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.INGESTION_SHARED_SECRET}`,
      },
      body: JSON.stringify({ padding: "x".repeat(MANUAL_CODE_MAX_BODY_BYTES) }),
    });
    for (const incoming of [wrongMedia, declaredOversize, streamedOversize]) {
      const response = await worker.fetch(
        incoming,
        runtimeEnv(event.author_id),
        createExecutionContext(),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "ignored" });
    }
  });

  it("authorizes the configured human administrator and atomically opens one distribution", async () => {
    const event = command();
    const playerId = uniqueId();
    await seedPlayer(env.STAGING_DB, playerId, "7", "MVP Player", new Date());
    const response = await send(event, event.author_id);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    const marker = await env.STAGING_DB.prepare(
      "SELECT status,operation_id,code FROM manual_code_commands WHERE event_id=?1",
    )
      .bind(event.event_id)
      .first<{ status: string; operation_id: string; code: string }>();
    expect(marker).toMatchObject({ status: "accepted", code: event.code });
    expect(marker?.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await env.STAGING_DB.prepare(
        "SELECT trigger_kind,trigger_ref,expected_count FROM operations WHERE operation_id=?1",
      )
        .bind(marker!.operation_id)
        .first(),
    ).toEqual({ trigger_kind: "discord_event", trigger_ref: event.code, expected_count: 1 });
    expect(
      await env.STAGING_DB.prepare(
        "SELECT player_id,display_name FROM operation_players_snapshot WHERE operation_id=?1",
      )
        .bind(marker!.operation_id)
        .first(),
    ).toEqual({ player_id: playerId, display_name: "MVP Player" });
  });

  it("durably absorbs the same message and a later message for the same normalized code", async () => {
    const first = command();
    expect(await (await send(first, first.author_id)).json()).toEqual({ status: "accepted" });
    expect(await (await send(first, first.author_id)).json()).toEqual({ status: "duplicate" });
    const second = command({ author_id: first.author_id, code: first.code });
    expect(await (await send(second, first.author_id)).json()).toEqual({ status: "duplicate" });
    expect(
      (
        await env.STAGING_DB.prepare(
          "SELECT event_id,status FROM manual_code_commands WHERE event_id IN (?1,?2) ORDER BY event_id",
        )
          .bind(first.event_id, second.event_id)
          .all()
      ).results,
    ).toEqual(
      expect.arrayContaining([
        { event_id: first.event_id, status: "accepted" },
        { event_id: second.event_id, status: "duplicate_code" },
      ]),
    );
    expect(
      await env.STAGING_DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE trigger_ref=?1")
        .bind(first.code)
        .first("n"),
    ).toBe(1);
  });

  it("cannot classify two different events for one code as accepted at the same millisecond", async () => {
    const now = new Date("2026-09-13T12:00:00.000Z");
    const first = command({ created_at: now.toISOString() });
    const second = command({
      author_id: first.author_id,
      code: first.code,
      created_at: now.toISOString(),
    });
    expect(await openDistribution(env.STAGING_DB, testConfig(), first.code, now, first)).toEqual({
      kind: "accepted",
      operationId: expect.any(String),
    });
    expect(await openDistribution(env.STAGING_DB, testConfig(), second.code, now, second)).toEqual({
      kind: "duplicate_code",
    });
    expect(
      await env.STAGING_DB.prepare("SELECT status FROM manual_code_commands WHERE event_id=?1")
        .bind(second.event_id)
        .first("status"),
    ).toBe("duplicate_code");
  });

  it("rejects a human outside the allowlist and reports storage failure as unavailable", async () => {
    const event = command();
    const denied = await send(event, uniqueId());
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ status: "unauthorized" });
    const broken = new Proxy(env.STAGING_DB, {
      get(target, property) {
        if (property === "batch") return async () => Promise.reject(new Error("synthetic"));
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const unavailable = await send(
      command({ author_id: event.author_id }),
      event.author_id,
      broken,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "unavailable" });
  });
});

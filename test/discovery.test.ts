import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { loadConfig } from "../src/config";
import { isFollowCodeEvent, parseFollowContent } from "../shared/discord-follow";
import {
  content,
  discoveryEnv,
  discoveryRequest,
  discoveryVars,
  followEvent,
  sendDiscovery,
} from "./support/discovery";

const config = () => loadConfig(discoveryEnv()).followSource;

describe("Follow content contract", () => {
  it("preserves case, LF/CRLF and year-unknown leap day without inferring an expiry", () => {
    for (const text of [
      content("aB_9-Z", "February 29, 00:01 (UTC+0)"),
      content("aB_9-Z", "February 29, 00:01 (UTC+0)")
        .replaceAll("\n", "\r\n")
        .split("\r\n")
        .map((line) => ` \t${line}\t `)
        .join("\r\n"),
    ])
      expect(parseFollowContent(text)).toEqual({
        code: "aB_9-Z",
        expiryLabel: "February 29, 00:01 (UTC+0)",
        expiryYear: null,
      });
    expect(parseFollowContent(content("A".repeat(64)))).not.toBeNull();
  });
  it.each([
    "February 30, 23:59 (UTC+0)",
    "April 31, 23:59 (UTC+0)",
    "September 00, 23:59 (UTC+0)",
    "September 20, 24:00 (UTC+0)",
    "September 20, 23:60 (UTC+0)",
    "September 20, 23:59 (UTC+1)",
    "September 20 2026, 23:59 (UTC+0)",
    "Sept 20, 23:59 (UTC+0)",
  ])("rejects invalid calendar/time/year/timezone: %s", (expiry) => {
    expect(parseFollowContent(content("Test18", expiry))).toBeNull();
  });
  it.each([
    "https://wos-giftcode.centurygame.com.evil.invalid/",
    "http://wos-giftcode.centurygame.com/",
    "https://wos-giftcode.centurygame.com/@evil",
    "https://evil@wos-giftcode.centurygame.com/",
    "https://wos-giftcode.centurygame.com/?x=1",
    "<https://wos-giftcode.centurygame.com/>",
  ])("rejects misleading URLs: %s", (url) => {
    expect(
      parseFollowContent(content().replace("https://wos-giftcode.centurygame.com/", url)),
    ).toBeNull();
  });
  it("rejects extra lines, multiple codes, controls, empty/unavailable and byte-oversized content", () => {
    for (const value of [
      "",
      content() + "\n",
      content() + "\n📌 Code: Second",
      content("A B"),
      content("A".repeat(65)),
      content().replaceAll("\n", "\r"),
      content().replace("Code:", "Code:\u200b"),
      "😀".repeat(129),
    ])
      expect(parseFollowContent(value)).toBeNull();
  });
  it.each(["\r", "\u2028", "\u2029"])(
    "rejects a trailing non-contract line separator (%#)",
    (separator) => {
      for (let index = 0; index < 3; index++) {
        const lines = content().split("\n");
        lines[index] += separator + " ";
        expect(parseFollowContent(lines.join("\n"))).toBeNull();
      }
    },
  );
  it("enforces exact freshness boundaries independent of the expiry label/year", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    for (const [offset, valid] of [
      [-300001, false],
      [-300000, true],
      [60000, true],
      [60001, false],
    ] as const)
      expect(
        isFollowCodeEvent(
          followEvent({ created_at: new Date(now.getTime() + offset).toISOString() }),
          config(),
          now,
        ),
      ).toBe(valid);
    expect(
      isFollowCodeEvent(followEvent({ created_at: "2026-02-30T00:00:00Z" }), config(), now),
    ).toBe(false);
  });
});

describe("Follow independent Worker gate and bounded HTTP", () => {
  it("defaults disabled and requires a complete staging/mock source configuration", () => {
    expect(loadConfig(env).followSource).toBeNull();
    expect(loadConfig({ ...env, CODE_DISCOVERY_ENABLED: undefined }).followSource).toBeNull();
    expect(loadConfig(discoveryEnv()).codeDiscoveryEnabled).toBe(true);
    for (const key of Object.keys(discoveryVars).filter((key) => key !== "CODE_DISCOVERY_ENABLED"))
      for (const value of [undefined, "", "0", "not-an-id", "100000000000000006\n"])
        expect(() => loadConfig(discoveryEnv({ [key]: value }))).toThrow();
    for (const extra of [
      { ENVIRONMENT: "production" },
      { PROVIDER_MODE: "real" },
      { PRODUCTION_REDEMPTION_ENABLED: true },
      { DISCORD_CODE_FEED_CHANNEL_ID: env.DISCORD_REGISTRATION_CHANNEL_ID },
      { DISCORD_CODE_FEED_CHANNEL_ID: env.DISCORD_MVP_ADMIN_CHANNEL_ID },
      { CODE_DISCOVERY_ENABLED: "yes" },
    ])
      expect(() => loadConfig(discoveryEnv(extra))).toThrow();
  });
  it("authenticates before reading body or writing, and stays inert when disabled", async () => {
    const event = followEvent();
    for (const auth of [null, "Bearer incorrect"]) {
      const req = discoveryRequest(event);
      if (auth === null) req.headers.delete("authorization");
      else req.headers.set("authorization", auth);
      expect((await worker.fetch(req, discoveryEnv(), createExecutionContext())).status).toBe(401);
    }
    expect(await (await sendDiscovery(event, env)).json()).toEqual({ status: "ignored" });
    expect(
      await env.STAGING_DB.prepare("SELECT COUNT(*) n FROM discovered_code_events").first("n"),
    ).toBe(0);
  });
  it.each([
    { guild_id: "200000000000000001" },
    { channel_id: "200000000000000001" },
    { webhook_id: "200000000000000001" },
    { source_guild_id: "200000000000000001" },
    { source_channel_id: "200000000000000001" },
    { source_message_id: "" },
    { event_id: "0" },
    { webhook_id: null },
    { source_guild_id: null },
    { source_channel_id: null },
    { source_message_id: null },
    { message_type: 19 },
    { message_type: 12 },
    { reference_type: 1 },
    { reference_type: null },
    { flags: 0 },
    { flags: 1 },
    { flags: 10 },
    { flags: 16386 },
    { flags: 4294967298 },
    { flags: "2" },
    { flags: -2 },
    { content: "" },
    { content: "TestCode18A" },
    { code: "untrusted" },
    { expiryYear: 2026 },
    { created_at: "invalid" },
  ])("rejects untrusted envelope/schema before writes (%#)", async (change) => {
    expect(await (await sendDiscovery({ ...followEvent(), ...change })).json()).toEqual({
      status: "ignored",
    });
    expect(
      await env.STAGING_DB.prepare("SELECT COUNT(*) n FROM discovered_code_events").first("n"),
    ).toBe(0);
  });
  it("rejects stale/future events, missing fields and invalid byte streams without writes", async () => {
    const base = followEvent();
    const missing = { ...base } as Record<string, unknown>;
    delete missing.flags;
    for (const value of [
      missing,
      { ...base, created_at: new Date(Date.now() - 360000).toISOString() },
      { ...base, created_at: new Date(Date.now() + 120000).toISOString() },
      { ...base, content: "😀".repeat(600) },
    ])
      expect(await (await sendDiscovery(value)).json()).toEqual({ status: "ignored" });
    const reqs = [discoveryRequest(base), discoveryRequest(base), discoveryRequest(base)];
    reqs[0]!.headers.set("content-type", "text/plain");
    reqs[1]!.headers.set("content-length", "2049");
    reqs[2]!.headers.set("content-length", "wrong");
    reqs.push(
      new Request("https://synthetic.invalid/discovered-code", {
        method: "POST",
        headers: discoveryRequest(base).headers,
        body: new Uint8Array([255]),
      }),
    );
    for (const req of reqs)
      expect(
        await (await worker.fetch(req, discoveryEnv(), createExecutionContext())).json(),
      ).toEqual({ status: "ignored" });
    expect(
      await env.STAGING_DB.prepare("SELECT COUNT(*) n FROM discovered_code_events").first("n"),
    ).toBe(0);
  });
});

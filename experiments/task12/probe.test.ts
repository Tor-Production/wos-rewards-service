import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  consumeMarker,
  assertReplayAuthorization,
  DEADLINE_MS,
  ENDPOINT,
  ExperimentalWhiteoutProvider,
  REFERENCE,
  REPLAY_REFERENCE,
  type Authorization,
  type Dependencies,
  type WireRequest,
} from "./probe.js";

const https = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: https.request }));
import { onePost } from "./transport.js";

const now = Date.parse("2026-09-18T10:00:00Z");
const digest = "a".repeat(64);
const authorization: Authorization = {
  reference: REFERENCE,
  playerId: "123456789",
  state: "123",
  code: "SYNTHETIC",
  consent: true,
  unredeemed: true,
  reserved: true,
  startsAt: new Date(now - 1000).toISOString(),
  cutoff: new Date(now + 60_000).toISOString(),
  expiry: "unknown",
  harnessDigest: digest,
  checksPassed: true,
};
const dirs: string[] = [];
function fixture(response: unknown = { code: 0, msg: "SUCCESS", err_code: 20000 }, status = 200) {
  const dir = mkdtempSync(join(tmpdir(), "task12-offline-"));
  dirs.push(dir);
  const marker = join(dir, "attempt.json");
  const transport = vi.fn(async (_: WireRequest) => ({ status, body: response }));
  const sign = vi.fn(() => "b".repeat(32));
  const deps: Dependencies = {
    now: () => now,
    enabled: () => true,
    consume: (at) => consumeMarker(marker, at),
    sign,
    transport,
  };
  const provider = (a = authorization, live = true) =>
    new ExperimentalWhiteoutProvider(a, digest, deps, live);
  return { marker, transport, sign, deps, provider };
}
function redeem(p: ExperimentalWhiteoutProvider) {
  return p.redeem(
    { playerId: authorization.playerId, state: authorization.state },
    authorization.code,
    REFERENCE,
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

describe("offline containment", () => {
  it("pins endpoint, fields, seconds, signature input and audit-only id", async () => {
    vi.stubGlobal("fetch", () => {
      throw Error("network forbidden");
    });
    const f = fixture();
    const p = f.provider();
    expect(await redeem(p)).toEqual({ outcome: "success" });
    expect(f.sign).toHaveBeenCalledWith("cdk=SYNTHETIC&fid=123456789&kid=123&time=1789725600");
    const request = f.transport.mock.calls[0]![0];
    expect(request).toMatchObject({ url: ENDPOINT, method: "POST", redirect: "error" });
    expect([...new URLSearchParams(request.body).keys()]).toEqual([
      "sign",
      "fid",
      "cdk",
      "kid",
      "time",
    ]);
    expect(JSON.stringify(p.observation)).not.toMatch(/SYNTHETIC|123456789|bbbbbbbb/);
    await expect(redeem(p)).rejects.toThrow("guard_rejected");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("default execution is offline", async () => {
    const f = fixture();
    await expect(redeem(f.provider(authorization, false))).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([
    { playerId: "" },
    { state: "" },
    { code: "" },
    { consent: false },
    { unredeemed: false },
    { reserved: false },
    { checksPassed: false },
    { harnessDigest: "wrong" },
    { cutoff: "invalid" },
    { cutoff: new Date(now - 1).toISOString() },
    { startsAt: new Date(now + 1).toISOString() },
    { expiry: new Date(now + 1000).toISOString() },
  ])("rejects missing/invalid authorization %j before transport", async (change) => {
    const f = fixture();
    await expect(
      redeem(f.provider({ ...authorization, ...change } as Authorization)),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each(["player", "state", "code", "audit"])("rejects wrong %s", async (field) => {
    const f = fixture();
    await expect(
      f.provider().redeem(
        {
          playerId: field === "player" ? "999" : authorization.playerId,
          state: field === "state" ? "999" : authorization.state,
        },
        field === "code" ? "OTHER" : authorization.code,
        field === "audit" ? "other" : REFERENCE,
      ),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("atomic marker blocks concurrent objects and process-restart equivalents", async () => {
    const f = fixture();
    const results = await Promise.allSettled([redeem(f.provider()), redeem(f.provider())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(f.transport).toHaveBeenCalledTimes(1);
    await expect(redeem(f.provider())).rejects.toThrow("attempt_unavailable");
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(f.marker, "utf8"))).toMatchObject({ budgetConsumed: true });
  });
  it("even an empty pre-existing marker blocks dispatch", async () => {
    const f = fixture();
    writeFileSync(f.marker, "");
    await expect(redeem(f.provider())).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("rechecks cutoff and disable immediately after durable claim", async () => {
    const f = fixture();
    f.deps.consume = (at) => {
      consumeMarker(f.marker, at);
      f.deps.now = () => now + 60_001;
    };
    await expect(redeem(f.provider())).rejects.toThrow("window_or_disable_after_claim");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("lost response never retries and retains marker without raw error", async () => {
    const f = fixture();
    f.transport.mockRejectedValue(Error("private payload"));
    const p = f.provider();
    await expect(redeem(p)).rejects.toThrow("transport_unresolved");
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.marker, "utf8")).toContain("budgetConsumed");
    expect(JSON.stringify(p.observation)).not.toContain("private");
  });
  it("30-second timeout aborts once and remains unresolved", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.transport.mockImplementation(() => new Promise(() => {}));
    const p = f.provider();
    const pending = expect(redeem(p)).rejects.toThrow("timeout_unresolved");
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await pending;
    expect(f.transport.mock.calls[0]![0].signal.aborted).toBe(true);
    expect(f.transport).toHaveBeenCalledTimes(1);
    await expect(redeem(f.provider())).rejects.toThrow("attempt_unavailable");
  });
  it.each([
    ["RECEIVED", 40008, "already_redeemed"],
    ["TIME ERROR.", 40007, "permanent"],
    ["CDK NOT FOUND.", 40014, "permanent"],
    ["SAME TYPE EXCHANGE", 40011, "same_type_unresolved"],
    ["USER INFO ERROR", 40020, "state_rejected"],
    ["TOO FREQUENT", 40019, "rate_limit"],
    ["SIGN ERROR", 40002, "auth_failed"],
    ["captcha required", 99, "challenge"],
    ["secret account text", 123, "unknown_response"],
  ])("stops on %s without replay", async (msg, err, expected) => {
    const f = fixture({
      code: 1,
      msg,
      err_code: err,
      data: { private: "account" },
      cookie: "private",
    });
    const p = f.provider();
    if (expected === "already_redeemed" || expected === "permanent")
      expect((await redeem(p)).outcome).toBe(expected);
    else await expect(redeem(p)).rejects.toThrow(expected);
    expect(p.observation.stopReason).toBe(expected);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(p.observation)).not.toMatch(/private|cookie|secret account/);
  });
  describe.each([{}, null])("HTTP failure with body %j", (body) => {
    it.each([
      [302, "redirect"],
      [429, "rate_limit"],
      [401, "auth_or_challenge"],
      [403, "auth_or_challenge"],
      [500, "http_unresolved"],
    ] as const)("preserves HTTP %s as %s", async (status, reason) => {
      const f = fixture(body, status);
      const p = f.provider();
      await expect(redeem(p)).rejects.toThrow(reason);
      expect(p.observation).toMatchObject({ httpStatus: status, stopReason: reason });
      expect(f.transport).toHaveBeenCalledTimes(1);
    });
  });
  it("unexpected schema stops", async () => {
    const f = fixture(null);
    await expect(redeem(f.provider())).rejects.toThrow("unexpected_schema");
  });
});

describe("separately authorized duplicate check", () => {
  const replayAuthorization: Authorization = {
    ...authorization,
    reference: REPLAY_REFERENCE,
    unredeemed: false,
    alreadyAppliedConfirmed: true,
  };
  it.each([
    { playerId: "999" },
    { state: "999" },
    { code: "OTHER" },
    { unredeemed: true },
    { alreadyAppliedConfirmed: undefined },
    { reference: REFERENCE },
  ])("rejects wrong replay scope %j", (change) => {
    expect(() =>
      assertReplayAuthorization(
        { ...replayAuthorization, ...change } as Authorization,
        authorization,
        true,
        true,
      ),
    ).toThrow("replay_authorization_rejected");
  });
  it.each([
    [false, true],
    [true, false],
  ])("requires preserved original consumption and disablement %j", (consumed, disabled) => {
    expect(() =>
      assertReplayAuthorization(replayAuthorization, authorization, consumed, disabled),
    ).toThrow("replay_authorization_rejected");
  });
  it("does not let replay authorization unlock the original provider", async () => {
    const f = fixture();
    await expect(redeem(f.provider(replayAuthorization))).rejects.toThrow("guard_rejected");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("uses one new durable budget and leaves the consumed original unchanged", async () => {
    const f = fixture({ code: 1, msg: "RECEIVED.", err_code: 40008 });
    consumeMarker(f.marker, new Date(now).toISOString());
    const originalBytes = readFileSync(f.marker, "utf8");
    const replayMarker = f.marker + ".replay";
    f.deps.consume = (at) => consumeMarker(replayMarker, at, REPLAY_REFERENCE);
    assertReplayAuthorization(replayAuthorization, authorization, true, true);
    const make = () =>
      new ExperimentalWhiteoutProvider(replayAuthorization, digest, f.deps, true, REPLAY_REFERENCE);
    const invoke = (p: ExperimentalWhiteoutProvider) =>
      p.redeem(
        { playerId: authorization.playerId, state: authorization.state },
        authorization.code,
        REPLAY_REFERENCE,
      );
    const p = make();
    const results = await Promise.allSettled([invoke(p), invoke(make())]);
    expect(results.filter((r) => r.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: { outcome: "already_redeemed" } },
    ]);
    await expect(invoke(make())).rejects.toThrow("attempt_unavailable");
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(p.observation.reference).toBe(REPLAY_REFERENCE);
    expect(JSON.parse(readFileSync(replayMarker, "utf8"))).toMatchObject({
      reference: REPLAY_REFERENCE,
      budgetConsumed: true,
    });
    expect(readFileSync(f.marker, "utf8")).toBe(originalBytes);
  });
});

describe("native transport with synthetic socket", () => {
  it("preserves a non-JSON 403 without retaining its body or retrying", async () => {
    https.request.mockReset();
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = 403;
    https.request.mockImplementation((_url, options, cb) => {
      expect(options.headers).toEqual({
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": expect.any(Number),
        Accept: "application/json, text/plain, */*",
        Origin: "https://wos-giftcode.centurygame.com",
        Referer: "https://wos-giftcode.centurygame.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      });
      req.end = () => {
        cb(res);
        res.emit("data", Buffer.from("<html>private server response</html>"));
        res.emit("end");
      };
      return req;
    });
    const f = fixture();
    f.deps.transport = onePost;
    const p = f.provider();
    await expect(redeem(p)).rejects.toThrow("auth_or_challenge");
    expect(p.observation).toMatchObject({ httpStatus: 403, response: {} });
    expect(JSON.stringify(p.observation)).not.toContain("private server response");
    expect(https.request).toHaveBeenCalledTimes(1);
  });
  it("rejects alternate endpoint/method/redirect policy without a socket", async () => {
    https.request.mockClear();
    const base = {
      url: ENDPOINT,
      method: "POST",
      redirect: "error",
      body: "synthetic",
      signal: new AbortController().signal,
    };
    for (const change of [
      { url: "https://example.invalid" },
      { method: "GET" },
      { redirect: "follow" },
    ])
      await expect(onePost({ ...base, ...change } as WireRequest)).rejects.toThrow(
        "transport_guard",
      );
    expect(https.request).not.toHaveBeenCalled();
  });
  it("does not follow a redirect or retry a socket error", async () => {
    https.request.mockReset();
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    const res = new EventEmitter() as EventEmitter & { statusCode: number; destroy: () => void };
    res.statusCode = 302;
    res.destroy = vi.fn();
    https.request.mockImplementation((_url, options, cb) => {
      expect(options.agent).toBe(false);
      req.end = () => cb(res);
      return req;
    });
    const input: WireRequest = {
      url: ENDPOINT,
      method: "POST",
      redirect: "error",
      body: "synthetic",
      signal: new AbortController().signal,
    };
    expect(await onePost(input)).toEqual({ status: 302, body: {} });
    expect(https.request).toHaveBeenCalledTimes(1);
    https.request.mockImplementation(() => {
      const r = new EventEmitter() as typeof req;
      r.end = () => r.emit("error", Error("private"));
      return r;
    });
    await expect(onePost(input)).rejects.toThrow("transport_unresolved");
    expect(https.request).toHaveBeenCalledTimes(2);
  });
});

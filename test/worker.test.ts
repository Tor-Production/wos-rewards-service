import { env, exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("worker scaffold (integration, Workers runtime)", () => {
  it("answers an arbitrary path with the generic 404", async () => {
    const response = await exports.default.fetch("http://example.com/anything");

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: "not_found" });
  });

  it("answers a different arbitrary path identically", async () => {
    const first = await exports.default.fetch("http://example.com/some/other/path");
    const second = await exports.default.fetch("http://example.com/yet-another?q=1");

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(await first.text()).toBe(await second.text());
  });

  it("exposes no configuration over HTTP", async () => {
    const response = await exports.default.fetch("http://example.com/anything");
    const body = await response.text();

    // The staging configuration must not be observable from a response.
    for (const leak of ["staging", "mock", "PROVIDER_MODE", "ENVIRONMENT", "LOG_LEVEL"]) {
      expect(body).not.toContain(leak);
    }
    expect(response.headers.get("x-environment")).toBeNull();
  });
});

describe("worker scaffold (unit)", () => {
  it("returns the generic 404 for a request handled directly", async () => {
    const request = new IncomingRequest("http://example.com/anything");
    const ctx = createExecutionContext();

    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: "not_found" });
  });

  it("serves 503 when the environment fails the safety gates", async () => {
    const request = new IncomingRequest("http://example.com/anything");
    const ctx = createExecutionContext();
    const unsafeEnv = { ...env, PRODUCTION_REDEMPTION_ENABLED: true } as unknown as Env;

    const response = await worker.fetch(request, unsafeEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({ error: "invalid_configuration" });
  });
});

import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { verifyIngestionAuth } from "../src/ingest/auth";
import { ingestRequest, makeEvent } from "./support/fixtures";

describe("ingest authentication", () => {
  it.each([
    null,
    "Basic synthetic",
    "Bearer",
    "Bearer ",
    `Bearer ${env.INGESTION_SHARED_SECRET}-wrong`,
    "Bearer a b",
  ])("rejects invalid authorization generically (%#)", async (header) => {
    const request = ingestRequest(makeEvent());
    if (header === null) request.headers.delete("authorization");
    else request.headers.set("authorization", header);
    const response = await worker.fetch(request, env, createExecutionContext());
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"unauthorized"}');
  });
  it("accepts the configured local value, including case-insensitive bearer scheme", async () => {
    const request = ingestRequest(makeEvent());
    expect(await verifyIngestionAuth(request, env.INGESTION_SHARED_SECRET)).toBe(true);
    request.headers.set("authorization", `bearer ${env.INGESTION_SHARED_SECRET}`);
    expect(await verifyIngestionAuth(request, env.INGESTION_SHARED_SECRET)).toBe(true);
  });
  it("fails configuration before routing and never returns supplied values", async () => {
    for (const secret of [undefined, "", " "]) {
      const response = await worker.fetch(
        ingestRequest(makeEvent()),
        { ...env, INGESTION_SHARED_SECRET: secret } as unknown as Env,
        createExecutionContext(),
      );
      expect(response.status).toBe(503);
      expect(await response.text()).toBe('{"error":"invalid_configuration"}');
    }
  });
});

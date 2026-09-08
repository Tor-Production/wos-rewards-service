import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { INGEST_MAX_BODY_BYTES } from "../src/limits";
import { isRegistrationMessageEvent, readRegistrationEvent } from "../src/ingest/transport";
import { countD1, FIXTURE_NOW, ingestRequest, makeEvent } from "./support/fixtures";

describe("transport gates", () => {
  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD"])(
    "%s /ingest is not a route",
    async (method) => {
      const response = await worker.fetch(
        new Request("https://synthetic.invalid/ingest", { method }),
        env,
        createExecutionContext(),
      );
      expect(response.status).toBe(404);
    },
  );
  it("rejects an unknown POST path", async () => {
    const response = await worker.fetch(
      new Request("https://synthetic.invalid/ingest/", ingestRequest(makeEvent())),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
  });
  it("allows JSON media parameters and rejects other media types before reading", async () => {
    const request = ingestRequest(makeEvent());
    request.headers.set("content-type", "application/json; charset=utf-8");
    expect((await readRegistrationEvent(request, FIXTURE_NOW)).ok).toBe(true);
    const wrong = ingestRequest(makeEvent());
    wrong.headers.set("content-type", "text/plain");
    expect(await readRegistrationEvent(wrong, FIXTURE_NOW)).toEqual({
      ok: false,
      error: "unsupported_media_type",
    });
  });
  it("rejects declared oversized content before the body is consumed", async () => {
    const request = ingestRequest(makeEvent());
    request.headers.set("content-length", String(INGEST_MAX_BODY_BYTES + 1));
    expect(await readRegistrationEvent(request, FIXTURE_NOW)).toEqual({
      ok: false,
      error: "payload_too_large",
    });
    expect(request.bodyUsed).toBe(false);
  });
  it("cancels an oversized stream without Content-Length at the first excessive chunk", async () => {
    const cancel = vi.fn();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(8_192));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const request = new Request("https://synthetic.invalid/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
    });
    expect(await readRegistrationEvent(request, FIXTURE_NOW)).toEqual({
      ok: false,
      error: "payload_too_large",
    });
    expect(reads).toBe(3);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each(["{", "null", "[]", "42", '"text"'])(
    "rejects malformed JSON or wrong top-level shape %s",
    async (body) => {
      const request = new Request("https://synthetic.invalid/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(await readRegistrationEvent(request, FIXTURE_NOW)).toEqual({
        ok: false,
        error: "invalid_request",
      });
    },
  );
  it("accepts exactly the byte cap and rejects one extra byte", async () => {
    const json = JSON.stringify(makeEvent());
    for (const extra of [0, 1]) {
      const body =
        json + " ".repeat(INGEST_MAX_BODY_BYTES - new TextEncoder().encode(json).length + extra);
      const request = new Request("https://synthetic.invalid/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect((await readRegistrationEvent(request, FIXTURE_NOW)).ok).toBe(extra === 0);
    }
  });
  it("rejects every missing field and malformed field without a database statement", async () => {
    const base = makeEvent();
    const malformed: unknown[] = Object.keys(base).map((key) => {
      const event: Record<string, unknown> = { ...base };
      delete event[key];
      return event;
    });
    for (const field of [
      "event_id",
      "guild_id",
      "channel_id",
      "author_id",
      "webhook_id",
      "application_id",
    ]) {
      for (const value of [123, "", "x", "1".repeat(21)])
        malformed.push({ ...base, [field]: value });
    }
    malformed.push(
      { ...base, extra: 1 },
      { ...base, author_is_bot: 1 },
      { ...base, author_is_system: "false" },
      { ...base, content: null },
      { ...base, content: "😀".repeat(4_097) },
      { ...base, created_at: "2026-02-31T00:00:00Z" },
    );
    const counted = countD1(env.STAGING_DB);
    for (const body of malformed) {
      expect(isRegistrationMessageEvent(body, FIXTURE_NOW)).toBe(false);
      const request = new Request("https://synthetic.invalid/ingest", {
        method: "POST",
        headers: ingestRequest(base).headers,
        body: JSON.stringify(body),
      });
      const response = await worker.fetch(
        request,
        { ...env, STAGING_DB: counted.db },
        createExecutionContext(),
      );
      // The largest multibyte event is rejected at the earlier body-size gate.
      expect([400, 413]).toContain(response.status);
    }
    expect(counted.stats.statements).toBe(0);
    expect(isRegistrationMessageEvent({ ...base, content: "😀".repeat(4_096) }, FIXTURE_NOW)).toBe(
      true,
    );
  });
});

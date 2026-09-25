import { describe, expect, it } from "vitest";
import {
  COMMUNITY_JSON_ENDPOINT,
  COMMUNITY_JSON_MAX_BODY_BYTES,
  fetchCommunityJson,
  parseCommunityJson,
} from "../src/discovery/community-json";

const feed = (
  codes: unknown[] = [
    { code: "Synthetic_23", status: "active", firstSeenAt: "2026-09-20T00:00:00Z" },
  ],
) => ({
  maintainedBy: "synthetic fixture",
  source: "synthetic fixture",
  updatedAt: "2026-09-21T00:00:00Z",
  codes,
});

describe("community JSON source", () => {
  it("accepts only active, bounded, UTC schema candidates", () => {
    expect(parseCommunityJson(feed())).toEqual([
      {
        code: "Synthetic_23",
        sourceStatus: "active",
        sourceUpdatedAt: "2026-09-21T00:00:00Z",
        sourceFirstSeenAt: "2026-09-20T00:00:00Z",
      },
    ]);
    expect(
      parseCommunityJson(
        feed([{ code: "bad space", status: "active", firstSeenAt: "2026-09-20T00:00:00Z" }]),
      ),
    ).toBeNull();
    expect(
      parseCommunityJson(
        feed([{ code: "Synthetic_23", status: "expired", firstSeenAt: "2026-09-20T00:00:00Z" }]),
      ),
    ).toMatchObject([{ sourceStatus: "expired" }]);
    expect(parseCommunityJson({ ...feed(), extra: true })).toBeNull();
  });

  it("uses the exact endpoint, conditional ETag and bounded error behavior", async () => {
    let url = "";
    let etag: string | null = null;
    const result = await fetchCommunityJson(
      { endpoint: COMMUNITY_JSON_ENDPOINT, timeoutMs: 1_000, minPollSeconds: 1800 },
      '"old"',
      async (input, init) => {
        url = input.toString();
        etag = new Headers(init?.headers).get("if-none-match");
        return { status: 304 } as Response;
      },
    );
    expect(result).toEqual({ kind: "not_modified" });
    expect(url).toBe(COMMUNITY_JSON_ENDPOINT);
    expect(etag).toBe('"old"');
    expect(
      await fetchCommunityJson(
        { endpoint: COMMUNITY_JSON_ENDPOINT, timeoutMs: 10, minPollSeconds: 1800 },
        null,
        async () => new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      ),
    ).toEqual({ kind: "rate_limited", retryAfterSeconds: 30 });
    expect(
      await fetchCommunityJson(
        { endpoint: COMMUNITY_JSON_ENDPOINT, timeoutMs: 10, minPollSeconds: 1800 },
        null,
        async () =>
          new Response("x".repeat(COMMUNITY_JSON_MAX_BODY_BYTES + 1), {
            headers: { "content-length": String(COMMUNITY_JSON_MAX_BODY_BYTES + 1) },
          }),
      ),
    ).toEqual({ kind: "invalid_payload", reason: "content_length_oversize" });
  });

  it("uses native Worker fetch and never follows a redirect", async () => {
    const config = {
      endpoint: COMMUNITY_JSON_ENDPOINT,
      timeoutMs: 1_000,
      minPollSeconds: 1800,
    } as const;
    await fetch("https://task24-fixture.invalid/reset");

    const result = await fetchCommunityJson(config, '"native-ok"');
    expect(result).toMatchObject({
      kind: "ok",
      candidates: [{ code: "Synthetic_23", sourceStatus: "active" }],
    });

    expect(await fetchCommunityJson(config, '"native-redirect"')).toEqual({
      kind: "transient_failure",
      reason: "http_other",
    });
    const metrics = await fetch("https://task24-fixture.invalid/metrics");
    expect(await metrics.text()).toBe("0");
  });

  it("cancels a lengthless oversized stream before consuming the whole response", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(4_096));
        if (pulls === 8) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await fetchCommunityJson(
      { endpoint: COMMUNITY_JSON_ENDPOINT, timeoutMs: 1_000, minPollSeconds: 1800 },
      null,
      async () => new Response(stream),
    );
    expect(result).toEqual({ kind: "invalid_payload", reason: "body_oversize" });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(8);
  });

  it("classifies response, validation, and transport failures without carrying raw data", async () => {
    const config = {
      endpoint: COMMUNITY_JSON_ENDPOINT,
      timeoutMs: 1_000,
      minPollSeconds: 1800,
    } as const;
    const cases = [
      [new Response(null, { status: 503 }), "transient_failure", "http_5xx"],
      [new Response(null, { status: 418 }), "transient_failure", "http_other"],
      [
        new Response("{}", { headers: { "content-length": "invalid" } }),
        "invalid_payload",
        "content_length_invalid",
      ],
      [new Response("not JSON"), "invalid_payload", "json_invalid"],
      [
        new Response(JSON.stringify({ ...feed(), extra: "private-canary" })),
        "invalid_payload",
        "schema_invalid",
      ],
    ] as const;
    for (const [response, kind, reason] of cases)
      expect(await fetchCommunityJson(config, null, async () => response)).toEqual({
        kind,
        reason,
      });

    expect(
      await fetchCommunityJson(config, null, async () => {
        throw new Error("private-canary");
      }),
    ).toEqual({ kind: "transient_failure", reason: "transport_error" });
    expect(
      await fetchCommunityJson(
        { ...config, timeoutMs: 5 },
        null,
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("private-canary")), {
              once: true,
            });
          }),
      ),
    ).toEqual({ kind: "transient_failure", reason: "timeout" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("private-canary"));
      },
    });
    expect(await fetchCommunityJson(config, null, async () => new Response(stream))).toEqual({
      kind: "transient_failure",
      reason: "body_read_error",
    });
  });
});

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
      { endpoint: COMMUNITY_JSON_ENDPOINT, timeoutMs: 1_000, minPollSeconds: 900 },
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
        { endpoint: COMMUNITY_JSON_ENDPOINT, timeoutMs: 10, minPollSeconds: 900 },
        null,
        async () => new Response(null, { status: 429, headers: { "retry-after": "30" } }),
      ),
    ).toEqual({ kind: "rate_limited", retryAfterSeconds: 30 });
    expect(
      await fetchCommunityJson(
        { endpoint: COMMUNITY_JSON_ENDPOINT, timeoutMs: 10, minPollSeconds: 900 },
        null,
        async () => new Response("x".repeat(COMMUNITY_JSON_MAX_BODY_BYTES + 1)),
      ),
    ).toEqual({ kind: "invalid_payload" });
  });
});

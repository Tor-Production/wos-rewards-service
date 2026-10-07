import { describe, expect, it } from "vitest";
import { RSS_ENDPOINT, RSS_MAX_BODY_BYTES, fetchRss, parseRssFeed } from "../src/discovery/rss";
import { rssFeed } from "./support/rss";

describe("RSS source contract", () => {
  it("parses only the observed RSS 2.0 item shape and keeps duplicate codes by item", async () => {
    const parsed = await parseRssFeed(
      rssFeed([
        { code: "SYNTH23", guid: "synthetic-item-a" },
        { code: "SYNTH23", guid: "synthetic-item-b", publishedAt: "Wed, 07 Oct 2026 12:00:00 GMT" },
      ]),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]).toMatchObject({
      code: "SYNTH23",
      sourcePublishedAt: "2026-10-06T11:00:00.000Z",
      itemId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(parsed?.[0]?.itemId).not.toBe(parsed?.[1]?.itemId);
    expect(await parseRssFeed(rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a" }]))).toEqual(
      await parseRssFeed(rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a" }])),
    );
  });

  it("deduplicates an identical item but rejects conflicting copies of one GUID", async () => {
    expect(
      await parseRssFeed(
        rssFeed([
          { code: "SYNTH23", guid: "synthetic-item-a" },
          { code: "SYNTH23", guid: "synthetic-item-a" },
        ]),
      ),
    ).toHaveLength(1);
    expect(
      await parseRssFeed(
        rssFeed([
          { code: "SYNTH23", guid: "synthetic-item-a" },
          { code: "OTHER23", guid: "synthetic-item-a" },
        ]),
      ),
    ).toBeNull();
  });

  it.each([
    rssFeed([{ code: "BAD CODE", guid: "synthetic-item-a" }]),
    rssFeed([{ code: "Synthetic code", guid: "synthetic-item-a" }]),
    rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a", publishedAt: "February 30, 2026" }]),
    rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a" }]).replace(
      '<guid isPermaLink="false">synthetic-item-a</guid>',
      '<guid isPermaLink="false"></guid>',
    ),
    rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a" }]).replace(
      "</item>",
      "<description>unobserved field</description></item>",
    ),
    rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a" }]).replace(
      "<channel>",
      '<channel unexpected="attribute">',
    ),
    rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a" }]).replace(
      "<title>Synthetic RSS feed</title>",
      "unobserved text<title>Synthetic RSS feed</title>",
    ),
  ])("rejects payloads outside the strict observed item contract", async (xml) => {
    expect(await parseRssFeed(xml)).toBeNull();
  });

  it("rejects DTDs, external entities, unknown entities and malformed XML", async () => {
    const valid = rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a" }]);
    expect(
      await parseRssFeed(`<!DOCTYPE rss [<!ENTITY x SYSTEM "https://invalid.test/x">]>${valid}`),
    ).toBeNull();
    expect(await parseRssFeed(valid.replace("SYNTH23", "&x;"))).toBeNull();
    expect(await parseRssFeed(valid.replace("SYNTH23", "&notDefined;"))).toBeNull();
    expect(await parseRssFeed(valid.replace("</rss>", ""))).toBeNull();
    expect(await parseRssFeed("x".repeat(RSS_MAX_BODY_BYTES + 1))).toBeNull();
  });

  it("uses one exact unauthenticated GET and does not follow redirects", async () => {
    let calledUrl = "";
    let calledInit: RequestInit | undefined;
    const result = await fetchRss(
      { endpoint: RSS_ENDPOINT, timeoutMs: 1_000, minPollSeconds: 1_800 },
      async (input, init) => {
        calledUrl = input.toString();
        calledInit = init;
        return new Response(rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a" }]), {
          headers: { "content-type": "application/rss+xml; charset=UTF-8" },
        });
      },
    );
    expect(calledUrl).toBe(RSS_ENDPOINT);
    expect(calledInit?.redirect).toBe("manual");
    expect(calledInit?.method).toBe("GET");
    expect(new Headers(calledInit?.headers).has("authorization")).toBe(false);
    expect(result).toMatchObject({ kind: "ok", candidates: [{ code: "SYNTH23" }] });

    let calls = 0;
    const redirect = await fetchRss(
      { endpoint: RSS_ENDPOINT, timeoutMs: 1_000, minPollSeconds: 1_800 },
      async () => {
        calls++;
        return new Response(null, {
          status: 302,
          headers: { location: "https://synthetic.invalid/article" },
        });
      },
    );
    expect(redirect).toMatchObject({ kind: "transient_failure", reason: "http_other" });
    expect(calls).toBe(1);
  });

  it("classifies access, retry and malformed responses without returning raw payloads", async () => {
    const config = { endpoint: RSS_ENDPOINT, timeoutMs: 1_000, minPollSeconds: 1_800 } as const;
    expect(await fetchRss(config, async () => new Response(null, { status: 403 }))).toMatchObject({
      kind: "access_denied",
    });
    expect(
      await fetchRss(
        config,
        async () =>
          new Response(rssFeed([{ code: "SYNTH23", guid: "synthetic-item-a" }]), {
            status: 206,
            headers: { "content-type": "application/rss+xml" },
          }),
      ),
    ).toMatchObject({ kind: "transient_failure", reason: "http_other" });
    expect(
      await fetchRss(
        config,
        async () => new Response(null, { status: 503, headers: { "retry-after": "7200" } }),
        new Date("2026-10-08T00:00:00Z"),
      ),
    ).toMatchObject({ kind: "transient_failure", reason: "http_5xx", retryAfterSeconds: 7_200 });
    expect(
      await fetchRss(
        config,
        async () => new Response(null, { status: 429, headers: { "retry-after": "nonsense" } }),
      ),
    ).toMatchObject({ kind: "rate_limited", retryAfterInvalid: true });
    expect(
      await fetchRss(
        config,
        async () => new Response("<html />", { headers: { "content-type": "text/html" } }),
      ),
    ).toMatchObject({ kind: "invalid_payload", reason: "content_type_invalid" });
    expect(
      await fetchRss(
        config,
        async () => new Response("not xml", { headers: { "content-type": "application/rss+xml" } }),
      ),
    ).toMatchObject({ kind: "invalid_payload", reason: "schema_invalid" });
  });

  it("rejects oversized streams before consuming the whole response", async () => {
    let pulls = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(16 * 1_024));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await fetchRss(
      { endpoint: RSS_ENDPOINT, timeoutMs: 1_000, minPollSeconds: 1_800 },
      async () => new Response(stream, { headers: { "content-type": "application/rss+xml" } }),
    );
    expect(result).toEqual({
      kind: "invalid_payload",
      reason: "body_oversize",
      retryAfterSeconds: null,
      retryAfterInvalid: false,
    });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(5);
  });
});

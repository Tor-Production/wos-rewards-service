import { describe, expect, it, vi } from "vitest";

import { routeMessage } from "../src/message-router.js";
import { forwardToWorker } from "../src/worker-client.js";
import { CONFIG, message } from "./fixtures.js";

describe("bounded companion forwarding", () => {
  it("sends the unchanged registration once and emits no logs", async () => {
    const routed = routeMessage(message({ content: " 123  Name 😀 " }), CONFIG)!;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let observed: Record<string, unknown> = {};
    const status = await forwardToWorker(CONFIG, routed, {
      fetcher: async (request) => {
        observed = {
          url: request.url,
          method: request.method,
          authorization: request.headers.get("authorization")?.replace(/ .+$/, " <redacted>"),
          body: await request.json(),
        };
        return Response.json({ status: "accepted" }, { status: 202 });
      },
    });
    expect(status).toBe("accepted");
    expect(observed).toMatchObject({
      url: `${CONFIG.workerBaseUrl}/ingest`,
      method: "POST",
      authorization: "Bearer <redacted>",
      body: { content: " 123  Name 😀 " },
    });
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    info.mockRestore();
    error.mockRestore();
  });

  it("retries only a bounded number of transient failures", async () => {
    const routed = routeMessage(message(), CONFIG)!;
    const delays: number[] = [];
    let calls = 0;
    const status = await forwardToWorker(CONFIG, routed, {
      fetcher: async () => {
        calls++;
        return calls < 3
          ? Response.json({ status: "unavailable" }, { status: 503 })
          : Response.json({ status: "duplicate" }, { status: 202 });
      },
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });
    expect(status).toBe("duplicate");
    expect(calls).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it("times out each attempt, stops at the configured bound, and returns only a category", async () => {
    const routed = routeMessage(message(), CONFIG)!;
    let calls = 0;
    const status = await forwardToWorker(CONFIG, routed, {
      attempts: 2,
      timeoutMs: 1,
      delay: async () => {},
      fetcher: (request) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("synthetic abort")));
        });
      },
    });
    expect(status).toBe("unavailable");
    expect(calls).toBe(2);
  });

  it("does not retry an authorization failure", async () => {
    const routed = routeMessage(message(), CONFIG)!;
    const fetcher = vi.fn(async () => Response.json({ status: "unauthorized" }, { status: 401 }));
    expect(await forwardToWorker(CONFIG, routed, { fetcher })).toBe("unauthorized");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

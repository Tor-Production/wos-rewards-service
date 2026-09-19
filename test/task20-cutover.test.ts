import { describe, expect, it, vi } from "vitest";

import disabled from "../src/cutover/disabled";

describe("Task 20 cutover version", () => {
  it("closes HTTP ingress before reading a request or touching bindings", async () => {
    const response = await disabled.fetch();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });

  it("retries every unexpected queue delivery without acknowledging it", async () => {
    const first = { retry: vi.fn(), ack: vi.fn() };
    const second = { retry: vi.fn(), ack: vi.fn() };
    await disabled.queue({ messages: [first, second] } as unknown as MessageBatch<unknown>);
    expect(first.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(second.retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 60 });
    expect(first.ack).not.toHaveBeenCalled();
    expect(second.ack).not.toHaveBeenCalled();
  });

  it("performs no scheduled work", async () => {
    await expect(disabled.scheduled()).resolves.toBeUndefined();
  });
});

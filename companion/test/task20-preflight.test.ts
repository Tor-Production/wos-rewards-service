import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";

import { describe, expect, it, vi } from "vitest";

import {
  runPreflightSession,
  type GatewaySocket,
  type PreflightInput,
  type PreflightTransport,
} from "../src/task20-preflight-runner.js";
import { runBoundedPreflight } from "../src/task20-preflight-supervisor.js";
import { matchesSelectedFollowCopy } from "../src/task20-preflight-validation.js";

const source = {
  guildId: "100000000000000001",
  channelId: "100000000000000002",
  webhookId: "100000000000000003",
  sourceGuildId: "100000000000000001",
  sourceChannelId: "100000000000000004",
};
const destination = "100000000000000005";
const original = "100000000000000006";
const copy = {
  id: destination,
  channel_id: source.channelId,
  webhook_id: source.webhookId,
  type: 0,
  flags: 2,
  message_reference: {
    type: 0,
    guild_id: source.sourceGuildId,
    channel_id: source.sourceChannelId,
    message_id: original,
  },
};

describe("Task 20 selected Follow copy preflight", () => {
  it("accepts the one exact selected copy", () => {
    expect(matchesSelectedFollowCopy(copy, source, destination, original)).toBe(true);
  });

  it.each([
    { ...copy, webhook_id: "100000000000000007" },
    { ...copy, channel_id: "100000000000000007" },
    { ...copy, flags: 0 },
    { ...copy, message_reference: { ...copy.message_reference, message_id: "100000000000000007" } },
  ])("rejects a wrong field", (message) => {
    expect(matchesSelectedFollowCopy(message, source, destination, original)).toBe(false);
  });
});

const input: PreflightInput = {
  token: "synthetic-test-token",
  applicationId: "100000000000000008",
  source,
  destinationMessageId: destination,
  sourceMessageId: original,
};

class FakeGateway extends EventEmitter {
  readonly sent: string[] = [];
  readonly terminate = vi.fn(() => {});
  send(payload: string): void {
    this.sent.push(payload);
  }
  dispatch(payload: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(payload)));
  }
}

function session(
  gatewayStatus: number,
  messageStatus: number,
  event: "ready" | "reconnect" | "close" = "ready",
) {
  const gateway = new FakeGateway();
  const connect = vi.fn((_url: string): GatewaySocket => {
    queueMicrotask(() => {
      gateway.dispatch({ op: 10, d: { heartbeat_interval: 41_250 } });
      if (event === "ready")
        gateway.dispatch({ op: 0, t: "READY", d: { application: { id: input.applicationId } } });
      if (event === "reconnect") gateway.dispatch({ op: 7 });
      if (event === "close") gateway.emit("close");
    });
    return gateway as unknown as GatewaySocket;
  });
  const request = vi.fn(async (): Promise<Response> => {
    if (request.mock.calls.length === 1)
      return new Response(JSON.stringify({ url: "wss://gateway.discord.gg" }), {
        status: gatewayStatus,
      });
    return new Response(JSON.stringify(copy), { status: messageStatus });
  });
  const transport: PreflightTransport = { request, connect };
  return { gateway, connect, request, transport };
}

describe("Task 20 one-shot runner", () => {
  it("accepts one Gateway attempt and one selected-message read", async () => {
    const mock = session(200, 200);
    expect(await runPreflightSession(input, mock.transport)).toBe(true);
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(mock.connect).toHaveBeenCalledTimes(1);
    expect(mock.gateway.sent).toHaveLength(1);
    expect(mock.gateway.terminate).toHaveBeenCalledOnce();
  });

  it.each([403, 429])("stops on gateway-information HTTP %i without retry", async (status) => {
    const mock = session(status, 200);
    expect(await runPreflightSession(input, mock.transport)).toBe(false);
    expect(mock.request).toHaveBeenCalledTimes(1);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  it.each([403, 429])("stops on selected-message HTTP %i without retry", async (status) => {
    const mock = session(200, status);
    expect(await runPreflightSession(input, mock.transport)).toBe(false);
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(mock.connect).toHaveBeenCalledTimes(1);
    expect(mock.gateway.terminate).toHaveBeenCalledOnce();
  });

  it.each(["reconnect", "close"] as const)("rejects %s without reconnect", async (event) => {
    const mock = session(200, 200, event);
    expect(await runPreflightSession(input, mock.transport)).toBe(false);
    expect(mock.connect).toHaveBeenCalledTimes(1);
    expect(mock.request).toHaveBeenCalledTimes(1);
    expect(mock.gateway.terminate).toHaveBeenCalledOnce();
  });
});

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(async () => 1);
}

describe("Task 20 isolated supervisor", () => {
  it("terminates a real pending worker before its late completion", async () => {
    const worker = new Worker(new URL("./fixtures/task20-late-worker.cjs", import.meta.url));
    const messages: unknown[] = [];
    worker.on("message", (message: unknown) => messages.push(message));
    expect(
      await runBoundedPreflight(worker, 50, 1_000, () => {
        throw new Error("hard stop");
      }),
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages).toEqual([]);
  });

  it("terminates on timeout and ignores a late success", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const run = runBoundedPreflight(worker as unknown as Worker, 20, 10, () => {
        throw new Error("hard stop");
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(await run).toBe(false);
      expect(worker.terminate).toHaveBeenCalledOnce();
      worker.emit("message", "ready");
      expect(worker.listenerCount("message")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report success until worker shutdown finishes", async () => {
    let finishTermination: ((code: number) => void) | undefined;
    const worker = new FakeWorker();
    worker.terminate.mockImplementation(
      () => new Promise<number>((resolve) => (finishTermination = resolve)),
    );
    const run = runBoundedPreflight(worker as unknown as Worker, 1_000, 1_000, () => {
      throw new Error("hard stop");
    });
    let completed = false;
    void run.then(() => (completed = true));
    worker.emit("message", "ready");
    await Promise.resolve();
    expect(completed).toBe(false);
    finishTermination?.(1);
    expect(await run).toBe(true);
    expect(completed).toBe(true);
  });

  it("hard-stops if termination exceeds the cleanup reserve", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      worker.terminate.mockImplementation(() => new Promise<number>(() => {}));
      const hardStop = vi.fn((): never => {
        throw new Error("hard stop");
      });
      const run = runBoundedPreflight(worker as unknown as Worker, 20, 10, hardStop);
      const failure = expect(run).rejects.toThrow("hard stop");
      await vi.advanceTimersByTimeAsync(30);
      await failure;
      expect(hardStop).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

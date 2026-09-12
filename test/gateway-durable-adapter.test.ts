import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GatewayDurableAdapter } from "../src/discord/gateway/durable-adapter";
import type {
  GatewayAdapterClock,
  GatewayAdapterDependencies,
  GatewayAdapterDiagnostic,
  GatewayAdapterDurableEffect,
  GatewayAdapterFaultAction,
  GatewayAdapterStorage,
  GatewayTargetAcceptance,
  GatewayWebSocketCallbacks,
  GatewayWebSocketConnection,
  GatewayWebSocketFactory,
  OpaqueGatewayConnectionTarget,
  OpaqueGatewaySendContext,
} from "../src/discord/gateway/durable-adapter-types";
import type {
  GatewayOutboundEvent,
  GatewaySessionStartLimit,
  GatewayTransportResult,
} from "../src/discord/gateway/types";

const NOW = Date.parse("2026-09-12T12:00:00.000Z");
const LIMIT = {
  total: 1_000,
  remaining: 999,
  reset_after: 86_400_000,
  max_concurrency: 1,
} as const;

class MemoryGatewayStorage implements GatewayAdapterStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;
  alarmSets: number[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value as T);
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledTimeMs: number): Promise<void> {
    this.alarmAt = scheduledTimeMs;
    this.alarmSets.push(scheduledTimeMs);
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  persistedCheckpoint(): number | null {
    const value = this.values.get("gateway-adapter-state") as
      { checkpoint: number | null } | undefined;
    return value?.checkpoint ?? null;
  }

  ignoredEvidenceCount(): number {
    return [...this.values.keys()].filter((key) => key.startsWith("gateway-ignored:")).length;
  }
}

class MutableClock implements GatewayAdapterClock {
  now = NOW;

  monotonicNowMs(): number {
    return this.now;
  }

  wallNowMs(): number {
    return this.now;
  }

  advance(milliseconds: number): void {
    this.now += milliseconds;
  }
}

class FakeGatewaySocket implements GatewayWebSocketConnection {
  readonly callbacks: GatewayWebSocketCallbacks;
  readonly sent: GatewayOutboundEvent[] = [];
  readonly contexts: OpaqueGatewaySendContext[] = [];
  readonly closeCodes: number[] = [];
  readonly results: GatewayTransportResult[] = [];

  constructor(callbacks: GatewayWebSocketCallbacks) {
    this.callbacks = callbacks;
  }

  async send(
    event: GatewayOutboundEvent,
    context: OpaqueGatewaySendContext,
  ): Promise<GatewayTransportResult> {
    this.sent.push(event);
    this.contexts.push(context);
    return this.results.shift() ?? "sent";
  }

  close(code: number): void {
    this.closeCodes.push(code);
  }
}

class FakeGatewaySocketFactory implements GatewayWebSocketFactory {
  readonly connections: FakeGatewaySocket[] = [];
  readonly modes: ("fresh" | "resume")[] = [];
  readonly targets: OpaqueGatewayConnectionTarget[] = [];

  async connect(input: {
    readonly connectionGeneration: number;
    readonly mode: "fresh" | "resume";
    readonly target: OpaqueGatewayConnectionTarget;
    readonly callbacks: GatewayWebSocketCallbacks;
  }): Promise<GatewayWebSocketConnection> {
    const socket = new FakeGatewaySocket(input.callbacks);
    this.connections.push(socket);
    this.modes.push(input.mode);
    this.targets.push(input.target);
    return socket;
  }
}

function gatewayPayload(op: number, data: unknown = null): string {
  return JSON.stringify({ op, d: data, s: null, t: null });
}

function dispatch(name: string, sequence: number, data: unknown = {}): string {
  return JSON.stringify({ op: 0, d: data, s: sequence, t: name });
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "800000000000000001",
    guild_id: env.DISCORD_GUILD_ID,
    channel_id: env.DISCORD_REGISTRATION_CHANNEL_ID,
    author: { id: "800000000000000002", bot: false, system: false },
    webhook_id: null,
    application_id: null,
    content: "123456 42 Local Player",
    timestamp: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function dependencies(
  clock: MutableClock,
  factory: FakeGatewaySocketFactory,
  options: {
    acceptance?: GatewayTargetAcceptance;
    diagnostics?: GatewayAdapterDiagnostic[];
    fault?: (effect: GatewayAdapterDurableEffect) => GatewayAdapterFaultAction;
    limit?: GatewaySessionStartLimit;
    jitter?: number;
    backoff?: (attempt: number) => number | null;
    scheduleFault?: GatewayAdapterDependencies["scheduleFault"];
  } = {},
): GatewayAdapterDependencies {
  return {
    clock,
    webSocketFactory: factory,
    sessionStartLimit: options.limit ?? LIMIT,
    sessionStartLimitObservedAtMs: clock.now,
    firstHeartbeatJitter: () => options.jitter ?? 0.5,
    reconnectBackoffMs: options.backoff ?? (() => 0),
    ...(options.acceptance === undefined ? {} : { targetAcceptance: options.acceptance }),
    ...(options.diagnostics === undefined
      ? {}
      : { diagnosticSink: (diagnostic) => options.diagnostics?.push(diagnostic) }),
    ...(options.fault === undefined ? {} : { durableEffectFault: options.fault }),
    ...(options.scheduleFault === undefined ? {} : { scheduleFault: options.scheduleFault }),
  };
}

async function configuredAdapter(
  storage: MemoryGatewayStorage,
  clock: MutableClock,
  factory: FakeGatewaySocketFactory,
  options: Parameters<typeof dependencies>[2] = {},
): Promise<GatewayDurableAdapter> {
  const adapter = new GatewayDurableAdapter(storage, env);
  await adapter.hydrate();
  await adapter.configure(dependencies(clock, factory, options));
  return adapter;
}

async function startFresh(
  adapter: GatewayDurableAdapter,
  factory: FakeGatewaySocketFactory,
  readySequence = 10,
  ready: Record<string, unknown> = {},
): Promise<FakeGatewaySocket> {
  await adapter.start();
  const socket = factory.connections.at(-1);
  if (socket === undefined) throw new Error("missing fake connection");
  await socket.callbacks.opened();
  await socket.callbacks.text(gatewayPayload(10, { heartbeat_interval: 1_000 }));
  await socket.callbacks.text(
    dispatch("READY", readySequence, {
      session_id: "local-session",
      resume_gateway_url: "wss://resume.invalid",
      ...ready,
    }),
  );
  return socket;
}

async function reconnect(
  adapter: GatewayDurableAdapter,
  clock: MutableClock,
  factory: FakeGatewaySocketFactory,
): Promise<FakeGatewaySocket> {
  await adapter.alarm();
  const socket = factory.connections.at(-1);
  if (socket === undefined) throw new Error("missing reconnect socket");
  await socket.callbacks.opened();
  await socket.callbacks.text(gatewayPayload(10, { heartbeat_interval: 1_000 }));
  expect(socket.sent.at(-1)?.kind).toBe("resume");
  expect(clock.now).toBeGreaterThanOrEqual(NOW);
  return socket;
}

describe("durable Gateway adapter command and crash ordering", () => {
  it("serializes target acceptance before a monotonic checkpoint and accepts sequence jumps", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    const observedCheckpoints: (number | null)[] = [];
    const accepted: GatewayTargetAcceptance = async () => {
      observedCheckpoints.push(storage.persistedCheckpoint());
      return "accepted";
    };
    const adapter = await configuredAdapter(storage, clock, factory, { acceptance: accepted });
    const socket = await startFresh(adapter, factory);

    await socket.callbacks.text(dispatch("MESSAGE_CREATE", 17, message()));
    await socket.callbacks.text(
      dispatch("MESSAGE_CREATE", 93, message({ id: "800000000000000003" })),
    );
    await socket.callbacks.text(
      dispatch("MESSAGE_CREATE", 93, message({ id: "800000000000000003" })),
    );

    expect(observedCheckpoints).toEqual([10, 17]);
    expect((await adapter.inspect()).checkpoint).toBe(93);
    expect(factory.connections).toHaveLength(1);
  });

  it("leaves the checkpoint unchanged before acceptance commit and recovers through RESUME", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    const outcomes: ("failed" | "duplicate")[] = ["failed", "duplicate"];
    const adapter = await configuredAdapter(storage, clock, factory, {
      acceptance: async () => outcomes.shift() ?? "duplicate",
    });
    const first = await startFresh(adapter, factory);

    await first.callbacks.text(dispatch("MESSAGE_CREATE", 17, message()));
    expect((await adapter.inspect()).checkpoint).toBe(10);
    expect(first.closeCodes).toEqual([4000]);

    const resumed = await reconnect(adapter, clock, factory);
    await resumed.callbacks.text(dispatch("MESSAGE_CREATE", 17, message()));
    await resumed.callbacks.text(dispatch("RESUMED", 18));
    expect((await adapter.inspect()).checkpoint).toBe(18);
    expect(factory.modes).toEqual(["fresh", "resume"]);
  });

  it("models acceptance commit with a lost completion as replayed durable duplicate resolution", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    let calls = 0;
    const adapter = await configuredAdapter(storage, clock, factory, {
      acceptance: async () => (++calls === 1 ? "ambiguous" : "duplicate"),
    });
    const first = await startFresh(adapter, factory);

    await first.callbacks.text(dispatch("MESSAGE_CREATE", 17, message()));
    expect(storage.persistedCheckpoint()).toBe(10);
    const resumed = await reconnect(adapter, clock, factory);
    await resumed.callbacks.text(dispatch("MESSAGE_CREATE", 17, message()));
    expect(storage.persistedCheckpoint()).toBe(17);
    expect(calls).toBe(2);
  });

  it("does not repeat accepted work when checkpoint commit acknowledgement is lost", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    let accepts = 0;
    let loseCheckpoint = true;
    const adapter = await configuredAdapter(storage, clock, factory, {
      acceptance: async () => {
        accepts += 1;
        return "accepted";
      },
      fault: (effect) => {
        if (effect === "checkpoint" && loseCheckpoint) {
          loseCheckpoint = false;
          return "lose_after";
        }
        return "proceed";
      },
    });
    const first = await startFresh(adapter, factory);
    await first.callbacks.text(dispatch("MESSAGE_CREATE", 17, message()));

    expect(storage.persistedCheckpoint()).toBe(17);
    const resumed = await reconnect(adapter, clock, factory);
    await resumed.callbacks.text(dispatch("MESSAGE_CREATE", 17, message()));
    expect(accepts).toBe(1);
    expect(storage.persistedCheckpoint()).toBe(17);
  });

  it("records ignored evidence idempotently around a lost completion before checkpointing", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    let loseIgnored = true;
    const adapter = await configuredAdapter(storage, clock, factory, {
      fault: (effect) => {
        if (effect === "ignored_evidence" && loseIgnored) {
          loseIgnored = false;
          return "lose_after";
        }
        return "proceed";
      },
    });
    const first = await startFresh(adapter, factory);
    const ignored = message({ channel_id: "800000000000000099" });
    await first.callbacks.text(dispatch("MESSAGE_CREATE", 17, ignored));

    expect(storage.ignoredEvidenceCount()).toBe(1);
    expect(storage.persistedCheckpoint()).toBe(10);
    const resumed = await reconnect(adapter, clock, factory);
    await resumed.callbacks.text(dispatch("MESSAGE_CREATE", 17, ignored));
    expect(storage.ignoredEvidenceCount()).toBe(1);
    expect(storage.persistedCheckpoint()).toBe(17);
  });

  it("persists a non-resumable session clear before reconnecting through a fresh lifecycle", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    const adapter = await configuredAdapter(storage, clock, factory, { jitter: 0 });
    const first = await startFresh(adapter, factory);

    await first.callbacks.text(gatewayPayload(9, false));
    expect(await adapter.inspect()).toMatchObject({ checkpoint: null, hasSession: false });
    expect(first.closeCodes).toEqual([4000]);

    await adapter.alarm();
    expect(factory.modes).toEqual(["fresh", "fresh"]);
  });

  it.each(["rejected", "failed", "timeout", "ambiguous"] as const)(
    "maps %s forwarding completion to fail-closed recovery without checkpointing",
    async (outcome) => {
      const storage = new MemoryGatewayStorage();
      const clock = new MutableClock();
      const factory = new FakeGatewaySocketFactory();
      const diagnostics: GatewayAdapterDiagnostic[] = [];
      const adapter = await configuredAdapter(storage, clock, factory, {
        acceptance: async () => outcome,
        diagnostics,
      });
      const socket = await startFresh(adapter, factory);
      await socket.callbacks.text(dispatch("MESSAGE_CREATE", 17, message()));

      expect(storage.persistedCheckpoint()).toBe(10);
      expect((await adapter.inspect()).reconnectAttempts).toBe(1);
      expect(JSON.stringify(diagnostics)).not.toContain(message().content as string);
    },
  );
});

describe("durable Gateway adapter fencing, alarms and reconstruction", () => {
  it("fails closed on an incompatible durable-state version without reflecting stored data", async () => {
    const canary = "CANARY_CORRUPT_GATEWAY_STATE";
    const storage = new MemoryGatewayStorage();
    storage.values.set("gateway-adapter-state", { version: 2, unexpected: canary });
    const adapter = new GatewayDurableAdapter(storage, env);

    let failure: unknown;
    try {
      await adapter.hydrate();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain("invalid_gateway_adapter_state");
    expect(String(failure)).not.toContain(canary);
  });

  it("converges simultaneous starts and ignores callbacks from the fenced socket", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    const adapter = await configuredAdapter(storage, clock, factory);

    await Promise.all([adapter.start(), adapter.start(), adapter.start()]);
    expect(factory.connections).toHaveLength(1);
    const first = factory.connections[0]!;
    await first.callbacks.text(gatewayPayload(10, { heartbeat_interval: 1_000 }));
    await first.callbacks.text(
      dispatch("READY", 10, {
        session_id: "concurrent-session",
        resume_gateway_url: "wss://resume.invalid/concurrent",
      }),
    );
    await first.callbacks.closed(4000);
    await reconnect(adapter, clock, factory);
    await first.callbacks.text(dispatch("MESSAGE_CREATE", 17, message()));

    const inspection = await adapter.inspect();
    expect(inspection.metrics.concurrent_start).toBe(2);
    expect(inspection.metrics.stale_socket_callback).toBe(1);
    expect(inspection.checkpoint).toBe(10);
  });

  it("multiplexes a heartbeat through one alarm and repeated alarm delivery does not resend", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    const adapter = await configuredAdapter(storage, clock, factory, { jitter: 0 });
    const socket = await startFresh(adapter, factory);
    const before = socket.sent.filter((event) => event.kind === "heartbeat_regular").length;

    await adapter.alarm();
    await adapter.alarm();

    expect(socket.sent.filter((event) => event.kind === "heartbeat_regular")).toHaveLength(
      before + 1,
    );
    expect((await adapter.inspect()).logicalSchedules).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "heartbeat" })]),
    );
  });

  it("counts ACKs and preserves only closed protocol fields for missing-ACK recovery", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    const diagnostics: GatewayAdapterDiagnostic[] = [];
    const adapter = await configuredAdapter(storage, clock, factory, {
      diagnostics,
      jitter: 0,
    });
    const socket = await startFresh(adapter, factory);

    await adapter.alarm();
    await socket.callbacks.text(gatewayPayload(11));
    expect((await adapter.inspect()).metrics.heartbeat_ack).toBe(1);

    clock.advance(1_000);
    await adapter.alarm();
    clock.advance(1_000);
    await adapter.alarm();

    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        category: "protocol_diagnostic",
        connectionGeneration: 1,
        lifecycle: "active",
        occurrenceCount: 1,
        protocolCategory: "heartbeat_ack_missing",
      }),
    );
    expect(JSON.stringify(diagnostics)).not.toMatch(/payload|content|session|url|exception/i);
  });

  it.each([
    ["before", "fail_before", 0],
    ["after", "lose_after", 1],
  ] as const)(
    "fences an alarm interrupted %s its side effect and never repeats an indeterminate send",
    async (_timing, fault, expectedInitialSends) => {
      const storage = new MemoryGatewayStorage();
      const clock = new MutableClock();
      const firstFactory = new FakeGatewaySocketFactory();
      let inject = true;
      const first = await configuredAdapter(storage, clock, firstFactory, {
        jitter: 0,
        scheduleFault: (kind) => {
          if (kind !== "heartbeat" || !inject) return "proceed";
          inject = false;
          return fault;
        },
      });
      const firstSocket = await startFresh(first, firstFactory);

      await expect(first.alarm()).rejects.toThrow("modeled_schedule_interruption");
      expect(firstSocket.sent.filter((event) => event.kind === "heartbeat_regular")).toHaveLength(
        expectedInitialSends,
      );

      const replacementFactory = new FakeGatewaySocketFactory();
      const replacement = await configuredAdapter(storage, clock, replacementFactory, {
        jitter: 0,
      });
      await replacement.alarm();
      expect(firstSocket.sent.filter((event) => event.kind === "heartbeat_regular")).toHaveLength(
        expectedInitialSends,
      );
      expect((await replacement.inspect()).metrics.schedule_ambiguous_recovery).toBe(1);

      await replacement.alarm();
      expect(replacementFactory.connections).toHaveLength(1);
      await replacement.alarm();
      expect(replacementFactory.connections).toHaveLength(1);
      expect((await replacement.inspect()).connectionGeneration).toBeGreaterThan(1);
    },
  );

  it("preserves an existing alarm, constructor evidence, retry state and IDENTIFY safety", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const firstFactory = new FakeGatewaySocketFactory();
    const oneIdentify = {
      total: 1,
      remaining: 1,
      reset_after: 86_400_000,
      max_concurrency: 1,
    } as const;
    const first = await configuredAdapter(storage, clock, firstFactory, {
      limit: oneIdentify,
      backoff: () => 5_000,
    });
    await first.start();
    const firstSocket = firstFactory.connections[0]!;
    await firstSocket.callbacks.text(gatewayPayload(10, { heartbeat_interval: 1_000 }));
    await firstSocket.callbacks.closed(4000);
    const retainedAlarm = storage.alarmAt;
    const retainedAlarmSetCount = storage.alarmSets.length;

    const secondFactory = new FakeGatewaySocketFactory();
    const second = new GatewayDurableAdapter(storage, env);
    await second.hydrate();
    expect(storage.alarmAt).toBe(retainedAlarm);
    expect(storage.alarmSets).toHaveLength(retainedAlarmSetCount);
    await second.configure(
      dependencies(clock, secondFactory, {
        limit: oneIdentify,
        backoff: () => 5_000,
      }),
    );
    await second.start();
    const secondSocket = secondFactory.connections[0]!;
    await secondSocket.callbacks.text(gatewayPayload(10, { heartbeat_interval: 1_000 }));

    const inspection = await second.inspect();
    expect(inspection.constructorInvocations).toBe(2);
    expect(inspection.reconnectAttempts).toBe(1);
    expect(secondSocket.sent.some((event) => event.kind === "identify")).toBe(false);
    expect((inspection.protocol as { phase: string }).phase).toBe("halted");
  });

  it("keeps retry exhaustion finite across reconstruction", async () => {
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    const adapter = await configuredAdapter(storage, clock, factory, {
      backoff: (attempt) => (attempt <= 1 ? 0 : null),
    });
    const first = await startFresh(adapter, factory);
    await first.callbacks.closed(4000);
    const secondSocket = await reconnect(adapter, clock, factory);
    await secondSocket.callbacks.closed(4000);
    expect((await adapter.inspect()).metrics.retry_exhausted).toBe(1);

    const reconstructed = new GatewayDurableAdapter(storage, env);
    await reconstructed.hydrate();
    await reconstructed.configure(
      dependencies(clock, new FakeGatewaySocketFactory(), {
        backoff: (attempt) => (attempt <= 1 ? 0 : null),
      }),
    );
    expect((await reconstructed.inspect()).reconnectAttempts).toBe(2);
  });

  it("redacts session, payload, IDs and exception-like sentinels from every summary", async () => {
    const canary = "CANARY_GATEWAY_ADAPTER_DO_NOT_EXPOSE";
    const storage = new MemoryGatewayStorage();
    const clock = new MutableClock();
    const factory = new FakeGatewaySocketFactory();
    const diagnostics: GatewayAdapterDiagnostic[] = [];
    const adapter = await configuredAdapter(storage, clock, factory, {
      acceptance: async () => {
        throw new Error(`${canary}-exception`);
      },
      diagnostics,
    });
    const socket = await startFresh(adapter, factory, 10, {
      session_id: `${canary}-session`,
      resume_gateway_url: `wss://${canary}.invalid`,
    });
    await socket.callbacks.text(
      dispatch(
        "MESSAGE_CREATE",
        17,
        message({
          id: "899999999999999999",
          content: canary,
          author: { id: "888888888888888888", bot: false, system: false },
        }),
      ),
    );
    await adapter.alarm();
    const resumed = factory.connections.at(-1);
    if (resumed === undefined || resumed === socket) throw new Error("missing resumed connection");
    await resumed.callbacks.text(gatewayPayload(10, { heartbeat_interval: 1_000 }));

    expect(JSON.stringify(await adapter.inspect())).not.toContain(canary);
    expect(JSON.stringify(diagnostics)).not.toContain(canary);
    expect(JSON.stringify(diagnostics)).not.toMatch(/899999999999999999|888888888888888888/);
    expect(JSON.stringify(factory.targets)).not.toContain(canary);
    expect(JSON.stringify(resumed.contexts)).not.toContain(canary);
  });
});

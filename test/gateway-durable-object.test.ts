import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { dispatchOutput } from "../src/discord/delivery";
import type {
  GatewayAdapterClock,
  GatewayAdapterDependencies,
  GatewayWebSocketCallbacks,
  GatewayWebSocketConnection,
  GatewayWebSocketFactory,
  OpaqueGatewayConnectionTarget,
  OpaqueGatewaySendContext,
} from "../src/discord/gateway/durable-adapter-types";
import { LocalDiscordGatewayAdapter } from "../src/discord/gateway/local-durable-object";
import type { GatewayOutboundEvent, GatewayTransportResult } from "../src/discord/gateway/types";
import { testConfig, uniqueId } from "./support/fixtures";

const SPIKE_SENDER = "000000000000000004";
// Keep platform alarms in the future; runDurableObjectAlarm() executes them deterministically.
const NOW = Date.parse("2030-09-12T14:00:00.000Z");

class LocalClock implements GatewayAdapterClock {
  now = NOW;

  monotonicNowMs(): number {
    return this.now;
  }

  wallNowMs(): number {
    return this.now;
  }
}

class LocalSocket implements GatewayWebSocketConnection {
  readonly callbacks: GatewayWebSocketCallbacks;
  readonly sent: GatewayOutboundEvent[] = [];
  readonly closes: number[] = [];

  constructor(callbacks: GatewayWebSocketCallbacks) {
    this.callbacks = callbacks;
  }

  async send(
    event: GatewayOutboundEvent,
    _context: OpaqueGatewaySendContext,
  ): Promise<GatewayTransportResult> {
    this.sent.push(event);
    return "sent";
  }

  close(code: number): void {
    this.closes.push(code);
  }
}

class LocalSocketFactory implements GatewayWebSocketFactory {
  readonly connections: LocalSocket[] = [];
  readonly modes: ("fresh" | "resume")[] = [];

  async connect(input: {
    readonly connectionGeneration: number;
    readonly mode: "fresh" | "resume";
    readonly target: OpaqueGatewayConnectionTarget;
    readonly callbacks: GatewayWebSocketCallbacks;
  }): Promise<GatewayWebSocketConnection> {
    const socket = new LocalSocket(input.callbacks);
    this.connections.push(socket);
    this.modes.push(input.mode);
    return socket;
  }
}

function gatewayPayload(op: number, data: unknown = null): string {
  return JSON.stringify({ op, d: data, s: null, t: null });
}

function dispatch(name: string, sequence: number, data: unknown = {}): string {
  return JSON.stringify({ op: 0, d: data, s: sequence, t: name });
}

function message(
  eventId: string,
  content: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: eventId,
    guild_id: env.DISCORD_GUILD_ID,
    channel_id: env.DISCORD_REGISTRATION_CHANNEL_ID,
    author: { id: uniqueId(), bot: false, system: false },
    webhook_id: null,
    application_id: null,
    content,
    timestamp: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function dependencies(clock: LocalClock, factory: LocalSocketFactory): GatewayAdapterDependencies {
  return {
    clock,
    webSocketFactory: factory,
    sessionStartLimit: {
      total: 1_000,
      remaining: 999,
      reset_after: 86_400_000,
      max_concurrency: 1,
    },
    sessionStartLimitObservedAtMs: clock.now,
    firstHeartbeatJitter: () => 0,
    reconnectBackoffMs: () => 0,
  };
}

type LocalStub = DurableObjectStub<LocalDiscordGatewayAdapter>;

function localStub(name: string): LocalStub {
  return env.LOCAL_GATEWAY_ADAPTER.get(env.LOCAL_GATEWAY_ADAPTER.idFromName(name));
}

async function inObject<T>(
  stub: LocalStub,
  callback: (instance: LocalDiscordGatewayAdapter, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject<LocalDiscordGatewayAdapter, T>(stub, callback);
}

async function configureAndReady(
  stub: LocalStub,
  clock: LocalClock,
  factory: LocalSocketFactory,
  readySequence = 10,
): Promise<LocalSocket> {
  await inObject(stub, async (instance) => {
    await instance.configureForLocalTest(dependencies(clock, factory));
    await instance.startForLocalTest();
  });
  const socket = factory.connections[0];
  if (socket === undefined) throw new Error("missing local socket");
  await inObject(stub, async () => {
    await socket.callbacks.opened();
    await socket.callbacks.text(gatewayPayload(10, { heartbeat_interval: 1_000 }));
    await socket.callbacks.text(
      dispatch("READY", readySequence, {
        session_id: `local-session-${readySequence}`,
        resume_gateway_url: `wss://resume.invalid/${readySequence}`,
      }),
    );
  });
  return socket;
}

describe("real local Durable Object Gateway adapter", () => {
  it("is locally bound, returns 404 from its fetch surface, and never starts implicitly", async () => {
    const stub = localStub(`dormant-${uniqueId()}`);
    const response = await stub.fetch("https://local.invalid/not-a-start-route");
    expect(response.status).toBe(404);
    const inspection = await inObject(stub, (instance) => instance.inspectForLocalTest());
    expect(inspection).toMatchObject({
      hydrated: true,
      configured: false,
      hasActiveConnection: false,
      connectionGeneration: 0,
      constructorInvocations: 1,
    });
  });

  it("atomically persists READY material with its checkpoint and multiplexes a real alarm", async () => {
    const stub = localStub(`ready-alarm-${uniqueId()}`);
    const clock = new LocalClock();
    const factory = new LocalSocketFactory();
    const socket = await configureAndReady(stub, clock, factory);

    const durableShape = await inObject(stub, async (_instance, state) => {
      const record = await state.storage.get<{
        session: unknown;
        checkpoint: number | null;
      }>("gateway-adapter-state");
      return {
        hasSession: record?.session !== null && record?.session !== undefined,
        checkpoint: record?.checkpoint,
        alarm: await state.storage.getAlarm(),
      };
    });
    expect(durableShape).toMatchObject({ hasSession: true, checkpoint: 10 });
    expect(durableShape.alarm).not.toBeNull();

    const before = socket.sent.filter((event) => event.kind === "heartbeat_regular").length;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(socket.sent.filter((event) => event.kind === "heartbeat_regular")).toHaveLength(
      before + 1,
    );
  });

  it("survives true local eviction with its checkpoint, alarm and constructor evidence", async () => {
    const stub = localStub(`eviction-${uniqueId()}`);
    const clock = new LocalClock();
    const firstFactory = new LocalSocketFactory();
    await configureAndReady(stub, clock, firstFactory);
    const before = await inObject(stub, async (instance, state) => ({
      inspection: await instance.inspectForLocalTest(),
      alarm: await state.storage.getAlarm(),
    }));

    await evictDurableObject(stub, { webSockets: "close" });

    const after = await inObject(stub, async (instance, state) => ({
      inspection: await instance.inspectForLocalTest(),
      alarm: await state.storage.getAlarm(),
    }));
    expect(after.inspection.constructorInvocations).toBe(2);
    expect(after.inspection.checkpoint).toBe(10);
    expect(after.inspection.hasSession).toBe(true);
    expect(after.alarm).toBe(before.alarm);

    const secondFactory = new LocalSocketFactory();
    await inObject(stub, async (instance) => {
      await instance.configureForLocalTest(dependencies(clock, secondFactory));
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(secondFactory.modes).toEqual(["resume"]);
    expect(
      (await inObject(stub, (instance) => instance.inspectForLocalTest())).connectionGeneration,
    ).toBeGreaterThan(before.inspection.connectionGeneration);
  });
});

describe("trusted Task 08B acceptance from the local Durable Object", () => {
  it("accepts and exact-duplicate-resolves one immutable staging-spike marker/output", async () => {
    expect(testConfig().spikeSenderAllowlist).toContain(SPIKE_SENDER);
    const stub = localStub(`spike-${uniqueId()}`);
    const clock = new LocalClock();
    const factory = new LocalSocketFactory();
    const socket = await configureAndReady(stub, clock, factory);
    const eventId = uniqueId();
    const spike = message(eventId, `SPIKE-LOCAL-${uniqueId()}`, {
      author: { id: SPIKE_SENDER, bot: true, system: false },
    });

    await inObject(stub, async () => {
      await socket.callbacks.text(dispatch("MESSAGE_CREATE", 17, spike));
      // A later replay with the same durable Discord message id must query exact 08B evidence.
      await socket.callbacks.text(dispatch("MESSAGE_CREATE", 18, spike));
    });

    expect((await inObject(stub, (instance) => instance.inspectForLocalTest())).checkpoint).toBe(
      18,
    );
    expect(
      await env.STAGING_DB.prepare(
        `SELECT COUNT(*) AS n FROM processed_events
         WHERE event_id=?1 AND acceptance_class='staging_spike' AND status='finalized'
           AND outcome='invalid' AND operation_id IS NULL AND committed_at IS NULL
           AND finalized_at IS accepted_at`,
      )
        .bind(eventId)
        .first("n"),
    ).toBe(1);
    expect(
      await env.STAGING_DB.prepare(
        `SELECT COUNT(*) AS n FROM discord_output_deliveries
         WHERE event_id=?1 AND status='superseded' AND dispatch_eligible=0
           AND permanent_dispatch_block=1 AND suppression_reason='staging_spike_sender'
           AND claim_token IS NULL AND claim_expires_at IS NULL AND attempts=0
           AND discord_message_id IS NULL AND sent_at IS NULL AND available_at IS NULL`,
      )
        .bind(eventId)
        .first("n"),
    ).toBe(1);

    const transport = vi.fn(async () => new Response(JSON.stringify({ id: uniqueId() })));
    await dispatchOutput(env.STAGING_DB, testConfig(), () => new Date(clock.now), transport);
    expect(transport).not.toHaveBeenCalled();
    expect(
      await env.STAGING_DB.prepare(
        `SELECT COUNT(*) AS n FROM discord_output_deliveries
         WHERE event_id=?1 AND (status<>'superseded' OR dispatch_eligible<>0
           OR permanent_dispatch_block<>1 OR claim_token IS NOT NULL OR attempts<>0)`,
      )
        .bind(eventId)
        .first("n"),
    ).toBe(0);
  });

  it("rejects incomplete duplicate evidence and leaves the checkpoint unchanged", async () => {
    const stub = localStub(`corrupt-duplicate-${uniqueId()}`);
    const clock = new LocalClock();
    const factory = new LocalSocketFactory();
    const socket = await configureAndReady(stub, clock, factory);
    const eventId = uniqueId();
    const stamp = new Date(clock.now).toISOString();
    await env.STAGING_DB.prepare(
      `INSERT INTO processed_events
       (event_id,kind,status,outcome,operation_id,validation_reason,output_delivery_group,
        received_at,accepted_at,committed_at,finalized_at,acceptance_class)
       VALUES (?1,'registration','accepted_invalid','invalid',NULL,'player_id_not_numeric',
               ?2,?3,?3,NULL,NULL,'normal')`,
    )
      .bind(eventId, `evt:${eventId}`, stamp)
      .run();
    const spike = message(eventId, `SPIKE-CORRUPT-${uniqueId()}`, {
      author: { id: SPIKE_SENDER, bot: true, system: false },
    });

    await inObject(stub, () => socket.callbacks.text(dispatch("MESSAGE_CREATE", 17, spike)));

    const inspection = await inObject(stub, (instance) => instance.inspectForLocalTest());
    expect(inspection.checkpoint).toBe(10);
    expect(inspection.metrics.acceptance_rejected).toBe(1);
    expect(
      await env.STAGING_DB.prepare(
        "SELECT COUNT(*) AS n FROM discord_output_deliveries WHERE event_id=?1",
      )
        .bind(eventId)
        .first("n"),
    ).toBe(0);
  });

  it("keeps valid spike syntax fail-closed with no player, operation, outbox or output work", async () => {
    const stub = localStub(`valid-spike-${uniqueId()}`);
    const clock = new LocalClock();
    const factory = new LocalSocketFactory();
    const socket = await configureAndReady(stub, clock, factory);
    const eventId = uniqueId();
    const playerId = uniqueId();
    const spike = message(eventId, `${playerId} 42 Should Not Register`, {
      author: { id: SPIKE_SENDER, bot: true, system: false },
    });

    await inObject(stub, () => socket.callbacks.text(dispatch("MESSAGE_CREATE", 17, spike)));

    expect((await inObject(stub, (instance) => instance.inspectForLocalTest())).checkpoint).toBe(
      10,
    );
    for (const [table, column, value] of [
      ["processed_events", "event_id", eventId],
      ["players", "player_id", playerId],
      ["discord_output_deliveries", "event_id", eventId],
    ] as const) {
      expect(
        await env.STAGING_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column}=?1`)
          .bind(value)
          .first("n"),
      ).toBe(0);
    }
  });

  it("preserves normal human registration and invalid validation-reply behavior", async () => {
    const stub = localStub(`human-${uniqueId()}`);
    const clock = new LocalClock();
    const factory = new LocalSocketFactory();
    const socket = await configureAndReady(stub, clock, factory);
    const validEventId = uniqueId();
    const invalidEventId = uniqueId();
    const playerId = uniqueId();

    await inObject(stub, async () => {
      await socket.callbacks.text(
        dispatch("MESSAGE_CREATE", 17, message(validEventId, `${playerId} 42 Human Player`)),
      );
      await socket.callbacks.text(
        dispatch("MESSAGE_CREATE", 18, message(invalidEventId, "not-a-player-id")),
      );
    });

    expect((await inObject(stub, (instance) => instance.inspectForLocalTest())).checkpoint).toBe(
      18,
    );
    expect(
      await env.STAGING_DB.prepare("SELECT state,display_name FROM players WHERE player_id=?1")
        .bind(playerId)
        .first(),
    ).toEqual({ state: "42", display_name: "Human Player" });
    expect(
      await env.STAGING_DB.prepare(
        "SELECT acceptance_class,status,outcome FROM processed_events WHERE event_id=?1",
      )
        .bind(validEventId)
        .first(),
    ).toEqual({ acceptance_class: "normal", status: "work_committed", outcome: "valid" });
    expect(
      await env.STAGING_DB.prepare(
        `SELECT e.acceptance_class,e.status,e.outcome,d.status AS output_status,
                d.dispatch_eligible,d.permanent_dispatch_block
         FROM processed_events e JOIN discord_output_deliveries d ON d.event_id=e.event_id
         WHERE e.event_id=?1`,
      )
        .bind(invalidEventId)
        .first(),
    ).toEqual({
      acceptance_class: "normal",
      status: "accepted_invalid",
      outcome: "invalid",
      output_status: "pending",
      dispatch_eligible: 1,
      permanent_dispatch_block: 0,
    });
  });
});

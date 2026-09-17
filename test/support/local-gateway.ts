import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type {
  GatewayAdapterClock,
  GatewayAdapterDependencies,
  GatewayWebSocketCallbacks,
  GatewayWebSocketConnection,
  GatewayWebSocketFactory,
  OpaqueGatewayConnectionTarget,
  OpaqueGatewaySendContext,
} from "../../src/discord/gateway/durable-adapter-types";
import { LocalDiscordGatewayAdapter } from "../../src/discord/gateway/local-durable-object";
import type { GatewayOutboundEvent, GatewayTransportResult } from "../../src/discord/gateway/types";
import { uniqueId } from "./fixtures";

export const SPIKE_SENDER = "000000000000000004";
// Keep platform alarms in the future; runDurableObjectAlarm() executes them deterministically.
export const NOW = Date.parse("2030-09-12T14:00:00.000Z");

export class LocalClock implements GatewayAdapterClock {
  now = NOW;

  monotonicNowMs(): number {
    return this.now;
  }

  wallNowMs(): number {
    return this.now;
  }
}

export class LocalSocket implements GatewayWebSocketConnection {
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

export class LocalSocketFactory implements GatewayWebSocketFactory {
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

export function dispatch(name: string, sequence: number, data: unknown = {}): string {
  return JSON.stringify({ op: 0, d: data, s: sequence, t: name });
}

export function message(
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

export function dependencies(
  clock: LocalClock,
  factory: LocalSocketFactory,
): GatewayAdapterDependencies {
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

export type LocalStub = DurableObjectStub<LocalDiscordGatewayAdapter>;

export function localStub(name: string): LocalStub {
  return env.LOCAL_GATEWAY_ADAPTER.get(env.LOCAL_GATEWAY_ADAPTER.idFromName(name));
}

export async function inObject<T>(
  stub: LocalStub,
  callback: (instance: LocalDiscordGatewayAdapter, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject<LocalDiscordGatewayAdapter, T>(stub, callback);
}

export async function configureAndReady(
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

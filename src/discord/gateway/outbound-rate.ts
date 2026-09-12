import type { GatewaySendKind, GatewayTransportResult } from "./types";

export const DISCORD_DOCUMENTED_GATEWAY_OUTBOUND_LIMIT = Object.freeze({
  source: "discord_documented_connection_limit" as const,
  maximumEvents: 120,
  intervalMs: 60_000,
  scope: "physical_connection" as const,
});

/**
 * Project-owned conservative policy. This rolling window is intentionally not described as
 * Discord's undocumented server-side bucket implementation.
 */
export const LOCAL_GATEWAY_OUTBOUND_SAFETY_GATE = Object.freeze({
  name: "local_gateway_outbound_safety_gate" as const,
  algorithm: "local_rolling_window" as const,
  maximumAuthorizations: 120,
  intervalMs: 60_000,
  countingPoint: "transport_authorization_emitted" as const,
});

const SEND_KINDS: readonly GatewaySendKind[] = [
  "heartbeat_regular",
  "heartbeat_requested",
  "identify",
  "resume",
  "presence_update",
  "voice_state_update",
  "request_guild_members",
  "request_soundboard_sounds",
  "request_channel_info",
];

export interface GatewayOutboundTelemetry {
  readonly connectionGenerations: number;
  readonly authorized: number;
  readonly denied: number;
  readonly failed: number;
  readonly ambiguous: number;
  readonly peakConnectionPressure: number;
  readonly authorizedByKind: Readonly<Record<GatewaySendKind, number>>;
}

export interface GatewayOutboundRateState {
  readonly connectionGeneration: number;
  readonly connectionAuthorizationsMs: readonly number[];
  readonly connectionAuthorized: number;
  readonly lastObservedAtMs: number | null;
  readonly telemetry: GatewayOutboundTelemetry;
}

export type GatewayOutboundRateDecision =
  | {
      readonly allowed: true;
      readonly state: GatewayOutboundRateState;
      readonly pressure: number;
      readonly evidence: Readonly<{
        documented: typeof DISCORD_DOCUMENTED_GATEWAY_OUTBOUND_LIMIT;
        localPolicy: typeof LOCAL_GATEWAY_OUTBOUND_SAFETY_GATE;
      }>;
    }
  | {
      readonly allowed: false;
      readonly state: GatewayOutboundRateState;
      readonly reason: "deadline_missed" | "window_exhausted" | "non_monotonic_time";
      readonly retryAtMs: number | null;
      readonly evidence: Readonly<{
        documented: typeof DISCORD_DOCUMENTED_GATEWAY_OUTBOUND_LIMIT;
        localPolicy: typeof LOCAL_GATEWAY_OUTBOUND_SAFETY_GATE;
      }>;
    };

const evidence = Object.freeze({
  documented: DISCORD_DOCUMENTED_GATEWAY_OUTBOUND_LIMIT,
  localPolicy: LOCAL_GATEWAY_OUTBOUND_SAFETY_GATE,
});

function emptyKindCounts(): Record<GatewaySendKind, number> {
  return Object.fromEntries(SEND_KINDS.map((kind) => [kind, 0])) as Record<GatewaySendKind, number>;
}

export function createGatewayOutboundRateState(connectionGeneration = 1): GatewayOutboundRateState {
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1)
    throw new RangeError("invalid_connection_generation");
  return {
    connectionGeneration,
    connectionAuthorizationsMs: [],
    connectionAuthorized: 0,
    lastObservedAtMs: null,
    telemetry: {
      connectionGenerations: 1,
      authorized: 0,
      denied: 0,
      failed: 0,
      ambiguous: 0,
      peakConnectionPressure: 0,
      authorizedByKind: emptyKindCounts(),
    },
  };
}

function validateTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function authorizeGatewayOutbound(
  state: GatewayOutboundRateState,
  request: Readonly<{ kind: GatewaySendKind; nowMs: number; deadlineAtMs: number }>,
): GatewayOutboundRateDecision {
  if (!validateTime(request.nowMs) || !validateTime(request.deadlineAtMs))
    throw new RangeError("invalid_outbound_time");

  const deny = (
    reason: "deadline_missed" | "window_exhausted" | "non_monotonic_time",
    retryAtMs: number | null,
  ): GatewayOutboundRateDecision => ({
    allowed: false,
    state: {
      ...state,
      lastObservedAtMs:
        state.lastObservedAtMs === null
          ? request.nowMs
          : Math.max(state.lastObservedAtMs, request.nowMs),
      telemetry: { ...state.telemetry, denied: state.telemetry.denied + 1 },
    },
    reason,
    retryAtMs,
    evidence,
  });

  if (state.lastObservedAtMs !== null && request.nowMs < state.lastObservedAtMs)
    return deny("non_monotonic_time", null);
  if (request.nowMs > request.deadlineAtMs) return deny("deadline_missed", null);

  const threshold = request.nowMs - LOCAL_GATEWAY_OUTBOUND_SAFETY_GATE.intervalMs;
  const active = state.connectionAuthorizationsMs.filter((timestamp) => timestamp > threshold);
  if (active.length >= LOCAL_GATEWAY_OUTBOUND_SAFETY_GATE.maximumAuthorizations) {
    const oldest = active[0];
    return deny(
      "window_exhausted",
      oldest === undefined ? null : oldest + LOCAL_GATEWAY_OUTBOUND_SAFETY_GATE.intervalMs,
    );
  }

  const timestamps = [...active, request.nowMs];
  const byKind = {
    ...state.telemetry.authorizedByKind,
    [request.kind]: state.telemetry.authorizedByKind[request.kind] + 1,
  };
  const telemetry: GatewayOutboundTelemetry = {
    ...state.telemetry,
    authorized: state.telemetry.authorized + 1,
    peakConnectionPressure: Math.max(state.telemetry.peakConnectionPressure, timestamps.length),
    authorizedByKind: byKind,
  };
  return {
    allowed: true,
    state: {
      connectionGeneration: state.connectionGeneration,
      connectionAuthorizationsMs: timestamps,
      connectionAuthorized: state.connectionAuthorized + 1,
      lastObservedAtMs: request.nowMs,
      telemetry,
    },
    pressure: timestamps.length,
    evidence,
  };
}

export function recordGatewayOutboundResult(
  state: GatewayOutboundRateState,
  result: GatewayTransportResult,
): GatewayOutboundRateState {
  if (result === "sent") return state;
  return {
    ...state,
    telemetry: {
      ...state.telemetry,
      failed: state.telemetry.failed + (result === "failed" ? 1 : 0),
      ambiguous: state.telemetry.ambiguous + (result === "ambiguous" ? 1 : 0),
    },
  };
}

export function startGatewayConnectionGeneration(
  state: GatewayOutboundRateState,
  connectionGeneration: number,
): GatewayOutboundRateState {
  if (
    !Number.isSafeInteger(connectionGeneration) ||
    connectionGeneration <= state.connectionGeneration
  )
    throw new RangeError("invalid_connection_generation");
  return {
    connectionGeneration,
    connectionAuthorizationsMs: [],
    connectionAuthorized: 0,
    lastObservedAtMs: state.lastObservedAtMs,
    telemetry: {
      ...state.telemetry,
      connectionGenerations: state.telemetry.connectionGenerations + 1,
    },
  };
}

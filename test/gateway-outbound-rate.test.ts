import { describe, expect, it } from "vitest";
import {
  authorizeGatewayOutbound,
  createGatewayOutboundRateState,
  DISCORD_DOCUMENTED_GATEWAY_OUTBOUND_LIMIT,
  LOCAL_GATEWAY_OUTBOUND_SAFETY_GATE,
  recordGatewayOutboundResult,
  startGatewayConnectionGeneration,
  type GatewayOutboundRateState,
} from "../src/discord/gateway/outbound-rate";
import type { GatewaySendKind } from "../src/discord/gateway/types";

const allKinds: readonly GatewaySendKind[] = [
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

function permit(
  state: GatewayOutboundRateState,
  kind: GatewaySendKind,
  nowMs: number,
): GatewayOutboundRateState {
  const decision = authorizeGatewayOutbound(state, { kind, nowMs, deadlineAtMs: nowMs });
  expect(decision.allowed).toBe(true);
  return decision.state;
}

describe("local_gateway_outbound_safety_gate", () => {
  it("permits exactly 120 sends at one timestamp and emits no prospective 121st authorization", () => {
    let state = createGatewayOutboundRateState();
    for (let index = 0; index < 120; index++) state = permit(state, "presence_update", 10_000);

    const denied = authorizeGatewayOutbound(state, {
      kind: "heartbeat_requested",
      nowMs: 10_000,
      deadlineAtMs: 10_000,
    });
    expect(denied).toMatchObject({
      allowed: false,
      reason: "window_exhausted",
      retryAtMs: 70_000,
    });
    expect(denied.state.connectionAuthorizationsMs).toHaveLength(120);
    expect(denied.state.telemetry.authorized).toBe(120);
    expect(denied.state.telemetry.denied).toBe(1);
  });

  it("expires local authorizations at the exact 60-second rolling-window boundary", () => {
    let state = createGatewayOutboundRateState();
    for (let index = 0; index < 120; index++) state = permit(state, "presence_update", 0);

    const before = authorizeGatewayOutbound(state, {
      kind: "presence_update",
      nowMs: 59_999,
      deadlineAtMs: 59_999,
    });
    expect(before.allowed).toBe(false);
    expect(before.state.connectionAuthorizationsMs).toHaveLength(120);

    const atBoundary = authorizeGatewayOutbound(before.state, {
      kind: "presence_update",
      nowMs: 60_000,
      deadlineAtMs: 60_000,
    });
    expect(atBoundary.allowed).toBe(true);
    expect(atBoundary.state.connectionAuthorizationsMs).toEqual([60_000]);
  });

  it("routes every supported outbound Gateway event kind through the same counting gate", () => {
    let state = createGatewayOutboundRateState();
    for (const kind of allKinds) state = permit(state, kind, 5_000);

    expect(state.connectionAuthorized).toBe(allKinds.length);
    expect(state.connectionAuthorizationsMs).toEqual(allKinds.map(() => 5_000));
    expect(state.telemetry.authorizedByKind).toEqual(
      Object.fromEntries(allKinds.map((kind) => [kind, 1])),
    );
  });

  it("does not refund failed or ambiguous sends", () => {
    let state = permit(createGatewayOutboundRateState(), "identify", 1_000);
    state = recordGatewayOutboundResult(state, "failed");
    state = recordGatewayOutboundResult(state, "ambiguous");

    expect(state.connectionAuthorizationsMs).toEqual([1_000]);
    expect(state.telemetry).toMatchObject({ authorized: 1, failed: 1, ambiguous: 1 });
  });

  it("gives a new physical connection a fresh budget while retaining run-wide pressure", () => {
    let state = createGatewayOutboundRateState(4);
    for (let index = 0; index < 120; index++) state = permit(state, "presence_update", 2_000);
    const next = startGatewayConnectionGeneration(state, 5);

    expect(next.connectionAuthorizationsMs).toEqual([]);
    expect(next.connectionAuthorized).toBe(0);
    expect(next.telemetry).toMatchObject({
      connectionGenerations: 2,
      authorized: 120,
      peakConnectionPressure: 120,
    });
    const firstOnNewConnection = authorizeGatewayOutbound(next, {
      kind: "resume",
      nowMs: 2_001,
      deadlineAtMs: 2_001,
    });
    expect(firstOnNewConnection.allowed).toBe(true);
    expect(firstOnNewConnection.state.telemetry.authorized).toBe(121);
  });

  it("keeps Discord's documented limit distinct from the local rolling-window policy", () => {
    expect(DISCORD_DOCUMENTED_GATEWAY_OUTBOUND_LIMIT).toEqual({
      source: "discord_documented_connection_limit",
      maximumEvents: 120,
      intervalMs: 60_000,
      scope: "physical_connection",
    });
    expect(LOCAL_GATEWAY_OUTBOUND_SAFETY_GATE).toEqual({
      name: "local_gateway_outbound_safety_gate",
      algorithm: "local_rolling_window",
      maximumAuthorizations: 120,
      intervalMs: 60_000,
      countingPoint: "transport_authorization_emitted",
    });

    const denied = authorizeGatewayOutbound(createGatewayOutboundRateState(), {
      kind: "identify",
      nowMs: 2,
      deadlineAtMs: 1,
    });
    expect(denied).toMatchObject({ allowed: false, reason: "deadline_missed" });
    expect(JSON.stringify(denied)).not.toContain("reconnect");
  });
});

import { describe, expect, it } from "vitest";
import { authorizeGatewayOutbound } from "../src/discord/gateway/outbound-rate";
import {
  beginGatewayHandshake,
  completeGatewayEffect,
  completeGatewayOutbound,
  createGatewayProtocolState,
  decideCheckpointAdvance,
  gatewayConnectionClosed,
  gatewayConnectionOpened,
  gatewayHeartbeatDue,
  receiveGatewayText,
  requestGatewayOutbound,
  snapshotGatewayProtocolSafety,
  summarizeGatewayState,
  updateGatewaySessionStartLimit,
  type CreateGatewayProtocolOptions,
  type GatewayProtocolState,
  type GatewayTransition,
} from "../src/discord/gateway/protocol";
import { classifyGatewayCloseCode } from "../src/discord/gateway/reconnect-policy";
import {
  AcceptTargetMessageCommand,
  GatewaySessionHandle,
  PersistReadySessionCommand,
  SendGatewayEventCommand,
  type GatewayCommand,
  type GatewayMessageClassifier,
  type GatewaySessionStartLimit,
} from "../src/discord/gateway/types";

const LIMIT: GatewaySessionStartLimit = {
  total: 1_000,
  remaining: 999,
  reset_after: 86_400_000,
  max_concurrency: 1,
};

const CLASSIFY_MESSAGE: GatewayMessageClassifier = (event) =>
  event.guild_id === "100" &&
  event.channel_id === "200" &&
  event.author_id !== "999" &&
  event.application_id !== "999" &&
  !event.author_is_bot &&
  !event.author_is_system &&
  event.webhook_id === null
    ? "target"
    : "ignored";

function create(
  options: Partial<
    Pick<
      CreateGatewayProtocolOptions,
      "persistedSession" | "sessionStartLimit" | "classifyMessage" | "shardId"
    >
  > = {},
): GatewayProtocolState {
  return createGatewayProtocolState({
    sessionStartLimit: options.sessionStartLimit ?? LIMIT,
    sessionStartLimitObservedAtMs: 0,
    classifyMessage: options.classifyMessage ?? CLASSIFY_MESSAGE,
    shardId: options.shardId ?? 0,
    ...(options.persistedSession === undefined
      ? {}
      : { persistedSession: options.persistedSession }),
  });
}

function gatewayPayload(op: number, d: unknown = null): string {
  return JSON.stringify({ op, d, s: null, t: null });
}

function dispatch(name: string, sequence: number, data: unknown = {}): string {
  return JSON.stringify({ op: 0, d: data, s: sequence, t: name });
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "300",
    guild_id: "100",
    channel_id: "200",
    author: { id: "400", bot: false, system: false },
    webhook_id: null,
    application_id: null,
    content: "123456 42 Name",
    timestamp: "2026-09-10T10:00:00.000Z",
    ...overrides,
  };
}

function command<T extends GatewayCommand["type"]>(
  transition: GatewayTransition,
  type: T,
): Extract<GatewayCommand, { type: T }> {
  const found = transition.commands.find((candidate) => candidate.type === type);
  if (found === undefined) throw new Error("missing_test_command");
  return found as Extract<GatewayCommand, { type: T }>;
}

function completeOnlySend(
  transition: GatewayTransition,
  result: "sent" | "failed" | "ambiguous" = "sent",
): GatewayProtocolState {
  const send = command(transition, "send_gateway_event");
  return completeGatewayOutbound(transition.state, {
    authorizationId: send.authorizationId,
    result,
  }).state;
}

function startFresh(state = create()): GatewayProtocolState {
  const hello = receiveGatewayText(state, gatewayPayload(10, { heartbeat_interval: 1_000 }), {
    nowMs: 0,
    firstHeartbeatJitter: 1,
  });
  const identifying = beginGatewayHandshake(hello.state, { nowMs: 0, deadlineAtMs: 100 });
  expect(command(identifying, "send_gateway_event").event).toEqual({
    kind: "identify",
    opcode: 2,
  });
  return completeOnlySend(identifying);
}

function finishReady(state: GatewayProtocolState, sequence = 10): GatewayProtocolState {
  const ready = receiveGatewayText(
    state,
    dispatch("READY", sequence, {
      session_id: `session-${sequence}`,
      resume_gateway_url: `wss://resume.invalid/${sequence}`,
    }),
    { nowMs: 1 },
  );
  const persist = command(ready, "persist_ready_session");
  return completeGatewayEffect(ready.state, {
    effectId: persist.effectId,
    type: "ready_session_persistence",
    outcome: "persisted",
    session: new GatewaySessionHandle(`durable-session-${sequence}`),
  }).state;
}

function active(sequence = 10, state = create()): GatewayProtocolState {
  return finishReady(startFresh(state), sequence);
}

function startResume(checkpoint = 10): GatewayProtocolState {
  const initial = create({
    persistedSession: {
      handle: new GatewaySessionHandle("durable-session"),
      checkpoint,
    },
  });
  const hello = receiveGatewayText(initial, gatewayPayload(10, { heartbeat_interval: 1_000 }), {
    nowMs: 0,
    firstHeartbeatJitter: 1,
  });
  const resuming = beginGatewayHandshake(hello.state, { nowMs: 0, deadlineAtMs: 100 });
  const send = command(resuming, "send_gateway_event");
  expect(send.event).toMatchObject({ kind: "resume", opcode: 6, sequence: checkpoint });
  return completeOnlySend(resuming);
}

function completeCheckpoint(transition: GatewayTransition): GatewayProtocolState {
  const checkpoint = command(transition, "checkpoint_dispatch");
  return completeGatewayEffect(transition.state, {
    effectId: checkpoint.effectId,
    type: "checkpoint_persistence",
    outcome: "persisted",
  }).state;
}

function acceptThenCheckpoint(
  transition: GatewayTransition,
  outcome: "accepted" | "duplicate" = "accepted",
): GatewayProtocolState {
  const accept = command(transition, "accept_target_message");
  const checkpoint = completeGatewayEffect(transition.state, {
    effectId: accept.effectId,
    type: "target_acceptance",
    outcome,
  });
  return completeCheckpoint(checkpoint);
}

function recordIgnoredThenCheckpoint(transition: GatewayTransition): GatewayProtocolState {
  const ignored = command(transition, "record_ignored_dispatch");
  const checkpoint = completeGatewayEffect(transition.state, {
    effectId: ignored.effectId,
    type: "ignored_evidence",
    outcome: "recorded",
  });
  return completeCheckpoint(checkpoint);
}

function reopenForResume(state: GatewayProtocolState, nowMs: number): GatewayProtocolState {
  const opened = gatewayConnectionOpened(state, nowMs).state;
  const hello = receiveGatewayText(opened, gatewayPayload(10, { heartbeat_interval: 1_000 }), {
    nowMs,
    firstHeartbeatJitter: 1,
  }).state;
  return completeOnlySend(beginGatewayHandshake(hello, { nowMs, deadlineAtMs: nowMs + 100 }));
}

function withFullOutboundWindow(state: GatewayProtocolState, nowMs: number): GatewayProtocolState {
  let outbound = state.outbound;
  for (let index = outbound.connectionAuthorizationsMs.length; index < 120; index++) {
    const result = authorizeGatewayOutbound(outbound, {
      kind: "presence_update",
      nowMs,
      deadlineAtMs: nowMs,
    });
    if (!result.allowed) throw new Error("test_outbound_setup_failed");
    outbound = result.state;
  }
  return { ...state, outbound };
}

describe("Gateway lifecycle, heartbeat and reconnect policy", () => {
  it("models Hello and both deterministic first-heartbeat jitter boundaries", () => {
    const zero = receiveGatewayText(create(), gatewayPayload(10, { heartbeat_interval: 45_000 }), {
      nowMs: 1_000,
      firstHeartbeatJitter: 0,
    });
    expect(zero.state.phase).toBe("hello");
    expect(command(zero, "schedule_heartbeat")).toEqual({
      type: "schedule_heartbeat",
      atMs: 1_000,
      deadlineAtMs: 1_000,
      first: true,
    });

    const one = receiveGatewayText(create(), gatewayPayload(10, { heartbeat_interval: 45_000 }), {
      nowMs: 1_000,
      firstHeartbeatJitter: 1,
    });
    expect(command(one, "schedule_heartbeat").atMs).toBe(46_000);
  });

  it("sends regular and server-requested heartbeats through the common gate and accepts ACKs", () => {
    let state = startFresh();
    const regular = gatewayHeartbeatDue(state, 1_000);
    expect(command(regular, "send_gateway_event").event).toEqual({
      kind: "heartbeat_regular",
      opcode: 1,
      sequence: null,
    });
    expect(command(regular, "schedule_heartbeat").atMs).toBe(2_000);
    expect(regular.state.outbound.connectionAuthorizationsMs.at(-1)).toBe(1_000);
    expect(regular.state.outbound.lastObservedAtMs).toBe(1_000);
    state = completeOnlySend(regular);
    const ack = receiveGatewayText(state, gatewayPayload(11), { nowMs: 1_001 });
    expect(ack.state.heartbeat?.ackOutstanding).toBe(false);

    const requested = receiveGatewayText(ack.state, gatewayPayload(1), { nowMs: 1_002 });
    expect(command(requested, "send_gateway_event").event).toEqual({
      kind: "heartbeat_requested",
      opcode: 1,
      sequence: null,
    });
    expect(requested.state.outbound.connectionAuthorized).toBe(3); // IDENTIFY + two heartbeats.
  });

  it("halts a heartbeat observed after its deadline without backdating outbound pressure", () => {
    const state = startFresh();
    const authorizationTimes = [...state.outbound.connectionAuthorizationsMs];
    const telemetry = structuredClone(state.outbound.telemetry);

    const late = gatewayHeartbeatDue(state, 1_001);

    expect(late.state.phase).toBe("halted");
    expect(late.commands).toEqual([
      {
        type: "close_gateway_connection",
        code: 4000,
        cause: "local_policy_violation",
      },
    ]);
    expect(late.commands.some((candidate) => candidate.type === "send_gateway_event")).toBe(false);
    expect(late.diagnostics[0]?.category).toBe("local_gateway_outbound_safety_gate_violation");
    expect(late.state.outbound.connectionAuthorizationsMs).toEqual(authorizationTimes);
    expect(late.state.outbound.lastObservedAtMs).toBe(state.outbound.lastObservedAtMs);
    expect(late.state.outbound.telemetry).toEqual(telemetry);
  });

  it("accepts both ACKs when a requested heartbeat overlaps an outstanding regular heartbeat", () => {
    let state = startFresh();
    state = completeOnlySend(gatewayHeartbeatDue(state, 1_000));

    const requested = receiveGatewayText(state, gatewayPayload(1), { nowMs: 1_001 });
    expect(command(requested, "send_gateway_event").event.kind).toBe("heartbeat_requested");
    state = completeOnlySend(requested);
    expect(state.heartbeat?.ackOutstanding).toBe(true);

    const firstAck = receiveGatewayText(state, gatewayPayload(11), { nowMs: 1_002 });
    expect(firstAck.state.heartbeat?.ackOutstanding).toBe(false);
    const secondAck = receiveGatewayText(firstAck.state, gatewayPayload(11), { nowMs: 1_003 });

    expect(secondAck.state.phase).toBe("identifying");
    expect(secondAck.state.heartbeat?.ackOutstanding).toBe(false);
    expect(secondAck.commands).toEqual([]);
    expect(secondAck.diagnostics).toEqual([]);
  });

  it("uses the volatile last-received sequence for heartbeat semantics", () => {
    let state = active();
    const target = receiveGatewayText(state, dispatch("MESSAGE_CREATE", 17, message()), {
      nowMs: 2,
    });
    expect(target.state.lastCheckpointedSequence).toBe(10);
    expect(target.state.lastReceivedSequence).toBe(17);
    const requested = receiveGatewayText(target.state, gatewayPayload(1), { nowMs: 3 });
    expect(command(requested, "send_gateway_event").event).toMatchObject({
      kind: "heartbeat_requested",
      sequence: 17,
    });
  });

  it("closes non-normally and selects RESUME when a regular heartbeat ACK is missing", () => {
    const state = active();
    const first = gatewayHeartbeatDue(state, 1_000);
    const sent = completeOnlySend(first);
    const missed = gatewayHeartbeatDue(sent, 2_000);

    expect(missed.state.phase).toBe("reconnecting");
    expect(missed.state.connectionIntent).toBe("resume");
    expect(missed.commands).toEqual([
      {
        type: "close_gateway_connection",
        code: 4000,
        cause: "heartbeat_ack_missing",
      },
      { type: "reconnect_gateway", mode: "resume" },
    ]);
    expect(missed.diagnostics[0]?.category).toBe("heartbeat_ack_missing");
  });

  it("persists READY session material and sequence before becoming active", () => {
    const identifying = startFresh();
    const ready = receiveGatewayText(
      identifying,
      dispatch("READY", 93, {
        session_id: "opaque-session",
        resume_gateway_url: "wss://resume.invalid",
      }),
      { nowMs: 1 },
    );
    expect(ready.state).toMatchObject({
      phase: "ready",
      lastReceivedSequence: 93,
      lastCheckpointedSequence: null,
      pendingDispatchSequence: 93,
    });
    const persist = command(ready, "persist_ready_session");
    expect(persist.material.forPersistence()).toEqual({
      sessionId: "opaque-session",
      resumeGatewayUrl: "wss://resume.invalid",
    });

    const completed = completeGatewayEffect(ready.state, {
      effectId: persist.effectId,
      type: "ready_session_persistence",
      outcome: "persisted",
      session: new GatewaySessionHandle("ready-handle"),
    });
    expect(completed.state).toMatchObject({
      phase: "active",
      lastCheckpointedSequence: 93,
      pendingDispatchSequence: null,
    });
  });

  it("handles Opcode 7 and both Opcode 9 resumability values", () => {
    const state = active();
    const reconnect = receiveGatewayText(state, gatewayPayload(7), { nowMs: 2 });
    expect(reconnect.state).toMatchObject({ phase: "reconnecting", connectionIntent: "resume" });
    expect(command(reconnect, "reconnect_gateway").mode).toBe("resume");

    const resumable = receiveGatewayText(state, gatewayPayload(9, true), { nowMs: 2 });
    expect(command(resumable, "reconnect_gateway").mode).toBe("resume");

    const nonResumable = receiveGatewayText(state, gatewayPayload(9, false), { nowMs: 2 });
    const clear = command(nonResumable, "clear_gateway_session");
    expect(nonResumable.state).toMatchObject({
      phase: "non_resumable",
      lastCheckpointedSequence: 10,
    });
    expect(nonResumable.state.session).toBe(state.session);

    const failed = completeGatewayEffect(nonResumable.state, {
      effectId: clear.effectId,
      type: "session_clear",
      outcome: "ambiguous",
    });
    expect(failed.state.session).toBe(state.session);
    expect(failed.state.lastCheckpointedSequence).toBe(10);

    const prematureGatewayInput = receiveGatewayText(failed.state, gatewayPayload(7), {
      nowMs: 3,
    });
    expect(prematureGatewayInput.state.phase).toBe("non_resumable");
    expect(prematureGatewayInput.state.session).toBe(state.session);
    expect(prematureGatewayInput.commands.some((item) => item.type === "reconnect_gateway")).toBe(
      false,
    );

    const cleared = completeGatewayEffect(prematureGatewayInput.state, {
      effectId: clear.effectId,
      type: "session_clear",
      outcome: "cleared",
    });
    expect(cleared.state).toMatchObject({
      phase: "reconnecting",
      connectionIntent: "fresh",
      session: null,
      lastReceivedSequence: null,
      lastCheckpointedSequence: null,
    });
    expect(command(cleared, "reconnect_gateway").mode).toBe("fresh");
  });

  it("keeps the Opcode 9 d=false durable-clear fence across a connection close", () => {
    const state = active();
    const nonResumable = receiveGatewayText(state, gatewayPayload(9, false), { nowMs: 2 });
    const clear = command(nonResumable, "clear_gateway_session");

    const closedBeforeClear = gatewayConnectionClosed(nonResumable.state, 1006);
    expect(closedBeforeClear.state).toMatchObject({
      phase: "non_resumable",
      lastReceivedSequence: 10,
      lastCheckpointedSequence: 10,
      pendingEffect: {
        kind: "clear_session",
        effectId: clear.effectId,
        connectionClosed: true,
      },
    });
    expect(closedBeforeClear.state.session).toBe(state.session);
    expect(closedBeforeClear.commands).toEqual([]);
    expect(closedBeforeClear.diagnostics[0]?.category).toBe("gateway_close");

    const cleared = completeGatewayEffect(closedBeforeClear.state, {
      effectId: clear.effectId,
      type: "session_clear",
      outcome: "cleared",
    });
    expect(cleared.state).toMatchObject({
      phase: "reconnecting",
      connectionIntent: "fresh",
      session: null,
      lastReceivedSequence: null,
      lastCheckpointedSequence: null,
      pendingEffect: null,
    });
    expect(cleared.commands).toEqual([{ type: "reconnect_gateway", mode: "fresh" }]);

    const opened = gatewayConnectionOpened(cleared.state, 6_000);
    const hello = receiveGatewayText(
      opened.state,
      gatewayPayload(10, { heartbeat_interval: 10_000 }),
      { nowMs: 6_000, firstHeartbeatJitter: 1 },
    );
    const handshake = beginGatewayHandshake(hello.state, {
      nowMs: 6_000,
      deadlineAtMs: 6_000,
    });
    expect(command(handshake, "send_gateway_event").event).toEqual({
      kind: "identify",
      opcode: 2,
    });
  });

  it("classifies documented close-code groups and preserves the resume-first ADR policy", () => {
    expect(classifyGatewayCloseCode(null)).toMatchObject({
      category: "no_close_code",
      projectAction: "resume_if_available",
    });
    expect(classifyGatewayCloseCode(4008)).toMatchObject({
      category: "reconnectable",
      documentedSessionDisposition: "resume",
    });
    expect(classifyGatewayCloseCode(4007)).toMatchObject({
      category: "discord_recommends_new_session",
      documentedSessionDisposition: "new_session",
      projectAction: "resume_if_available",
    });
    expect(classifyGatewayCloseCode(4014)).toMatchObject({
      category: "fatal_configuration_or_authentication",
      projectAction: "halt",
    });
    expect(classifyGatewayCloseCode(1000).documentedSessionDisposition).toBe(
      "invalidated_by_normal_client_close",
    );

    const resumableClose = gatewayConnectionClosed(active(), 4009);
    expect(command(resumableClose, "reconnect_gateway").mode).toBe("resume");
    expect(gatewayConnectionClosed(active(), 4004).state.phase).toBe("halted");
  });

  it("accounts IDENTIFY separately and exposes its shard concurrency bucket", () => {
    const limit = { total: 7, remaining: 2, reset_after: 10_000, max_concurrency: 3 };
    const hello = receiveGatewayText(
      create({ sessionStartLimit: limit, shardId: 7 }),
      gatewayPayload(10, { heartbeat_interval: 1_000 }),
      { nowMs: 0, firstHeartbeatJitter: 1 },
    );
    expect(summarizeGatewayState(hello.state)).toMatchObject({
      identify: {
        total: 7,
        remaining: 2,
        resetAfterMs: 10_000,
        maxConcurrency: 3,
        shardId: 7,
        concurrencyBucket: 1,
        authorizedThisRun: 0,
      },
      outbound: { connectionAuthorized: 0 },
    });
    const identifying = beginGatewayHandshake(hello.state, { nowMs: 0, deadlineAtMs: 0 });
    expect(identifying.state.identify.remaining).toBe(1);
    expect(identifying.state.identify.authorizedThisRun).toBe(1);
    expect(identifying.state.outbound.connectionAuthorized).toBe(1);

    const heartbeat = gatewayHeartbeatDue(identifying.state, 1_000);
    expect(heartbeat.state.identify.remaining).toBe(1);
    expect(heartbeat.state.outbound.connectionAuthorized).toBe(2);

    const refreshed = updateGatewaySessionStartLimit(
      heartbeat.state,
      { total: 9, remaining: 8, reset_after: 20_000, max_concurrency: 2 },
      2_000,
    );
    expect(refreshed.identify).toMatchObject({
      total: 9,
      remaining: 8,
      resetAfterMs: 20_000,
      maxConcurrency: 2,
      shardId: 7,
      concurrencyBucket: 1,
      authorizedThisRun: 1,
    });
  });

  it("limits one shard bucket to one IDENTIFY every five seconds", () => {
    const limit = { total: 7, remaining: 7, reset_after: 10_000, max_concurrency: 3 };
    const firstHello = receiveGatewayText(
      create({ sessionStartLimit: limit, shardId: 4 }),
      gatewayPayload(10, { heartbeat_interval: 10_000 }),
      { nowMs: 0, firstHeartbeatJitter: 1 },
    );
    const firstIdentify = beginGatewayHandshake(firstHello.state, {
      nowMs: 0,
      deadlineAtMs: 0,
    });
    let state = completeOnlySend(firstIdentify);
    expect(state.identify).toMatchObject({
      maxConcurrency: 3,
      shardId: 4,
      concurrencyBucket: 1,
      remaining: 6,
    });

    state = gatewayConnectionClosed(state, 1006).state;
    state = gatewayConnectionOpened(state, 1_000).state;
    const secondHello = receiveGatewayText(
      state,
      gatewayPayload(10, { heartbeat_interval: 10_000 }),
      { nowMs: 1_000, firstHeartbeatJitter: 1 },
    );
    const scheduled = beginGatewayHandshake(secondHello.state, {
      nowMs: 1_000,
      deadlineAtMs: 5_000,
    });
    expect(scheduled.commands).toEqual([
      {
        type: "schedule_handshake",
        atMs: 5_000,
        deadlineAtMs: 5_000,
        mode: "identify",
      },
    ]);

    const secondIdentify = beginGatewayHandshake(scheduled.state, {
      nowMs: 5_000,
      deadlineAtMs: 5_000,
    });
    expect(command(secondIdentify, "send_gateway_event").event.kind).toBe("identify");
    expect(secondIdentify.state.identify.remaining).toBe(5);
  });

  it("schedules IDENTIFY within a deadline and fails closed when the session-start gate cannot fit", () => {
    const exhaustedLimit = { total: 2, remaining: 0, reset_after: 1_000, max_concurrency: 1 };
    const hello = receiveGatewayText(
      create({ sessionStartLimit: exhaustedLimit }),
      gatewayPayload(10, { heartbeat_interval: 2_000 }),
      { nowMs: 0, firstHeartbeatJitter: 1 },
    );
    const scheduled = beginGatewayHandshake(hello.state, { nowMs: 0, deadlineAtMs: 1_000 });
    expect(command(scheduled, "schedule_handshake")).toMatchObject({
      atMs: 1_000,
      mode: "identify",
    });
    const identifying = beginGatewayHandshake(scheduled.state, {
      nowMs: 1_000,
      deadlineAtMs: 1_000,
    });
    expect(identifying.state).toMatchObject({ phase: "identifying" });
    expect(identifying.state.identify.remaining).toBe(1);

    const impossible = beginGatewayHandshake(hello.state, { nowMs: 0, deadlineAtMs: 999 });
    expect(impossible.state.phase).toBe("halted");
    expect(impossible.commands.some((item) => item.type === "send_gateway_event")).toBe(false);
    expect(impossible.commands.some((item) => item.type === "reconnect_gateway")).toBe(false);
  });
});

describe("Dispatch sequencing and durable effect ordering", () => {
  it("processes non-contiguous 10, 17 and 93 normally without loss or reconnect semantics", () => {
    let state = active(10);
    const seventeen = receiveGatewayText(state, dispatch("GUILD_CREATE", 17), { nowMs: 2 });
    expect(seventeen.diagnostics).toEqual([]);
    expect(seventeen.commands.map((item) => item.type)).toEqual(["checkpoint_dispatch"]);
    state = completeCheckpoint(seventeen);

    const ninetyThree = receiveGatewayText(state, dispatch("CHANNEL_UPDATE", 93), { nowMs: 3 });
    expect(ninetyThree.diagnostics).toEqual([]);
    expect(JSON.stringify(ninetyThree)).not.toMatch(/loss|abort|reconnect|failure/);
    state = completeCheckpoint(ninetyThree);
    expect(state).toMatchObject({
      phase: "active",
      lastReceivedSequence: 93,
      lastCheckpointedSequence: 93,
    });
  });

  it("orders target acceptance before checkpoint persistence", () => {
    const state = active();
    const received = receiveGatewayText(state, dispatch("MESSAGE_CREATE", 17, message()), {
      nowMs: 2,
    });
    expect(received.commands.map((item) => item.type)).toEqual(["accept_target_message"]);
    expect(received.state.lastCheckpointedSequence).toBe(10);

    const accept = command(received, "accept_target_message");
    const accepted = completeGatewayEffect(received.state, {
      effectId: accept.effectId,
      type: "target_acceptance",
      outcome: "accepted",
    });
    expect(accepted.commands.map((item) => item.type)).toEqual(["checkpoint_dispatch"]);
    expect(accepted.state.lastCheckpointedSequence).toBe(10);

    const completed = completeCheckpoint(accepted);
    expect(completed.lastCheckpointedSequence).toBe(17);
  });

  it("normalizes IDs and preserves every RegistrationMessageEvent field only on the target effect", () => {
    const state = active(
      10,
      create({
        classifyMessage: (metadata) => {
          expect(metadata).not.toHaveProperty("content");
          return "target";
        },
      }),
    );
    const received = receiveGatewayText(
      state,
      dispatch(
        "MESSAGE_CREATE",
        17,
        message({
          id: 300,
          guild_id: 100,
          channel_id: 200,
          author: { id: 400, bot: true, system: false },
          webhook_id: 777,
          application_id: 888,
        }),
      ),
      { nowMs: 2 },
    );
    const accepted = command(received, "accept_target_message");
    expect(accepted.event).toEqual({
      event_id: "300",
      guild_id: "100",
      channel_id: "200",
      author_id: "400",
      author_is_bot: true,
      author_is_system: false,
      webhook_id: "777",
      application_id: "888",
      content: "123456 42 Name",
      created_at: "2026-09-10T10:00:00.000Z",
    });
  });

  it("records sanitized ignored MESSAGE_CREATE evidence before checkpointing", () => {
    const state = active();
    const received = receiveGatewayText(
      state,
      dispatch("MESSAGE_CREATE", 17, message({ channel_id: "201", content: "private" })),
      { nowMs: 2 },
    );
    const ignored = command(received, "record_ignored_dispatch");
    expect(ignored.evidence).toMatchObject({ reason: "not_target", event_id: "300" });
    expect(ignored.evidence).not.toHaveProperty("content");
    expect(received.state.lastCheckpointedSequence).toBe(10);

    const checkpoint = completeGatewayEffect(received.state, {
      effectId: ignored.effectId,
      type: "ignored_evidence",
      outcome: "recorded",
    });
    expect(checkpoint.state.lastCheckpointedSequence).toBe(10);
    expect(completeCheckpoint(checkpoint).lastCheckpointedSequence).toBe(17);
  });

  it("checkpoints non-target Dispatch without a business-ingestion effect", () => {
    const received = receiveGatewayText(active(), dispatch("GUILD_UPDATE", 17), { nowMs: 2 });
    expect(received.commands.map((item) => item.type)).toEqual(["checkpoint_dispatch"]);
    expect(completeCheckpoint(received).lastCheckpointedSequence).toBe(17);
  });

  it("suppresses equal replay and recovers from lower stale sequence without moving backward", () => {
    const state = active();
    const equal = receiveGatewayText(state, dispatch("MESSAGE_CREATE", 10, message()), {
      nowMs: 2,
    });
    expect(equal.commands).toEqual([]);
    expect(equal.diagnostics[0]).toMatchObject({
      category: "replayed_dispatch",
      sequenceRelation: "equal",
    });
    expect(equal.state.lastCheckpointedSequence).toBe(10);

    const lower = receiveGatewayText(state, dispatch("MESSAGE_CREATE", 9, message()), {
      nowMs: 2,
    });
    expect(lower.commands.some((item) => item.type === "accept_target_message")).toBe(false);
    expect(lower.state.lastCheckpointedSequence).toBe(10);
    expect(lower.state.lastReceivedSequence).toBe(10);
    expect(lower.state.phase).toBe("reconnecting");
  });

  it("rejects checkpoint regression/incomplete advancement and treats the same value as idempotent", () => {
    expect(
      decideCheckpointAdvance({
        lastCheckpointedSequence: 17,
        pendingDispatchSequence: 93,
        candidateSequence: 10,
        effectSucceeded: true,
      }),
    ).toBe("rejected_regression");
    expect(
      decideCheckpointAdvance({
        lastCheckpointedSequence: 17,
        pendingDispatchSequence: null,
        candidateSequence: 17,
        effectSucceeded: false,
      }),
    ).toBe("idempotent_noop");
    expect(
      decideCheckpointAdvance({
        lastCheckpointedSequence: 17,
        pendingDispatchSequence: 93,
        candidateSequence: 93,
        effectSucceeded: false,
      }),
    ).toBe("rejected_effect_incomplete");
    expect(
      decideCheckpointAdvance({
        lastCheckpointedSequence: 17,
        pendingDispatchSequence: 94,
        candidateSequence: 93,
        effectSucceeded: true,
      }),
    ).toBe("rejected_not_pending");
  });

  it("recovers from unknown target acceptance without checkpointing", () => {
    const received = receiveGatewayText(active(), dispatch("MESSAGE_CREATE", 17, message()), {
      nowMs: 2,
    });
    const accept = command(received, "accept_target_message");
    const ambiguous = completeGatewayEffect(received.state, {
      effectId: accept.effectId,
      type: "target_acceptance",
      outcome: "ambiguous",
    });
    expect(ambiguous.state).toMatchObject({
      phase: "reconnecting",
      connectionIntent: "resume",
      lastCheckpointedSequence: 10,
    });
    expect(ambiguous.commands.some((item) => item.type === "checkpoint_dispatch")).toBe(false);
  });

  it("replays an acceptance with a lost response through durable duplicate detection, then checkpoints", () => {
    const first = receiveGatewayText(active(), dispatch("MESSAGE_CREATE", 17, message()), {
      nowMs: 2,
    });
    const firstAccept = command(first, "accept_target_message");
    const unknown = completeGatewayEffect(first.state, {
      effectId: firstAccept.effectId,
      type: "target_acceptance",
      outcome: "ambiguous",
    });
    const resuming = reopenForResume(unknown.state, 3);
    const replay = receiveGatewayText(resuming, dispatch("MESSAGE_CREATE", 17, message()), {
      nowMs: 4,
    });
    expect(command(replay, "accept_target_message").event.event_id).toBe("300");
    const completed = acceptThenCheckpoint(replay, "duplicate");
    expect(completed).toMatchObject({ phase: "resuming", lastCheckpointedSequence: 17 });
  });

  it("invokes durable idempotency again for the same message ID under a later valid sequence", () => {
    let state = active();
    state = acceptThenCheckpoint(
      receiveGatewayText(state, dispatch("MESSAGE_CREATE", 17, message({ id: "555" })), {
        nowMs: 2,
      }),
    );
    const later = receiveGatewayText(
      state,
      dispatch("MESSAGE_CREATE", 93, message({ id: "555" })),
      { nowMs: 3 },
    );
    expect(command(later, "accept_target_message").event.event_id).toBe("555");
    expect(acceptThenCheckpoint(later, "duplicate").lastCheckpointedSequence).toBe(93);
  });

  it("does not advance after failed or ambiguous checkpoint persistence", () => {
    const received = receiveGatewayText(active(), dispatch("GUILD_UPDATE", 17), { nowMs: 2 });
    const checkpoint = command(received, "checkpoint_dispatch");
    for (const outcome of ["failed", "ambiguous"] as const) {
      const result = completeGatewayEffect(received.state, {
        effectId: checkpoint.effectId,
        type: "checkpoint_persistence",
        outcome,
      });
      expect(result.state).toMatchObject({
        phase: "reconnecting",
        lastCheckpointedSequence: 10,
      });
    }
  });

  it("rejects a second Dispatch while the first effect remains pending", () => {
    const first = receiveGatewayText(active(), dispatch("MESSAGE_CREATE", 17, message()), {
      nowMs: 2,
    });
    const overlap = receiveGatewayText(first.state, dispatch("MESSAGE_CREATE", 93, message()), {
      nowMs: 3,
    });
    expect(overlap.diagnostics[0]).toMatchObject({
      category: "overlapping_dispatch",
      sequenceRelation: "overlap",
    });
    expect(overlap.commands.filter((item) => item.type === "accept_target_message")).toHaveLength(
      0,
    );
    expect(overlap.state.lastCheckpointedSequence).toBe(10);
  });
});

describe("RESUME replay", () => {
  it("processes target, ignored and non-target replay before RESUMED with a checkpoint each", () => {
    let state = startResume(10);

    const target = receiveGatewayText(state, dispatch("MESSAGE_CREATE", 17, message()), {
      nowMs: 2,
    });
    state = acceptThenCheckpoint(target, "duplicate");
    expect(state).toMatchObject({ phase: "resuming", lastCheckpointedSequence: 17 });

    const ignored = receiveGatewayText(
      state,
      dispatch("MESSAGE_CREATE", 42, message({ channel_id: "201" })),
      { nowMs: 3 },
    );
    state = recordIgnoredThenCheckpoint(ignored);
    expect(state).toMatchObject({ phase: "resuming", lastCheckpointedSequence: 42 });

    const nonTarget = receiveGatewayText(state, dispatch("GUILD_UPDATE", 93), { nowMs: 4 });
    state = completeCheckpoint(nonTarget);
    expect(state).toMatchObject({ phase: "resuming", lastCheckpointedSequence: 93 });

    const resumed = receiveGatewayText(state, dispatch("RESUMED", 120), { nowMs: 5 });
    expect(resumed.state.phase).toBe("resumed");
    expect(resumed.state.lastCheckpointedSequence).toBe(93);
    state = completeCheckpoint(resumed);
    expect(state).toMatchObject({ phase: "active", lastCheckpointedSequence: 120 });
  });

  it("recovers from the latest durable checkpoint when replay fails before RESUMED", () => {
    let state = startResume(10);
    state = completeCheckpoint(
      receiveGatewayText(state, dispatch("GUILD_UPDATE", 17), { nowMs: 2 }),
    );
    const target = receiveGatewayText(state, dispatch("MESSAGE_CREATE", 93, message()), {
      nowMs: 3,
    });
    const accept = command(target, "accept_target_message");
    const failed = completeGatewayEffect(target.state, {
      effectId: accept.effectId,
      type: "target_acceptance",
      outcome: "failed",
    });
    expect(failed.state).toMatchObject({
      phase: "reconnecting",
      connectionIntent: "resume",
      lastCheckpointedSequence: 17,
    });
    expect(command(failed, "reconnect_gateway").mode).toBe("resume");
  });

  it("keeps an equal-sequence RESUMED in replay until a greater RESUMED checkpoint persists", () => {
    let state = startResume(10);
    const equal = receiveGatewayText(state, dispatch("RESUMED", 10), { nowMs: 2 });
    expect(equal.state).toMatchObject({
      phase: "resuming",
      lastReceivedSequence: 10,
      lastCheckpointedSequence: 10,
      replayTelemetryCount: 1,
    });
    expect(equal.commands).toEqual([]);
    expect(equal.diagnostics[0]).toMatchObject({
      category: "replayed_dispatch",
      sequenceRelation: "equal",
    });

    const greater = receiveGatewayText(equal.state, dispatch("RESUMED", 17), { nowMs: 3 });
    expect(greater.state).toMatchObject({
      phase: "resumed",
      lastCheckpointedSequence: 10,
      pendingDispatchSequence: 17,
    });
    state = completeCheckpoint(greater);
    expect(state).toMatchObject({
      phase: "active",
      lastCheckpointedSequence: 17,
      pendingDispatchSequence: null,
    });
  });

  it("keeps fresh pre-READY Dispatch invalid while accepting the equivalent replay Dispatch", () => {
    const fresh = receiveGatewayText(startFresh(), dispatch("GUILD_UPDATE", 17), { nowMs: 2 });
    expect(fresh.diagnostics[0]?.category).toBe("dispatch_before_ready");
    expect(fresh.commands.some((item) => item.type === "checkpoint_dispatch")).toBe(false);

    const replay = receiveGatewayText(startResume(), dispatch("GUILD_UPDATE", 17), { nowMs: 2 });
    expect(replay.diagnostics).toEqual([]);
    expect(replay.commands.map((item) => item.type)).toEqual(["checkpoint_dispatch"]);
  });
});

describe("malformed, impossible and redacted inputs", () => {
  it("fails closed for malformed JSON/envelopes, invalid opcode shapes and unknown opcodes", () => {
    const malformedJson = receiveGatewayText(active(), "{", { nowMs: 2 });
    expect(malformedJson.diagnostics[0]?.category).toBe("malformed_gateway_payload");
    expect(malformedJson.state.phase).toBe("reconnecting");

    const malformedEnvelope = receiveGatewayText(active(), JSON.stringify({ d: null }), {
      nowMs: 2,
    });
    expect(malformedEnvelope.diagnostics[0]?.category).toBe("malformed_gateway_payload");

    const invalidShape = receiveGatewayText(active(), gatewayPayload(9, "true"), { nowMs: 2 });
    expect(invalidShape.diagnostics[0]?.category).toBe("invalid_opcode_shape");

    const missingSequence = receiveGatewayText(
      active(),
      JSON.stringify({ op: 0, t: "MESSAGE_CREATE", d: message() }),
      { nowMs: 2 },
    );
    expect(missingSequence.diagnostics[0]?.category).toBe("invalid_opcode_shape");
    expect(missingSequence.state.lastCheckpointedSequence).toBe(10);

    const unknown = receiveGatewayText(active(), gatewayPayload(999, { anything: true }), {
      nowMs: 2,
    });
    expect(unknown.diagnostics[0]).toMatchObject({
      category: "unknown_opcode",
      knownOpcodeCategory: "unknown",
    });
    expect(unknown.state.session).not.toBeNull();
    expect(unknown.state.lastCheckpointedSequence).toBe(10);
  });

  it("detects duplicate Hello, impossible effect completion and bounds repeated malformed recovery", () => {
    const hello = receiveGatewayText(create(), gatewayPayload(10, { heartbeat_interval: 1_000 }), {
      nowMs: 0,
      firstHeartbeatJitter: 0.5,
    });
    const duplicate = receiveGatewayText(
      hello.state,
      gatewayPayload(10, { heartbeat_interval: 1_000 }),
      { nowMs: 1, firstHeartbeatJitter: 0.5 },
    );
    expect(duplicate.diagnostics[0]?.category).toBe("duplicate_hello");

    const impossible = completeGatewayEffect(active(), {
      effectId: 999,
      type: "checkpoint_persistence",
      outcome: "persisted",
    });
    expect(impossible.diagnostics[0]?.category).toBe("impossible_effect_completion");

    let state = receiveGatewayText(active(), "not-json", { nowMs: 2 }).state;
    expect(state.phase).toBe("reconnecting");
    state = gatewayConnectionOpened(state, 3).state;
    state = receiveGatewayText(state, "not-json", { nowMs: 3 }).state;
    expect(state.phase).toBe("reconnecting");
    state = gatewayConnectionOpened(state, 4).state;
    const third = receiveGatewayText(state, "not-json", { nowMs: 4 });
    expect(third.state.phase).toBe("halted");
    expect(third.diagnostics[0]?.occurrenceCount).toBe(3);
    expect(third.commands.some((item) => item.type === "reconnect_gateway")).toBe(false);
    expect(receiveGatewayText(third.state, gatewayPayload(7), { nowMs: 5 }).state.phase).toBe(
      "halted",
    );
    expect(gatewayConnectionClosed(third.state, 4000).state.phase).toBe("halted");
  });

  it("never exposes canary values through diagnostics, summaries, errors or serialized snapshots", () => {
    const canary = "CANARY_DO_NOT_EXPOSE_7f91";
    const identifying = startFresh();
    const ready = receiveGatewayText(
      identifying,
      dispatch("READY", 10, {
        session_id: `${canary}-session`,
        resume_gateway_url: `wss://${canary}.invalid`,
        token: `${canary}-token-like`,
        raw: canary,
      }),
      { nowMs: 1 },
    );
    expect(JSON.stringify(ready)).not.toContain(canary);
    expect(command(ready, "persist_ready_session")).toBeInstanceOf(PersistReadySessionCommand);

    const persist = command(ready, "persist_ready_session");
    const activated = completeGatewayEffect(ready.state, {
      effectId: persist.effectId,
      type: "ready_session_persistence",
      outcome: "persisted",
      session: new GatewaySessionHandle(`${canary}-persistence-handle`),
    });
    expect(JSON.stringify(activated.state)).not.toContain(canary);
    expect(JSON.stringify(summarizeGatewayState(activated.state))).not.toContain(canary);

    const target = receiveGatewayText(
      activated.state,
      dispatch("MESSAGE_CREATE", 17, message({ content: canary, raw: canary })),
      { nowMs: 2 },
    );
    expect(command(target, "accept_target_message")).toBeInstanceOf(AcceptTargetMessageCommand);
    expect(command(target, "accept_target_message").event.content).toBe(canary);
    expect(JSON.stringify(target)).not.toContain(canary);

    const ignoredIdCanary = "987654321098765432";
    const ignored = receiveGatewayText(
      activated.state,
      dispatch(
        "MESSAGE_CREATE",
        18,
        message({
          channel_id: ignoredIdCanary,
          author: { id: ignoredIdCanary, bot: false, system: false },
          content: canary,
        }),
      ),
      { nowMs: 2 },
    );
    expect(JSON.stringify(ignored)).not.toContain(canary);
    expect(JSON.stringify(ignored)).not.toContain(ignoredIdCanary);

    const accept = command(target, "accept_target_message");
    const exceptionLikeCompletion = {
      effectId: accept.effectId,
      type: "target_acceptance",
      outcome: "ambiguous",
      error: `${canary}-exception`,
    } as const;
    const failed = completeGatewayEffect(target.state, exceptionLikeCompletion);
    expect(JSON.stringify(failed)).not.toContain(canary);

    const unknown = receiveGatewayText(
      activated.state,
      JSON.stringify({ op: 999, d: { authorization: canary, payload: canary } }),
      { nowMs: 3 },
    );
    expect(JSON.stringify(unknown)).not.toContain(canary);
  });

  it("exposes no bot-token or authorization-header field in the core configuration API", () => {
    type ForbiddenKey = Extract<
      keyof CreateGatewayProtocolOptions,
      "token" | "botToken" | "authorization" | "authorizationHeader"
    >;
    const hasNoForbiddenKey: ForbiddenKey extends never ? true : false = true;
    expect(hasNoForbiddenKey).toBe(true);
    expect(Object.keys(create())).not.toEqual(
      expect.arrayContaining(["token", "botToken", "authorization", "authorizationHeader"]),
    );
  });

  it("rehydrates only serializable safety state without resetting IDENTIFY protection", () => {
    const limited = create({
      sessionStartLimit: {
        total: 1,
        remaining: 1,
        reset_after: 86_400_000,
        max_concurrency: 1,
      },
    });
    const hello = receiveGatewayText(limited, gatewayPayload(10, { heartbeat_interval: 1_000 }), {
      nowMs: 0,
      firstHeartbeatJitter: 0,
    });
    const identifying = beginGatewayHandshake(hello.state, { nowMs: 0, deadlineAtMs: 100 });
    const safety = snapshotGatewayProtocolSafety(identifying.state);
    const reconstructed = createGatewayProtocolState({
      sessionStartLimit: LIMIT,
      sessionStartLimitObservedAtMs: 0,
      classifyMessage: CLASSIFY_MESSAGE,
      connectionGeneration: 2,
      persistedSafety: safety,
    });
    const nextHello = receiveGatewayText(
      reconstructed,
      gatewayPayload(10, { heartbeat_interval: 1_000 }),
      { nowMs: 1, firstHeartbeatJitter: 0 },
    );
    const denied = beginGatewayHandshake(nextHello.state, { nowMs: 1, deadlineAtMs: 101 });

    expect(denied.state.phase).toBe("halted");
    expect(denied.commands.some((item) => item.type === "send_gateway_event")).toBe(false);
    expect(JSON.stringify(safety)).not.toMatch(/session|resume_gateway_url|classifyMessage/);

    const invalid = {
      ...safety,
      outbound: {
        ...safety.outbound,
        telemetry: {
          ...safety.outbound.telemetry,
          authorizedByKind: { ...safety.outbound.telemetry.authorizedByKind, resume: -1 },
        },
      },
    };
    expect(() =>
      createGatewayProtocolState({
        sessionStartLimit: LIMIT,
        sessionStartLimitObservedAtMs: 0,
        classifyMessage: CLASSIFY_MESSAGE,
        connectionGeneration: 2,
        persistedSafety: invalid,
      }),
    ).toThrow("invalid_gateway_safety_snapshot");
  });
});

describe("protocol integration with the outbound safety gate", () => {
  it.each([
    ["heartbeat", (state: GatewayProtocolState) => gatewayHeartbeatDue(state, 1_000)],
    [
      "additional outbound",
      (state: GatewayProtocolState) =>
        requestGatewayOutbound(state, {
          kind: "presence_update",
          nowMs: 1_000,
          deadlineAtMs: 1_000,
        }),
    ],
  ] as const)("halts without a send or reconnect when %s cannot fit its deadline", (_name, run) => {
    const result = run(withFullOutboundWindow(active(), 1_000));
    expect(result.state.phase).toBe("halted");
    expect(result.commands.some((item) => item.type === "send_gateway_event")).toBe(false);
    expect(result.commands.some((item) => item.type === "reconnect_gateway")).toBe(false);
    expect(result.diagnostics[0]?.category).toBe("local_gateway_outbound_safety_gate_violation");
  });

  it.each(["identify", "resume"] as const)(
    "halts without sending or reconnecting when %s exhausts its outbound budget",
    (mode) => {
      const initial =
        mode === "identify"
          ? create()
          : create({
              persistedSession: {
                handle: new GatewaySessionHandle("durable"),
                checkpoint: 10,
              },
            });
      const hello = receiveGatewayText(initial, gatewayPayload(10, { heartbeat_interval: 1_000 }), {
        nowMs: 0,
        firstHeartbeatJitter: 1,
      });
      const result = beginGatewayHandshake(withFullOutboundWindow(hello.state, 0), {
        nowMs: 0,
        deadlineAtMs: 0,
      });
      expect(result.state.phase).toBe("halted");
      expect(result.commands.some((item) => item.type === "send_gateway_event")).toBe(false);
      expect(result.commands.some((item) => item.type === "reconnect_gateway")).toBe(false);
    },
  );

  it("counts every supported protocol send and no received Dispatch or ACK", () => {
    let state = active();
    const before = state.outbound.connectionAuthorized;
    const dispatchOnly = receiveGatewayText(state, dispatch("GUILD_UPDATE", 17), { nowMs: 2 });
    expect(dispatchOnly.state.outbound.connectionAuthorized).toBe(before);
    state = completeCheckpoint(dispatchOnly);

    const requested = requestGatewayOutbound(state, {
      kind: "request_guild_members",
      nowMs: 10,
      deadlineAtMs: 10,
    });
    expect(command(requested, "send_gateway_event")).toBeInstanceOf(SendGatewayEventCommand);
    expect(requested.state.outbound.connectionAuthorized).toBe(before + 1);
  });

  it("keeps failed and ambiguous transport authorizations counted while recovering", () => {
    const requested = requestGatewayOutbound(active(), {
      kind: "voice_state_update",
      nowMs: 10,
      deadlineAtMs: 10,
    });
    const send = command(requested, "send_gateway_event");
    const failed = completeGatewayOutbound(requested.state, {
      authorizationId: send.authorizationId,
      result: "ambiguous",
    });
    expect(failed.state.outbound.connectionAuthorizationsMs).toContain(10);
    expect(failed.state.outbound.telemetry.ambiguous).toBe(1);
    expect(failed.state.phase).toBe("reconnecting");
  });
});

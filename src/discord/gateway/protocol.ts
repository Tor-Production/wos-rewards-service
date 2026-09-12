import type { RegistrationMessageEvent } from "../../domain/discord-event";
import {
  authorizeGatewayOutbound,
  createGatewayOutboundRateState,
  recordGatewayOutboundResult,
  startGatewayConnectionGeneration,
  type GatewayOutboundRateState,
} from "./outbound-rate";
import { classifyGatewayCloseCode } from "./reconnect-policy";
import {
  AcceptTargetMessageCommand,
  GatewaySessionHandle,
  OpaqueGatewaySessionMaterial,
  PersistReadySessionCommand,
  SendGatewayEventCommand,
  type CheckpointDispatchCommand,
  type ClearSessionCommand,
  type CloseGatewayConnectionCommand,
  type GatewayCommand,
  type GatewayDiagnostic,
  type GatewayDiagnosticCategory,
  type GatewayEffectCompletion,
  type GatewayLifecycle,
  type GatewayMessageClassifier,
  type GatewayMessageMetadata,
  type GatewayOpcodeCategory,
  type GatewayOutboundEvent,
  type GatewaySendKind,
  type GatewaySequenceRelation,
  type GatewaySessionStartLimit,
  type GatewayStateSummary,
  type GatewayTransportResult,
  type IgnoredMessageEvidence,
  type IgnoredMessageReason,
  type RecordIgnoredDispatchCommand,
} from "./types";

const MALFORMED_HALT_THRESHOLD = 3;
const MAX_REPLAY_TELEMETRY = 64;
const IDENTIFY_CONCURRENCY_WINDOW_MS = 5_000;

interface HeartbeatState {
  readonly intervalMs: number;
  readonly nextAtMs: number;
  readonly ackOutstanding: boolean;
}

interface IdentifyState {
  readonly total: number;
  readonly remaining: number;
  readonly resetAfterMs: number;
  readonly resetAtMs: number;
  readonly maxConcurrency: number;
  readonly shardId: number;
  readonly concurrencyBucket: number;
  readonly lastBucketAuthorizationAtMs: number | null;
  readonly authorizedThisRun: number;
}

interface ViolationTracker {
  readonly checkpoint: number | null;
  readonly count: number;
}

interface PendingReadyPersistence {
  readonly kind: "persist_ready";
  readonly effectId: number;
  readonly sequence: number;
}

interface PendingTargetAcceptance {
  readonly kind: "accept_target";
  readonly effectId: number;
  readonly sequence: number;
  readonly phaseAfterCheckpoint: "active" | "resuming";
}

interface PendingIgnoredEvidence {
  readonly kind: "record_ignored";
  readonly effectId: number;
  readonly sequence: number;
  readonly phaseAfterCheckpoint: "active" | "resuming";
}

interface PendingCheckpoint {
  readonly kind: "checkpoint";
  readonly effectId: number;
  readonly sequence: number;
  readonly phaseAfterCheckpoint: "active" | "resuming";
}

interface PendingSessionClear {
  readonly kind: "clear_session";
  readonly effectId: number;
  readonly connectionClosed: boolean;
}

export type PendingGatewayEffect =
  | PendingReadyPersistence
  | PendingTargetAcceptance
  | PendingIgnoredEvidence
  | PendingCheckpoint
  | PendingSessionClear;

interface OutstandingOutbound {
  readonly authorizationId: number;
  readonly kind: GatewaySendKind;
}

export interface GatewayProtocolState {
  readonly phase: GatewayLifecycle;
  readonly connectionGeneration: number;
  readonly connectionIntent: "fresh" | "resume";
  readonly heartbeat: HeartbeatState | null;
  readonly lastReceivedSequence: number | null;
  readonly lastCheckpointedSequence: number | null;
  readonly pendingDispatchSequence: number | null;
  readonly session: GatewaySessionHandle | null;
  readonly pendingEffect: PendingGatewayEffect | null;
  readonly outstandingOutbound: readonly OutstandingOutbound[];
  readonly identify: IdentifyState;
  readonly outbound: GatewayOutboundRateState;
  readonly classifyMessage: GatewayMessageClassifier;
  readonly violationTracker: ViolationTracker;
  readonly replayTelemetryCount: number;
  readonly nextId: number;
  toJSON(): GatewayStateSummary;
}

export interface GatewayTransition {
  readonly state: GatewayProtocolState;
  readonly commands: readonly GatewayCommand[];
  readonly diagnostics: readonly GatewayDiagnostic[];
}

export interface CreateGatewayProtocolOptions {
  readonly sessionStartLimit: GatewaySessionStartLimit;
  readonly sessionStartLimitObservedAtMs: number;
  readonly classifyMessage: GatewayMessageClassifier;
  readonly connectionGeneration?: number;
  /** Discord's unsharded default is shard 0. */
  readonly shardId?: number;
  readonly persistedSession?: Readonly<{
    handle: GatewaySessionHandle;
    checkpoint: number;
  }>;
}

export interface ReceiveGatewayTextInput {
  readonly nowMs: number;
  /** Required only by Hello; ignored for every other receive opcode. */
  readonly firstHeartbeatJitter?: number;
}

export interface CheckpointAdvanceInput {
  readonly lastCheckpointedSequence: number | null;
  readonly pendingDispatchSequence: number | null;
  readonly candidateSequence: number;
  readonly effectSucceeded: boolean;
}

export type CheckpointAdvanceDecision =
  | "advanced"
  | "idempotent_noop"
  | "rejected_regression"
  | "rejected_not_pending"
  | "rejected_effect_incomplete";

const stateToJSON = function (this: GatewayProtocolState): GatewayStateSummary {
  return summarizeGatewayState(this);
};

function evolve(
  state: GatewayProtocolState,
  patch: Partial<Omit<GatewayProtocolState, "toJSON">>,
): GatewayProtocolState {
  return { ...state, ...patch, toJSON: stateToJSON };
}

function emptyTransition(state: GatewayProtocolState): GatewayTransition {
  return { state, commands: [], diagnostics: [] };
}

function validTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateSessionStartLimit(limit: GatewaySessionStartLimit): void {
  if (
    !Number.isSafeInteger(limit.total) ||
    limit.total < 0 ||
    !Number.isSafeInteger(limit.remaining) ||
    limit.remaining < 0 ||
    limit.remaining > limit.total ||
    !Number.isSafeInteger(limit.reset_after) ||
    limit.reset_after <= 0 ||
    !Number.isSafeInteger(limit.max_concurrency) ||
    limit.max_concurrency < 1
  )
    throw new RangeError("invalid_gateway_session_start_limit");
}

function makeIdentifyState(
  limit: GatewaySessionStartLimit,
  observedAtMs: number,
  shardId: number,
  previous?: IdentifyState,
): IdentifyState {
  validateSessionStartLimit(limit);
  if (!validTime(observedAtMs)) throw new RangeError("invalid_gateway_time");
  if (!Number.isSafeInteger(shardId) || shardId < 0)
    throw new RangeError("invalid_gateway_shard_id");
  return {
    total: limit.total,
    remaining: limit.remaining,
    resetAfterMs: limit.reset_after,
    resetAtMs: observedAtMs + limit.reset_after,
    maxConcurrency: limit.max_concurrency,
    shardId,
    concurrencyBucket: shardId % limit.max_concurrency,
    lastBucketAuthorizationAtMs: previous?.lastBucketAuthorizationAtMs ?? null,
    authorizedThisRun: previous?.authorizedThisRun ?? 0,
  };
}

export function createGatewayProtocolState(
  options: CreateGatewayProtocolOptions,
): GatewayProtocolState {
  const generation = options.connectionGeneration ?? 1;
  if (!Number.isSafeInteger(generation) || generation < 1)
    throw new RangeError("invalid_connection_generation");
  if (options.persistedSession && !validSequence(options.persistedSession.checkpoint))
    throw new RangeError("invalid_gateway_checkpoint");
  if (typeof options.classifyMessage !== "function")
    throw new TypeError("invalid_gateway_message_classifier");

  const checkpoint = options.persistedSession?.checkpoint ?? null;
  return {
    phase: "connecting",
    connectionGeneration: generation,
    connectionIntent: options.persistedSession ? "resume" : "fresh",
    heartbeat: null,
    lastReceivedSequence: checkpoint,
    lastCheckpointedSequence: checkpoint,
    pendingDispatchSequence: null,
    session: options.persistedSession?.handle ?? null,
    pendingEffect: null,
    outstandingOutbound: [],
    identify: makeIdentifyState(
      options.sessionStartLimit,
      options.sessionStartLimitObservedAtMs,
      options.shardId ?? 0,
    ),
    outbound: createGatewayOutboundRateState(generation),
    classifyMessage: options.classifyMessage,
    violationTracker: { checkpoint, count: 0 },
    replayTelemetryCount: 0,
    nextId: 1,
    toJSON: stateToJSON,
  };
}

export function summarizeGatewayState(state: GatewayProtocolState): GatewayStateSummary {
  return {
    phase: state.phase,
    connectionGeneration: state.connectionGeneration,
    connectionIntent: state.connectionIntent,
    hasDurableSession: state.session !== null,
    hasCheckpoint: state.lastCheckpointedSequence !== null,
    hasPendingDispatch: state.pendingDispatchSequence !== null,
    heartbeatAckOutstanding: state.heartbeat?.ackOutstanding ?? false,
    malformedAtCheckpointCount: state.violationTracker.count,
    replayTelemetryCount: state.replayTelemetryCount,
    identify: {
      total: state.identify.total,
      remaining: state.identify.remaining,
      resetAfterMs: state.identify.resetAfterMs,
      maxConcurrency: state.identify.maxConcurrency,
      shardId: state.identify.shardId,
      concurrencyBucket: state.identify.concurrencyBucket,
      authorizedThisRun: state.identify.authorizedThisRun,
    },
    outbound: {
      connectionAuthorized: state.outbound.connectionAuthorized,
      runAuthorized: state.outbound.telemetry.authorized,
      runDenied: state.outbound.telemetry.denied,
      failed: state.outbound.telemetry.failed,
      ambiguous: state.outbound.telemetry.ambiguous,
    },
  };
}

function diagnostic(
  state: GatewayProtocolState,
  category: GatewayDiagnosticCategory,
  occurrenceCount = 1,
  knownOpcodeCategory?: GatewayOpcodeCategory,
  sequenceRelation?: GatewaySequenceRelation,
): GatewayDiagnostic {
  return {
    category,
    state: state.phase,
    connectionGeneration: state.connectionGeneration,
    occurrenceCount,
    ...(knownOpcodeCategory === undefined ? {} : { knownOpcodeCategory }),
    ...(sequenceRelation === undefined ? {} : { sequenceRelation }),
  };
}

function closeCommand(
  cause: CloseGatewayConnectionCommand["cause"],
): CloseGatewayConnectionCommand {
  return { type: "close_gateway_connection", code: 4000, cause };
}

function recoveryMode(state: GatewayProtocolState): "resume" | "fresh" {
  return state.session !== null && state.lastCheckpointedSequence !== null ? "resume" : "fresh";
}

function recover(
  state: GatewayProtocolState,
  cause: CloseGatewayConnectionCommand["cause"],
  alreadyClosed: boolean,
  diagnostics: readonly GatewayDiagnostic[],
): GatewayTransition {
  const mode = recoveryMode(state);
  const next = evolve(state, {
    phase: "reconnecting",
    connectionIntent: mode,
    heartbeat: null,
    pendingEffect: null,
    pendingDispatchSequence: null,
    outstandingOutbound: [],
  });
  return {
    state: next,
    commands: [
      ...(alreadyClosed ? [] : [closeCommand(cause)]),
      { type: "reconnect_gateway", mode },
    ],
    diagnostics,
  };
}

function haltForLocalPolicy(
  state: GatewayProtocolState,
  category:
    "local_gateway_outbound_safety_gate_violation" | "identify_session_start_limit_violation",
): GatewayTransition {
  return {
    state: evolve(state, {
      phase: "halted",
      heartbeat: null,
      pendingEffect: null,
      pendingDispatchSequence: null,
      outstandingOutbound: [],
    }),
    commands: [closeCommand("local_policy_violation")],
    diagnostics: [diagnostic(state, category)],
  };
}

function protocolViolation(
  state: GatewayProtocolState,
  category: GatewayDiagnosticCategory,
  knownOpcodeCategory?: GatewayOpcodeCategory,
  sequenceRelation?: GatewaySequenceRelation,
): GatewayTransition {
  const sameCheckpoint = state.violationTracker.checkpoint === state.lastCheckpointedSequence;
  const count = sameCheckpoint ? state.violationTracker.count + 1 : 1;
  const tracked = evolve(state, {
    violationTracker: { checkpoint: state.lastCheckpointedSequence, count },
  });
  const report = diagnostic(state, category, count, knownOpcodeCategory, sequenceRelation);
  if (state.phase === "halted") return { state, commands: [], diagnostics: [report] };
  if (state.phase === "non_resumable")
    return { state: tracked, commands: [], diagnostics: [report] };
  if (count >= MALFORMED_HALT_THRESHOLD)
    return {
      state: evolve(tracked, {
        phase: "halted",
        heartbeat: null,
        pendingEffect: null,
        pendingDispatchSequence: null,
        outstandingOutbound: [],
      }),
      commands: [closeCommand("protocol_violation")],
      diagnostics: [report],
    };
  return recover(tracked, "protocol_violation", false, [report]);
}

export function updateGatewaySessionStartLimit(
  state: GatewayProtocolState,
  limit: GatewaySessionStartLimit,
  observedAtMs: number,
): GatewayProtocolState {
  return evolve(state, {
    identify: makeIdentifyState(limit, observedAtMs, state.identify.shardId, state.identify),
  });
}

function refreshIdentify(state: IdentifyState, nowMs: number): IdentifyState {
  const lastBucketAuthorizationAtMs =
    state.lastBucketAuthorizationAtMs !== null &&
    state.lastBucketAuthorizationAtMs > nowMs - IDENTIFY_CONCURRENCY_WINDOW_MS
      ? state.lastBucketAuthorizationAtMs
      : null;
  if (nowMs < state.resetAtMs) return { ...state, lastBucketAuthorizationAtMs };
  return {
    ...state,
    remaining: state.total,
    resetAtMs: nowMs + state.resetAfterMs,
    lastBucketAuthorizationAtMs,
  };
}

interface OutboundAuthorization {
  readonly allowed: true;
  readonly state: GatewayProtocolState;
  readonly command: SendGatewayEventCommand;
}

interface OutboundDenial {
  readonly allowed: false;
  readonly state: GatewayProtocolState;
  readonly retryAtMs: number | null;
}

function authorizeOutbound(
  state: GatewayProtocolState,
  event: GatewayOutboundEvent,
  nowMs: number,
  deadlineAtMs: number,
): OutboundAuthorization | OutboundDenial {
  const decision = authorizeGatewayOutbound(state.outbound, {
    kind: event.kind,
    nowMs,
    deadlineAtMs,
  });
  if (!decision.allowed)
    return {
      allowed: false,
      state: evolve(state, { outbound: decision.state }),
      retryAtMs: decision.retryAtMs,
    };

  const authorizationId = state.nextId;
  const next = evolve(state, {
    outbound: decision.state,
    nextId: authorizationId + 1,
    outstandingOutbound: [...state.outstandingOutbound, { authorizationId, kind: event.kind }],
  });
  return {
    allowed: true,
    state: next,
    command: new SendGatewayEventCommand(authorizationId, state.connectionGeneration, event),
  };
}

function nextIdentifyAvailability(state: IdentifyState, nowMs: number): number {
  const sessionLimitReadyAt = state.remaining <= 0 ? state.resetAtMs : nowMs;
  const bucketReadyAt =
    state.lastBucketAuthorizationAtMs === null
      ? nowMs
      : state.lastBucketAuthorizationAtMs + IDENTIFY_CONCURRENCY_WINDOW_MS;
  return Math.max(sessionLimitReadyAt, bucketReadyAt);
}

export function beginGatewayHandshake(
  state: GatewayProtocolState,
  input: Readonly<{ nowMs: number; deadlineAtMs: number }>,
): GatewayTransition {
  if (!validTime(input.nowMs) || !validTime(input.deadlineAtMs))
    throw new RangeError("invalid_gateway_time");
  if (state.phase !== "hello") return protocolViolation(state, "illegal_lifecycle_transition");

  if (state.connectionIntent === "resume") {
    if (state.session === null || state.lastCheckpointedSequence === null)
      return protocolViolation(state, "illegal_lifecycle_transition");
    const result = authorizeOutbound(
      state,
      {
        kind: "resume",
        opcode: 6,
        sequence: state.lastCheckpointedSequence,
        session: state.session,
      },
      input.nowMs,
      input.deadlineAtMs,
    );
    if (!result.allowed) {
      if (result.retryAtMs !== null && result.retryAtMs <= input.deadlineAtMs)
        return {
          state: result.state,
          commands: [
            {
              type: "schedule_handshake",
              atMs: result.retryAtMs,
              deadlineAtMs: input.deadlineAtMs,
              mode: "resume",
            },
          ],
          diagnostics: [],
        };
      return haltForLocalPolicy(result.state, "local_gateway_outbound_safety_gate_violation");
    }
    return {
      state: evolve(result.state, { phase: "resuming" }),
      commands: [result.command],
      diagnostics: [],
    };
  }

  const identify = refreshIdentify(state.identify, input.nowMs);
  const identifyReadyAt = nextIdentifyAvailability(identify, input.nowMs);
  const refreshed = evolve(state, { identify });
  if (identifyReadyAt > input.deadlineAtMs)
    return haltForLocalPolicy(refreshed, "identify_session_start_limit_violation");
  if (identifyReadyAt > input.nowMs)
    return {
      state: refreshed,
      commands: [
        {
          type: "schedule_handshake",
          atMs: identifyReadyAt,
          deadlineAtMs: input.deadlineAtMs,
          mode: "identify",
        },
      ],
      diagnostics: [],
    };

  const result = authorizeOutbound(
    refreshed,
    { kind: "identify", opcode: 2 },
    input.nowMs,
    input.deadlineAtMs,
  );
  if (!result.allowed) {
    if (result.retryAtMs !== null && result.retryAtMs <= input.deadlineAtMs)
      return {
        state: result.state,
        commands: [
          {
            type: "schedule_handshake",
            atMs: result.retryAtMs,
            deadlineAtMs: input.deadlineAtMs,
            mode: "identify",
          },
        ],
        diagnostics: [],
      };
    return haltForLocalPolicy(result.state, "local_gateway_outbound_safety_gate_violation");
  }

  return {
    state: evolve(result.state, {
      phase: "identifying",
      identify: {
        ...identify,
        remaining: identify.remaining - 1,
        lastBucketAuthorizationAtMs: input.nowMs,
        authorizedThisRun: identify.authorizedThisRun + 1,
      },
    }),
    commands: [result.command],
    diagnostics: [],
  };
}

export function gatewayConnectionOpened(
  state: GatewayProtocolState,
  nowMs: number,
): GatewayTransition {
  if (!validTime(nowMs)) throw new RangeError("invalid_gateway_time");
  if (state.phase !== "reconnecting")
    return protocolViolation(state, "illegal_lifecycle_transition");
  const generation = state.connectionGeneration + 1;
  return emptyTransition(
    evolve(state, {
      phase: "connecting",
      connectionGeneration: generation,
      heartbeat: null,
      lastReceivedSequence: state.lastCheckpointedSequence,
      pendingEffect: null,
      pendingDispatchSequence: null,
      outstandingOutbound: [],
      outbound: startGatewayConnectionGeneration(state.outbound, generation),
    }),
  );
}

function opcodeCategory(opcode: number): GatewayOpcodeCategory {
  switch (opcode) {
    case 0:
      return "dispatch";
    case 1:
      return "heartbeat";
    case 7:
      return "reconnect";
    case 9:
      return "invalid_session";
    case 10:
      return "hello";
    case 11:
      return "heartbeat_ack";
    default:
      return "unknown";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonDispatchEnvelopeFieldsAreValid(envelope: Record<string, unknown>): boolean {
  return (
    (envelope.s === undefined || envelope.s === null) &&
    (envelope.t === undefined || envelope.t === null)
  );
}

function normalizeId(value: unknown): string | null {
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function optionalId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return normalizeId(value) ?? undefined;
}

function normalizeMessageCreate(value: unknown): RegistrationMessageEvent | null {
  if (!isRecord(value) || !isRecord(value.author)) return null;
  const eventId = normalizeId(value.id);
  const guildId = normalizeId(value.guild_id);
  const channelId = normalizeId(value.channel_id);
  const authorId = normalizeId(value.author.id);
  const webhookId = optionalId(value.webhook_id);
  const applicationId = optionalId(value.application_id);
  if (
    eventId === null ||
    guildId === null ||
    channelId === null ||
    authorId === null ||
    webhookId === undefined ||
    applicationId === undefined ||
    typeof value.content !== "string" ||
    typeof value.timestamp !== "string" ||
    value.timestamp.length === 0 ||
    (value.author.bot !== undefined && typeof value.author.bot !== "boolean") ||
    (value.author.system !== undefined && typeof value.author.system !== "boolean")
  )
    return null;
  return {
    event_id: eventId,
    guild_id: guildId,
    channel_id: channelId,
    author_id: authorId,
    author_is_bot: value.author.bot === true,
    author_is_system: value.author.system === true,
    webhook_id: webhookId,
    application_id: applicationId,
    content: value.content,
    created_at: value.timestamp,
  };
}

function messageMetadata(event: RegistrationMessageEvent): GatewayMessageMetadata {
  return {
    event_id: event.event_id,
    guild_id: event.guild_id,
    channel_id: event.channel_id,
    author_id: event.author_id,
    author_is_bot: event.author_is_bot,
    author_is_system: event.author_is_system,
    webhook_id: event.webhook_id,
    application_id: event.application_id,
    created_at: event.created_at,
  };
}

function ignoredEvidence(
  metadata: GatewayMessageMetadata,
  reason: IgnoredMessageReason,
): IgnoredMessageEvidence {
  return { ...metadata, reason };
}

function beginCheckpoint(
  state: GatewayProtocolState,
  sequence: number,
  phaseAfterCheckpoint: "active" | "resuming",
  phase: GatewayLifecycle = state.phase,
): GatewayTransition {
  const effectId = state.nextId;
  const command: CheckpointDispatchCommand = {
    type: "checkpoint_dispatch",
    effectId,
    sequence,
  };
  return {
    state: evolve(state, {
      phase,
      nextId: effectId + 1,
      pendingDispatchSequence: sequence,
      pendingEffect: { kind: "checkpoint", effectId, sequence, phaseAfterCheckpoint },
    }),
    commands: [command],
    diagnostics: [],
  };
}

function sequenceRelation(
  checkpoint: number | null,
  sequence: number,
): "greater" | "equal" | "lower" {
  if (checkpoint === null || sequence > checkpoint) return "greater";
  if (sequence === checkpoint) return "equal";
  return "lower";
}

function handleDispatch(
  state: GatewayProtocolState,
  envelope: Record<string, unknown>,
): GatewayTransition {
  if (!validSequence(envelope.s) || typeof envelope.t !== "string" || envelope.t.length === 0)
    return protocolViolation(state, "invalid_opcode_shape", "dispatch");
  const sequence = envelope.s;
  const eventName = envelope.t;

  if (state.pendingDispatchSequence !== null || state.pendingEffect !== null) {
    const relation: GatewaySequenceRelation =
      state.pendingDispatchSequence === null
        ? "overlap"
        : sequence < state.pendingDispatchSequence
          ? "lower"
          : sequence === state.pendingDispatchSequence
            ? "equal"
            : "overlap";
    return protocolViolation(state, "overlapping_dispatch", "dispatch", relation);
  }

  const relation = sequenceRelation(state.lastCheckpointedSequence, sequence);
  if (relation === "equal") {
    const count = Math.min(state.replayTelemetryCount + 1, MAX_REPLAY_TELEMETRY);
    const next = evolve(state, { replayTelemetryCount: count });
    return {
      state: next,
      commands: [],
      diagnostics:
        state.replayTelemetryCount >= MAX_REPLAY_TELEMETRY
          ? []
          : [diagnostic(state, "replayed_dispatch", count, "dispatch", "equal")],
    };
  }
  if (relation === "lower")
    return protocolViolation(state, "regressed_dispatch", "dispatch", "lower");

  if (state.phase === "identifying") {
    if (eventName !== "READY")
      return protocolViolation(state, "dispatch_before_ready", "dispatch", "greater");
    if (!isRecord(envelope.d))
      return protocolViolation(state, "invalid_opcode_shape", "dispatch", "greater");
    const sessionId = envelope.d.session_id;
    const resumeGatewayUrl = envelope.d.resume_gateway_url;
    if (
      typeof sessionId !== "string" ||
      sessionId.length === 0 ||
      typeof resumeGatewayUrl !== "string" ||
      resumeGatewayUrl.length === 0
    )
      return protocolViolation(state, "invalid_opcode_shape", "dispatch", "greater");
    const effectId = state.nextId;
    return {
      state: evolve(state, {
        phase: "ready",
        lastReceivedSequence: sequence,
        pendingDispatchSequence: sequence,
        pendingEffect: { kind: "persist_ready", effectId, sequence },
        nextId: effectId + 1,
      }),
      commands: [
        new PersistReadySessionCommand(
          effectId,
          sequence,
          new OpaqueGatewaySessionMaterial(sessionId, resumeGatewayUrl),
        ),
      ],
      diagnostics: [],
    };
  }

  if (
    state.phase === "connecting" ||
    state.phase === "hello" ||
    state.phase === "ready" ||
    state.phase === "resumed"
  )
    return protocolViolation(
      state,
      state.connectionIntent === "fresh" ? "dispatch_before_ready" : "illegal_lifecycle_transition",
      "dispatch",
      "greater",
    );

  if (state.phase !== "active" && state.phase !== "resuming")
    return protocolViolation(state, "illegal_lifecycle_transition", "dispatch", "greater");
  if (eventName === "READY" || (eventName === "RESUMED" && state.phase !== "resuming"))
    return protocolViolation(state, "illegal_lifecycle_transition", "dispatch", "greater");

  const withReceived = evolve(state, { lastReceivedSequence: sequence });
  if (eventName === "RESUMED") return beginCheckpoint(withReceived, sequence, "active", "resumed");

  const phaseAfterCheckpoint = state.phase;
  if (eventName !== "MESSAGE_CREATE")
    return beginCheckpoint(withReceived, sequence, phaseAfterCheckpoint);

  const event = normalizeMessageCreate(envelope.d);
  if (event === null)
    return protocolViolation(state, "invalid_opcode_shape", "dispatch", "greater");
  const metadata = messageMetadata(event);
  let disposition: "target" | "ignored";
  try {
    disposition = state.classifyMessage(metadata);
  } catch {
    return protocolViolation(state, "invalid_opcode_shape", "dispatch", "greater");
  }
  if (disposition !== "target" && disposition !== "ignored")
    return protocolViolation(state, "invalid_opcode_shape", "dispatch", "greater");
  const effectId = state.nextId;
  if (disposition === "target")
    return {
      state: evolve(withReceived, {
        nextId: effectId + 1,
        pendingDispatchSequence: sequence,
        pendingEffect: {
          kind: "accept_target",
          effectId,
          sequence,
          phaseAfterCheckpoint,
        },
      }),
      commands: [new AcceptTargetMessageCommand(effectId, sequence, event)],
      diagnostics: [],
    };

  const command: RecordIgnoredDispatchCommand = {
    type: "record_ignored_dispatch",
    effectId,
    sequence,
    evidence: ignoredEvidence(metadata, "not_target"),
  };
  return {
    state: evolve(withReceived, {
      nextId: effectId + 1,
      pendingDispatchSequence: sequence,
      pendingEffect: {
        kind: "record_ignored",
        effectId,
        sequence,
        phaseAfterCheckpoint,
      },
    }),
    commands: [command],
    diagnostics: [],
  };
}

function handleHello(
  state: GatewayProtocolState,
  envelope: Record<string, unknown>,
  input: ReceiveGatewayTextInput,
): GatewayTransition {
  if (state.phase !== "connecting")
    return protocolViolation(
      state,
      state.heartbeat === null ? "illegal_lifecycle_transition" : "duplicate_hello",
      "hello",
    );
  if (!isRecord(envelope.d)) return protocolViolation(state, "invalid_opcode_shape", "hello");
  const interval = envelope.d.heartbeat_interval;
  const jitter = input.firstHeartbeatJitter;
  if (
    typeof interval !== "number" ||
    !Number.isSafeInteger(interval) ||
    interval <= 0 ||
    typeof jitter !== "number" ||
    !Number.isFinite(jitter) ||
    jitter < 0 ||
    jitter > 1
  )
    return protocolViolation(state, "invalid_opcode_shape", "hello");
  const atMs = input.nowMs + Math.floor(interval * jitter);
  return {
    state: evolve(state, {
      phase: "hello",
      heartbeat: { intervalMs: interval, nextAtMs: atMs, ackOutstanding: false },
    }),
    commands: [{ type: "schedule_heartbeat", atMs, deadlineAtMs: atMs, first: true }],
    diagnostics: [],
  };
}

function heartbeatAllowed(state: GatewayProtocolState): boolean {
  return (
    state.phase === "hello" ||
    state.phase === "identifying" ||
    state.phase === "ready" ||
    state.phase === "active" ||
    state.phase === "resuming" ||
    state.phase === "resumed"
  );
}

function requestedHeartbeat(state: GatewayProtocolState, nowMs: number): GatewayTransition {
  if (!heartbeatAllowed(state) || state.heartbeat === null)
    return protocolViolation(state, "illegal_lifecycle_transition", "heartbeat");
  const result = authorizeOutbound(
    state,
    {
      kind: "heartbeat_requested",
      opcode: 1,
      sequence: state.lastReceivedSequence,
    },
    nowMs,
    nowMs,
  );
  if (!result.allowed)
    return haltForLocalPolicy(result.state, "local_gateway_outbound_safety_gate_violation");
  return {
    state: evolve(result.state, {
      heartbeat: { ...state.heartbeat, ackOutstanding: true },
    }),
    commands: [result.command],
    diagnostics: [],
  };
}

function heartbeatAcknowledged(state: GatewayProtocolState): GatewayTransition {
  if (!heartbeatAllowed(state) || state.heartbeat === null)
    return protocolViolation(state, "illegal_lifecycle_transition", "heartbeat_ack");
  if (!state.heartbeat.ackOutstanding) return emptyTransition(state);
  return emptyTransition(
    evolve(state, { heartbeat: { ...state.heartbeat, ackOutstanding: false } }),
  );
}

function handleInvalidSession(state: GatewayProtocolState, resumable: boolean): GatewayTransition {
  if (resumable)
    return recover(state, "server_reconnect", false, [
      diagnostic(state, "gateway_close", 1, "invalid_session"),
    ]);

  const effectId = state.nextId;
  const command: ClearSessionCommand = { type: "clear_gateway_session", effectId };
  return {
    state: evolve(state, {
      phase: "non_resumable",
      heartbeat: null,
      pendingEffect: { kind: "clear_session", effectId, connectionClosed: false },
      pendingDispatchSequence: null,
      outstandingOutbound: [],
      nextId: effectId + 1,
    }),
    commands: [command],
    diagnostics: [],
  };
}

export function receiveGatewayText(
  state: GatewayProtocolState,
  text: string,
  input: ReceiveGatewayTextInput,
): GatewayTransition {
  if (!validTime(input.nowMs)) throw new RangeError("invalid_gateway_time");
  if (state.phase === "halted") return emptyTransition(state);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return protocolViolation(state, "malformed_gateway_payload");
  }
  if (!isRecord(parsed) || typeof parsed.op !== "number" || !Number.isInteger(parsed.op))
    return protocolViolation(state, "malformed_gateway_payload");

  const category = opcodeCategory(parsed.op);
  if (category === "unknown") return protocolViolation(state, "unknown_opcode", "unknown");
  if (category !== "dispatch" && !nonDispatchEnvelopeFieldsAreValid(parsed))
    return protocolViolation(state, "invalid_opcode_shape", category);
  if (state.phase === "non_resumable")
    return protocolViolation(state, "illegal_lifecycle_transition", category);

  switch (parsed.op) {
    case 0:
      return handleDispatch(state, parsed);
    case 1:
      if (parsed.d !== undefined && parsed.d !== null)
        return protocolViolation(state, "invalid_opcode_shape", "heartbeat");
      return requestedHeartbeat(state, input.nowMs);
    case 7:
      if (parsed.d !== undefined && parsed.d !== null)
        return protocolViolation(state, "invalid_opcode_shape", "reconnect");
      return recover(state, "server_reconnect", false, [
        diagnostic(state, "gateway_close", 1, "reconnect"),
      ]);
    case 9:
      if (typeof parsed.d !== "boolean")
        return protocolViolation(state, "invalid_opcode_shape", "invalid_session");
      return handleInvalidSession(state, parsed.d);
    case 10:
      return handleHello(state, parsed, input);
    case 11:
      if (parsed.d !== undefined && parsed.d !== null)
        return protocolViolation(state, "invalid_opcode_shape", "heartbeat_ack");
      return heartbeatAcknowledged(state);
    default:
      return protocolViolation(state, "unknown_opcode", "unknown");
  }
}

export function gatewayHeartbeatDue(state: GatewayProtocolState, nowMs: number): GatewayTransition {
  if (!validTime(nowMs)) throw new RangeError("invalid_gateway_time");
  if (!heartbeatAllowed(state) || state.heartbeat === null)
    return protocolViolation(state, "illegal_lifecycle_transition");
  if (nowMs !== state.heartbeat.nextAtMs)
    return nowMs > state.heartbeat.nextAtMs
      ? haltForLocalPolicy(state, "local_gateway_outbound_safety_gate_violation")
      : protocolViolation(state, "illegal_lifecycle_transition");
  if (state.heartbeat.ackOutstanding)
    return recover(state, "heartbeat_ack_missing", false, [
      diagnostic(state, "heartbeat_ack_missing"),
    ]);

  const result = authorizeOutbound(
    state,
    { kind: "heartbeat_regular", opcode: 1, sequence: state.lastReceivedSequence },
    nowMs,
    state.heartbeat.nextAtMs,
  );
  if (!result.allowed)
    return haltForLocalPolicy(result.state, "local_gateway_outbound_safety_gate_violation");
  const nextAtMs = state.heartbeat.nextAtMs + state.heartbeat.intervalMs;
  return {
    state: evolve(result.state, {
      heartbeat: {
        intervalMs: state.heartbeat.intervalMs,
        nextAtMs,
        ackOutstanding: true,
      },
    }),
    commands: [
      result.command,
      { type: "schedule_heartbeat", atMs: nextAtMs, deadlineAtMs: nextAtMs, first: false },
    ],
    diagnostics: [],
  };
}

type AdditionalGatewaySendKind = Exclude<
  GatewaySendKind,
  "heartbeat_regular" | "heartbeat_requested" | "identify" | "resume"
>;

function additionalOutboundEvent(kind: AdditionalGatewaySendKind): GatewayOutboundEvent {
  switch (kind) {
    case "presence_update":
      return { kind, opcode: 3 };
    case "voice_state_update":
      return { kind, opcode: 4 };
    case "request_guild_members":
      return { kind, opcode: 8 };
    case "request_soundboard_sounds":
      return { kind, opcode: 31 };
    case "request_channel_info":
      return { kind, opcode: 43 };
  }
}

export function requestGatewayOutbound(
  state: GatewayProtocolState,
  input: Readonly<{
    kind: AdditionalGatewaySendKind;
    nowMs: number;
    deadlineAtMs: number;
  }>,
): GatewayTransition {
  if (state.phase !== "active") return protocolViolation(state, "illegal_lifecycle_transition");
  const result = authorizeOutbound(
    state,
    additionalOutboundEvent(input.kind),
    input.nowMs,
    input.deadlineAtMs,
  );
  if (!result.allowed)
    return haltForLocalPolicy(result.state, "local_gateway_outbound_safety_gate_violation");
  return { state: result.state, commands: [result.command], diagnostics: [] };
}

export function completeGatewayOutbound(
  state: GatewayProtocolState,
  input: Readonly<{ authorizationId: number; result: GatewayTransportResult }>,
): GatewayTransition {
  const outbound = state.outstandingOutbound.find(
    (item) => item.authorizationId === input.authorizationId,
  );
  if (outbound === undefined) return protocolViolation(state, "impossible_effect_completion");
  const recorded = recordGatewayOutboundResult(state.outbound, input.result);
  const next = evolve(state, {
    outbound: recorded,
    outstandingOutbound: state.outstandingOutbound.filter(
      (item) => item.authorizationId !== input.authorizationId,
    ),
  });
  if (input.result === "sent") return emptyTransition(next);
  return recover(next, "outbound_failure", false, [
    diagnostic(state, "outbound_transport_failure"),
  ]);
}

export function gatewayConnectionClosed(
  state: GatewayProtocolState,
  code: number | null,
): GatewayTransition {
  if (state.phase === "halted") return emptyTransition(state);
  if (state.phase === "non_resumable") {
    const pending = state.pendingEffect;
    if (pending === null || pending.kind !== "clear_session")
      return {
        state,
        commands: [],
        diagnostics: [diagnostic(state, "impossible_effect_completion")],
      };
    return {
      state: evolve(state, {
        heartbeat: null,
        outstandingOutbound: [],
        pendingEffect: { ...pending, connectionClosed: true },
      }),
      commands: [],
      diagnostics: [diagnostic(state, "gateway_close")],
    };
  }
  const policy = classifyGatewayCloseCode(code);
  const report = diagnostic(state, "gateway_close");
  if (policy.projectAction === "halt")
    return {
      state: evolve(state, {
        phase: "halted",
        heartbeat: null,
        pendingEffect: null,
        pendingDispatchSequence: null,
        outstandingOutbound: [],
      }),
      commands: [],
      diagnostics: [report],
    };
  return recover(state, "server_reconnect", true, [report]);
}

export function decideCheckpointAdvance(input: CheckpointAdvanceInput): CheckpointAdvanceDecision {
  if (!validSequence(input.candidateSequence)) throw new RangeError("invalid_gateway_checkpoint");
  if (
    input.lastCheckpointedSequence !== null &&
    input.candidateSequence < input.lastCheckpointedSequence
  )
    return "rejected_regression";
  if (input.candidateSequence === input.lastCheckpointedSequence) return "idempotent_noop";
  if (!input.effectSucceeded) return "rejected_effect_incomplete";
  if (input.pendingDispatchSequence !== input.candidateSequence) return "rejected_not_pending";
  return "advanced";
}

function emitCheckpointAfterEffect(
  state: GatewayProtocolState,
  pending: PendingTargetAcceptance | PendingIgnoredEvidence,
): GatewayTransition {
  const effectId = state.nextId;
  const command: CheckpointDispatchCommand = {
    type: "checkpoint_dispatch",
    effectId,
    sequence: pending.sequence,
  };
  return {
    state: evolve(state, {
      nextId: effectId + 1,
      pendingEffect: {
        kind: "checkpoint",
        effectId,
        sequence: pending.sequence,
        phaseAfterCheckpoint: pending.phaseAfterCheckpoint,
      },
    }),
    commands: [command],
    diagnostics: [],
  };
}

function failedDurableEffect(state: GatewayProtocolState): GatewayTransition {
  return recover(state, "effect_failure", false, [diagnostic(state, "effect_failed")]);
}

export function completeGatewayEffect(
  state: GatewayProtocolState,
  completion: GatewayEffectCompletion,
): GatewayTransition {
  const pending = state.pendingEffect;
  if (pending === null || pending.effectId !== completion.effectId)
    return protocolViolation(state, "impossible_effect_completion");

  if (pending.kind === "persist_ready") {
    if (completion.type !== "ready_session_persistence")
      return protocolViolation(state, "impossible_effect_completion");
    if (completion.outcome !== "persisted") return failedDurableEffect(state);
    const decision = decideCheckpointAdvance({
      lastCheckpointedSequence: state.lastCheckpointedSequence,
      pendingDispatchSequence: state.pendingDispatchSequence,
      candidateSequence: pending.sequence,
      effectSucceeded: true,
    });
    if (decision !== "advanced" && decision !== "idempotent_noop")
      return protocolViolation(state, "checkpoint_regression", "dispatch", "lower");
    return emptyTransition(
      evolve(state, {
        phase: "active",
        session: completion.session,
        lastCheckpointedSequence:
          decision === "advanced" ? pending.sequence : state.lastCheckpointedSequence,
        pendingDispatchSequence: null,
        pendingEffect: null,
        violationTracker: { checkpoint: pending.sequence, count: 0 },
      }),
    );
  }

  if (pending.kind === "accept_target") {
    if (completion.type !== "target_acceptance")
      return protocolViolation(state, "impossible_effect_completion");
    if (completion.outcome !== "accepted" && completion.outcome !== "duplicate")
      return failedDurableEffect(state);
    return emitCheckpointAfterEffect(state, pending);
  }

  if (pending.kind === "record_ignored") {
    if (completion.type !== "ignored_evidence")
      return protocolViolation(state, "impossible_effect_completion");
    if (completion.outcome !== "recorded") return failedDurableEffect(state);
    return emitCheckpointAfterEffect(state, pending);
  }

  if (pending.kind === "checkpoint") {
    if (completion.type !== "checkpoint_persistence")
      return protocolViolation(state, "impossible_effect_completion");
    if (completion.outcome !== "persisted") return failedDurableEffect(state);
    const decision = decideCheckpointAdvance({
      lastCheckpointedSequence: state.lastCheckpointedSequence,
      pendingDispatchSequence: state.pendingDispatchSequence,
      candidateSequence: pending.sequence,
      effectSucceeded: true,
    });
    if (decision === "rejected_regression" || decision === "rejected_not_pending")
      return protocolViolation(state, "checkpoint_regression", "dispatch", "lower");
    return emptyTransition(
      evolve(state, {
        phase: pending.phaseAfterCheckpoint,
        lastCheckpointedSequence:
          decision === "advanced" ? pending.sequence : state.lastCheckpointedSequence,
        pendingDispatchSequence: null,
        pendingEffect: null,
        violationTracker: { checkpoint: pending.sequence, count: 0 },
      }),
    );
  }

  if (completion.type !== "session_clear")
    return protocolViolation(state, "impossible_effect_completion");
  if (completion.outcome !== "cleared")
    return {
      state,
      commands: [],
      diagnostics: [diagnostic(state, "effect_failed")],
    };
  const cleared = evolve(state, {
    phase: "reconnecting",
    connectionIntent: "fresh",
    session: null,
    lastReceivedSequence: null,
    lastCheckpointedSequence: null,
    pendingDispatchSequence: null,
    pendingEffect: null,
    violationTracker: { checkpoint: null, count: 0 },
  });
  return {
    state: cleared,
    commands: [
      ...(pending.connectionClosed ? [] : [closeCommand("server_reconnect")]),
      { type: "reconnect_gateway", mode: "fresh" },
    ],
    diagnostics: [],
  };
}

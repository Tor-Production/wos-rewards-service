import type { RegistrationMessageEvent } from "../../domain/discord-event";

export type GatewayLifecycle =
  | "connecting"
  | "hello"
  | "identifying"
  | "ready"
  | "active"
  | "reconnecting"
  | "resuming"
  | "resumed"
  | "non_resumable"
  | "halted";

export type GatewaySequenceRelation = "greater" | "equal" | "lower" | "overlap";

export type GatewayOpcodeCategory =
  | "dispatch"
  | "heartbeat"
  | "reconnect"
  | "invalid_session"
  | "hello"
  | "heartbeat_ack"
  | "unknown";

export type GatewayDiagnosticCategory =
  | "malformed_gateway_payload"
  | "invalid_opcode_shape"
  | "unknown_opcode"
  | "duplicate_hello"
  | "illegal_lifecycle_transition"
  | "dispatch_before_ready"
  | "overlapping_dispatch"
  | "replayed_dispatch"
  | "regressed_dispatch"
  | "checkpoint_regression"
  | "impossible_effect_completion"
  | "effect_failed"
  | "outbound_transport_failure"
  | "heartbeat_ack_missing"
  | "local_gateway_outbound_safety_gate_violation"
  | "identify_session_start_limit_violation"
  | "gateway_close";

/**
 * Closed, deliberately low-cardinality diagnostics. Raw payloads, IDs, content, session
 * material, URLs, credentials and exception text have no place in this type.
 */
export interface GatewayDiagnostic {
  readonly category: GatewayDiagnosticCategory;
  readonly state: GatewayLifecycle;
  readonly connectionGeneration: number;
  readonly occurrenceCount: number;
  readonly knownOpcodeCategory?: GatewayOpcodeCategory;
  readonly sequenceRelation?: GatewaySequenceRelation;
}

export interface GatewaySessionStartLimit {
  readonly total: number;
  readonly remaining: number;
  readonly reset_after: number;
  readonly max_concurrency: number;
}

export type GatewayMessageMetadata = Readonly<Omit<RegistrationMessageEvent, "content">>;

/**
 * The protocol core does not own guild/channel authorization or the staging sender exception.
 * A caller supplies a deterministic classifier that can see normalized metadata but never raw
 * registration content.
 */
export type GatewayMessageClassifier = (metadata: GatewayMessageMetadata) => "target" | "ignored";

export type GatewaySendKind =
  | "heartbeat_regular"
  | "heartbeat_requested"
  | "identify"
  | "resume"
  | "presence_update"
  | "voice_state_update"
  | "request_guild_members"
  | "request_soundboard_sounds"
  | "request_channel_info";

export type GatewayTransportResult = "sent" | "failed" | "ambiguous";

export type GatewayEffectOutcome = "failed" | "ambiguous";

export type GatewayOutboundEvent =
  | {
      readonly kind: "heartbeat_regular" | "heartbeat_requested";
      readonly opcode: 1;
      readonly sequence: number | null;
    }
  | { readonly kind: "identify"; readonly opcode: 2 }
  | {
      readonly kind: "resume";
      readonly opcode: 6;
      readonly sequence: number;
      readonly session: GatewaySessionHandle;
    }
  | { readonly kind: "presence_update"; readonly opcode: 3 }
  | { readonly kind: "voice_state_update"; readonly opcode: 4 }
  | { readonly kind: "request_guild_members"; readonly opcode: 8 }
  | { readonly kind: "request_soundboard_sounds"; readonly opcode: 31 }
  | { readonly kind: "request_channel_info"; readonly opcode: 43 };

/** Opaque READY material. Only the persistence effect executor may unwrap it. */
export class OpaqueGatewaySessionMaterial {
  readonly kind = "opaque_gateway_session_material";
  readonly #sessionId: string;
  readonly #resumeGatewayUrl: string;

  constructor(sessionId: string, resumeGatewayUrl: string) {
    this.#sessionId = sessionId;
    this.#resumeGatewayUrl = resumeGatewayUrl;
  }

  forPersistence(): Readonly<{ sessionId: string; resumeGatewayUrl: string }> {
    return { sessionId: this.#sessionId, resumeGatewayUrl: this.#resumeGatewayUrl };
  }

  toJSON(): Readonly<{ kind: "opaque_gateway_session_material"; redacted: true }> {
    return { kind: "opaque_gateway_session_material", redacted: true };
  }
}

/** Opaque reference returned only after durable session persistence succeeds. */
export class GatewaySessionHandle {
  readonly kind = "gateway_session_persistence_handle";
  readonly #reference: string;

  constructor(reference: string) {
    if (reference.length === 0) throw new TypeError("invalid_gateway_session_handle");
    this.#reference = reference;
  }

  forPersistenceAdapter(): string {
    return this.#reference;
  }

  toJSON(): Readonly<{ kind: "gateway_session_persistence_handle"; redacted: true }> {
    return { kind: "gateway_session_persistence_handle", redacted: true };
  }
}

export interface ScheduleHeartbeatCommand {
  readonly type: "schedule_heartbeat";
  readonly atMs: number;
  readonly deadlineAtMs: number;
  readonly first: boolean;
}

export interface ScheduleHandshakeCommand {
  readonly type: "schedule_handshake";
  readonly atMs: number;
  readonly deadlineAtMs: number;
  readonly mode: "identify" | "resume";
}

/**
 * Authorization is the counting point for the local outbound gate. Transport must report a
 * result, but failed and ambiguous results do not refund the authorization.
 */
export class SendGatewayEventCommand {
  readonly type = "send_gateway_event";
  readonly authorizationId: number;
  readonly connectionGeneration: number;
  readonly #event: GatewayOutboundEvent;

  constructor(authorizationId: number, connectionGeneration: number, event: GatewayOutboundEvent) {
    this.authorizationId = authorizationId;
    this.connectionGeneration = connectionGeneration;
    this.#event = event;
  }

  get event(): GatewayOutboundEvent {
    return this.#event;
  }

  toJSON(): Readonly<{
    type: "send_gateway_event";
    authorizationId: number;
    connectionGeneration: number;
    kind: GatewaySendKind;
  }> {
    return {
      type: "send_gateway_event",
      authorizationId: this.authorizationId,
      connectionGeneration: this.connectionGeneration,
      kind: this.#event.kind,
    };
  }
}

export class PersistReadySessionCommand {
  readonly type = "persist_ready_session";
  readonly effectId: number;
  readonly sequence: number;
  readonly #material: OpaqueGatewaySessionMaterial;

  constructor(effectId: number, sequence: number, material: OpaqueGatewaySessionMaterial) {
    this.effectId = effectId;
    this.sequence = sequence;
    this.#material = material;
  }

  get material(): OpaqueGatewaySessionMaterial {
    return this.#material;
  }

  toJSON(): Readonly<{
    type: "persist_ready_session";
    effectId: number;
    sequence: number;
    material: "redacted";
  }> {
    return {
      type: "persist_ready_session",
      effectId: this.effectId,
      sequence: this.sequence,
      material: "redacted",
    };
  }
}

export class AcceptTargetMessageCommand {
  readonly type = "accept_target_message";
  readonly effectId: number;
  readonly sequence: number;
  readonly #event: RegistrationMessageEvent;

  constructor(effectId: number, sequence: number, event: RegistrationMessageEvent) {
    this.effectId = effectId;
    this.sequence = sequence;
    this.#event = event;
  }

  /** The sole core output through which raw registration content is available. */
  get event(): RegistrationMessageEvent {
    return this.#event;
  }

  toJSON(): Readonly<{
    type: "accept_target_message";
    effectId: number;
    sequence: number;
    event: "redacted";
  }> {
    return {
      type: "accept_target_message",
      effectId: this.effectId,
      sequence: this.sequence,
      event: "redacted",
    };
  }
}

export type IgnoredMessageReason = "not_target";

export type IgnoredMessageEvidence = Readonly<
  Omit<RegistrationMessageEvent, "content"> & { reason: IgnoredMessageReason }
>;

export interface RecordIgnoredDispatchCommand {
  readonly type: "record_ignored_dispatch";
  readonly effectId: number;
  readonly sequence: number;
  readonly evidence: IgnoredMessageEvidence;
}

export interface CheckpointDispatchCommand {
  readonly type: "checkpoint_dispatch";
  readonly effectId: number;
  readonly sequence: number;
}

export interface ClearSessionCommand {
  readonly type: "clear_gateway_session";
  readonly effectId: number;
}

export interface CloseGatewayConnectionCommand {
  readonly type: "close_gateway_connection";
  readonly code: 4000;
  readonly cause:
    | "heartbeat_ack_missing"
    | "protocol_violation"
    | "effect_failure"
    | "outbound_failure"
    | "local_policy_violation"
    | "server_reconnect";
}

export interface ReconnectGatewayCommand {
  readonly type: "reconnect_gateway";
  readonly mode: "resume" | "fresh";
}

export type GatewayCommand =
  | ScheduleHeartbeatCommand
  | ScheduleHandshakeCommand
  | SendGatewayEventCommand
  | PersistReadySessionCommand
  | AcceptTargetMessageCommand
  | RecordIgnoredDispatchCommand
  | CheckpointDispatchCommand
  | ClearSessionCommand
  | CloseGatewayConnectionCommand
  | ReconnectGatewayCommand;

export type GatewayEffectCompletion =
  | {
      readonly effectId: number;
      readonly type: "ready_session_persistence";
      readonly outcome: "persisted";
      readonly session: GatewaySessionHandle;
    }
  | {
      readonly effectId: number;
      readonly type: "ready_session_persistence";
      readonly outcome: GatewayEffectOutcome;
    }
  | {
      readonly effectId: number;
      readonly type: "target_acceptance";
      readonly outcome: "accepted" | "duplicate" | "rejected" | GatewayEffectOutcome;
    }
  | {
      readonly effectId: number;
      readonly type: "ignored_evidence";
      readonly outcome: "recorded" | GatewayEffectOutcome;
    }
  | {
      readonly effectId: number;
      readonly type: "checkpoint_persistence";
      readonly outcome: "persisted" | GatewayEffectOutcome;
    }
  | {
      readonly effectId: number;
      readonly type: "session_clear";
      readonly outcome: "cleared" | GatewayEffectOutcome;
    };

export interface GatewayStateSummary {
  readonly phase: GatewayLifecycle;
  readonly connectionGeneration: number;
  readonly connectionIntent: "fresh" | "resume";
  readonly hasDurableSession: boolean;
  readonly hasCheckpoint: boolean;
  readonly hasPendingDispatch: boolean;
  readonly heartbeatAckOutstanding: boolean;
  readonly malformedAtCheckpointCount: number;
  readonly replayTelemetryCount: number;
  readonly identify: Readonly<{
    total: number;
    remaining: number;
    resetAfterMs: number;
    maxConcurrency: number;
    shardId: number;
    concurrencyBucket: number;
    authorizedThisRun: number;
  }>;
  readonly outbound: Readonly<{
    connectionAuthorized: number;
    runAuthorized: number;
    runDenied: number;
    failed: number;
    ambiguous: number;
  }>;
}

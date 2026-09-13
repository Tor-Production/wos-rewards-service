import type { RegistrationMessageEvent } from "../../domain/discord-event";
import type {
  GatewayDiagnosticCategory,
  GatewayLifecycle,
  GatewayOpcodeCategory,
  GatewayOutboundEvent,
  GatewaySequenceRelation,
  GatewaySessionStartLimit,
  GatewayTransportResult,
} from "./types";

export interface GatewayAdapterClock {
  monotonicNowMs(): number;
  wallNowMs(): number;
}

export interface GatewayAdapterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTimeMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export class OpaqueGatewayConnectionTarget {
  readonly kind = "opaque_gateway_connection_target";
  readonly #resumeGatewayUrl: string | null;

  constructor(resumeGatewayUrl: string | null) {
    this.#resumeGatewayUrl = resumeGatewayUrl;
  }

  forTransport(): Readonly<{ resumeGatewayUrl: string | null }> {
    return { resumeGatewayUrl: this.#resumeGatewayUrl };
  }

  toJSON(): Readonly<{ kind: "opaque_gateway_connection_target"; redacted: true }> {
    return { kind: "opaque_gateway_connection_target", redacted: true };
  }
}

export class OpaqueGatewaySendContext {
  readonly kind = "opaque_gateway_send_context";
  readonly #sessionId: string | null;

  constructor(sessionId: string | null) {
    this.#sessionId = sessionId;
  }

  forTransport(): Readonly<{ sessionId: string | null }> {
    return { sessionId: this.#sessionId };
  }

  toJSON(): Readonly<{ kind: "opaque_gateway_send_context"; redacted: true }> {
    return { kind: "opaque_gateway_send_context", redacted: true };
  }
}

export interface GatewayWebSocketCallbacks {
  opened(): Promise<void>;
  text(message: string): Promise<void>;
  closed(code: number | null): Promise<void>;
  failed(): Promise<void>;
}

export interface GatewayWebSocketConnection {
  send(
    event: GatewayOutboundEvent,
    context: OpaqueGatewaySendContext,
  ): Promise<GatewayTransportResult>;
  close(code: number): void | Promise<void>;
}

export interface GatewayWebSocketFactory {
  connect(input: {
    readonly connectionGeneration: number;
    readonly mode: "fresh" | "resume";
    readonly target: OpaqueGatewayConnectionTarget;
    readonly callbacks: GatewayWebSocketCallbacks;
  }): Promise<GatewayWebSocketConnection>;
}

export type GatewayTargetAcceptanceOutcome =
  "accepted" | "duplicate" | "rejected" | "failed" | "timeout" | "ambiguous";

export type GatewayTargetAcceptance = (
  event: RegistrationMessageEvent,
) => Promise<GatewayTargetAcceptanceOutcome>;

export type GatewayAdapterDurableEffect =
  "ready_session" | "ignored_evidence" | "checkpoint" | "session_clear";

export type GatewayAdapterFaultAction = "proceed" | "fail_before" | "lose_after";

export type GatewayAdapterScheduleKind = "heartbeat" | "handshake" | "reconnect" | "watchdog";

export type GatewayAdapterTerminalReason =
  "fatal_gateway_close" | "local_policy_halt" | "retry_exhausted";

export type GatewayAdapterStartDisposition =
  | Readonly<{ kind: "startable" }>
  | Readonly<{ kind: "reconnect_pending"; mode: "resume" | "fresh" }>
  | Readonly<{
      kind: "reconnect_scheduled";
      mode: "resume" | "fresh";
      scheduleId: number;
    }>
  | Readonly<{ kind: "terminal"; reason: GatewayAdapterTerminalReason }>;

export type GatewayAdapterMetricCategory =
  | "constructor"
  | "start"
  | "start_blocked_terminal"
  | "start_blocked_reconnect"
  | "concurrent_start"
  | "socket_open"
  | "socket_close"
  | "socket_failure"
  | "stale_socket_callback"
  | "stale_effect_completion"
  | "schedule_added"
  | "schedule_claimed"
  | "schedule_ambiguous_recovery"
  | "alarm_delivery"
  | "alarm_without_due_work"
  | "stale_alarm"
  | "late_alarm"
  | "identify"
  | "resume"
  | "heartbeat_regular"
  | "heartbeat_requested"
  | "heartbeat_ack"
  | "outbound_sent"
  | "outbound_failed"
  | "outbound_ambiguous"
  | "outbound_gate_pressure"
  | "ready_persisted"
  | "acceptance_accepted"
  | "acceptance_duplicate"
  | "acceptance_rejected"
  | "acceptance_failed"
  | "acceptance_timeout"
  | "acceptance_ambiguous"
  | "ignored_recorded"
  | "checkpoint_persisted"
  | "session_cleared"
  | "reconnect_scheduled"
  | "retry_exhausted"
  | "terminal_disposition"
  | "protocol_diagnostic";

export interface GatewayAdapterDiagnostic {
  readonly category: GatewayAdapterMetricCategory;
  readonly connectionGeneration: number;
  readonly lifecycle: GatewayLifecycle | "uninitialized";
  readonly commandCategory?:
    | "send"
    | "schedule"
    | "ready"
    | "acceptance"
    | "ignored"
    | "checkpoint"
    | "session_clear"
    | "close"
    | "reconnect";
  readonly outcomeCategory?:
    | "success"
    | "duplicate"
    | "rejected"
    | "failed"
    | "timeout"
    | "ambiguous"
    | "stale"
    | "exhausted"
    | "terminal";
  readonly protocolCategory?: GatewayDiagnosticCategory;
  readonly knownOpcodeCategory?: GatewayOpcodeCategory;
  readonly sequenceRelation?: GatewaySequenceRelation;
  readonly occurrenceCount?: number;
}

export interface GatewayAdapterDependencies {
  readonly clock: GatewayAdapterClock;
  readonly webSocketFactory: GatewayWebSocketFactory;
  readonly sessionStartLimit: GatewaySessionStartLimit;
  readonly sessionStartLimitObservedAtMs: number;
  readonly firstHeartbeatJitter: () => number;
  readonly reconnectBackoffMs: (attempt: number) => number | null;
  readonly targetAcceptance?: GatewayTargetAcceptance;
  readonly durableEffectFault?: (effect: GatewayAdapterDurableEffect) => GatewayAdapterFaultAction;
  /** Deterministic crash seam used only around the persisted alarm-item claim. */
  readonly scheduleFault?: (kind: GatewayAdapterScheduleKind) => GatewayAdapterFaultAction;
  readonly diagnosticSink?: (diagnostic: GatewayAdapterDiagnostic) => void;
  readonly handshakeDeadlineMs?: number;
  readonly helloWatchdogMs?: number;
}

export interface GatewayAdapterInspection {
  readonly version: 2;
  readonly hydrated: boolean;
  readonly configured: boolean;
  readonly hasActiveConnection: boolean;
  readonly startDisposition: GatewayAdapterStartDisposition;
  readonly connectionGeneration: number;
  readonly checkpoint: number | null;
  readonly hasSession: boolean;
  readonly constructorInvocations: number;
  readonly reconnectAttempts: number;
  readonly logicalSchedules: readonly Readonly<{
    id: number;
    kind: GatewayAdapterScheduleKind;
    status: "pending" | "claimed";
    connectionGeneration: number;
    dueWallMs: number;
  }>[];
  readonly metrics: Readonly<Partial<Record<GatewayAdapterMetricCategory, number>>>;
  readonly protocol: unknown;
}

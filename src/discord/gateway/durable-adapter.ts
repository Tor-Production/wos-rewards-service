import type { AppConfig } from "../../config";
import { loadConfig } from "../../config";
import type { RegistrationMessageEvent } from "../../domain/discord-event";
import { acceptRegistrationEvent } from "../../ingest/acceptance";
import { classifyAcceptedAuthor } from "../../ingest/author-filter";
import { newAttemptRunId } from "../../ingest/identity";
import { parseRegistration } from "../../ingest/registration-parser";
import { isRegistrationMessageEvent } from "../../ingest/transport";
import { INLINE_DISPATCH_LIMIT } from "../../limits";
import { dispatchOutbox } from "../../outbox/dispatcher";
import {
  beginGatewayHandshake,
  completeGatewayEffect,
  completeGatewayOutbound,
  createGatewayProtocolState,
  gatewayConnectionClosed,
  gatewayHeartbeatDue,
  receiveGatewayText,
  snapshotGatewayProtocolSafety,
  summarizeGatewayState,
  type GatewayProtocolSafetySnapshot,
  type GatewayProtocolState,
  type GatewayTransition,
} from "./protocol";
import {
  GatewaySessionHandle,
  type GatewayCommand,
  type GatewayDiagnostic,
  type GatewayEffectCompletion,
  type GatewayMessageMetadata,
  type GatewaySessionStartLimit,
  type GatewayTransportResult,
  type RecordIgnoredDispatchCommand,
  type SendGatewayEventCommand,
} from "./types";
import {
  OpaqueGatewayConnectionTarget,
  OpaqueGatewaySendContext,
  type GatewayAdapterDependencies,
  type GatewayAdapterDiagnostic,
  type GatewayAdapterDurableEffect,
  type GatewayAdapterFaultAction,
  type GatewayAdapterInspection,
  type GatewayAdapterMetricCategory,
  type GatewayAdapterScheduleKind,
  type GatewayAdapterStorage,
  type GatewayTargetAcceptanceOutcome,
  type GatewayWebSocketConnection,
} from "./durable-adapter-types";

const ADAPTER_STATE_KEY = "gateway-adapter-state";
const IGNORED_EVIDENCE_PREFIX = "gateway-ignored:";
const MAX_COMPLETED_SCHEDULE_IDS = 128;
const DEFAULT_HANDSHAKE_DEADLINE_MS = 10_000;
const DEFAULT_HELLO_WATCHDOG_MS = 30_000;
const METRIC_CATEGORIES = new Set<GatewayAdapterMetricCategory>([
  "constructor",
  "start",
  "concurrent_start",
  "socket_open",
  "socket_close",
  "socket_failure",
  "stale_socket_callback",
  "stale_effect_completion",
  "schedule_added",
  "schedule_claimed",
  "schedule_ambiguous_recovery",
  "alarm_delivery",
  "alarm_without_due_work",
  "stale_alarm",
  "late_alarm",
  "identify",
  "resume",
  "heartbeat_regular",
  "heartbeat_requested",
  "heartbeat_ack",
  "outbound_sent",
  "outbound_failed",
  "outbound_ambiguous",
  "outbound_gate_pressure",
  "ready_persisted",
  "acceptance_accepted",
  "acceptance_duplicate",
  "acceptance_rejected",
  "acceptance_failed",
  "acceptance_timeout",
  "acceptance_ambiguous",
  "ignored_recorded",
  "checkpoint_persisted",
  "session_cleared",
  "reconnect_scheduled",
  "retry_exhausted",
  "protocol_diagnostic",
]);

interface PersistedSession {
  readonly handleReference: string;
  readonly sessionId: string;
  readonly resumeGatewayUrl: string;
}

interface SessionStartLimitObservation {
  readonly limit: GatewaySessionStartLimit;
  readonly observedAtMs: number;
}

interface PersistedLogicalSchedule {
  readonly id: number;
  readonly kind: GatewayAdapterScheduleKind;
  readonly status: "pending" | "claimed";
  readonly connectionGeneration: number;
  readonly dueMonotonicMs: number;
  readonly dueWallMs: number;
  readonly deadlineAtMs?: number;
  readonly first?: boolean;
  readonly mode?: "identify" | "resume" | "fresh";
}

interface PersistedGatewayAdapterState {
  readonly version: 1;
  session: PersistedSession | null;
  checkpoint: number | null;
  connectionGeneration: number;
  constructorInvocations: number;
  reconnectAttempts: number;
  nextScheduleId: number;
  schedules: PersistedLogicalSchedule[];
  completedScheduleIds: number[];
  sessionStartLimit: SessionStartLimitObservation | null;
  safety: GatewayProtocolSafetySnapshot | null;
  lastMonotonicMs: number | null;
  metrics: Partial<Record<GatewayAdapterMetricCategory, number>>;
}

interface PersistedIgnoredEvidence {
  readonly version: 1;
  readonly sequence: number;
  readonly reason: "not_target";
  readonly authorCategory: "human" | "bot" | "webhook" | "system";
}

interface ActiveConnection {
  readonly generation: number;
  valid: boolean;
  socket: GatewayWebSocketConnection | null;
}

function initialState(): PersistedGatewayAdapterState {
  return {
    version: 1,
    session: null,
    checkpoint: null,
    connectionGeneration: 0,
    constructorInvocations: 0,
    reconnectAttempts: 0,
    nextScheduleId: 1,
    schedules: [],
    completedScheduleIds: [],
    sessionStartLimit: null,
    safety: null,
    lastMonotonicMs: null,
    metrics: {},
  };
}

function validInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSession(value: unknown): value is PersistedSession | null {
  return (
    value === null ||
    (isRecord(value) &&
      value.handleReference === "gateway-session-v1" &&
      typeof value.sessionId === "string" &&
      value.sessionId.length > 0 &&
      typeof value.resumeGatewayUrl === "string" &&
      value.resumeGatewayUrl.length > 0)
  );
}

function validSessionStartLimit(value: unknown): value is SessionStartLimitObservation | null {
  if (value === null) return true;
  if (!isRecord(value) || !validInteger(value.observedAtMs) || !isRecord(value.limit)) return false;
  const limit = value.limit;
  return (
    validInteger(limit.total) &&
    validInteger(limit.remaining) &&
    limit.remaining <= limit.total &&
    validInteger(limit.reset_after, 1) &&
    validInteger(limit.max_concurrency, 1)
  );
}

function validSchedule(value: unknown): value is PersistedLogicalSchedule {
  if (
    !isRecord(value) ||
    !validInteger(value.id, 1) ||
    !["heartbeat", "handshake", "reconnect", "watchdog"].includes(String(value.kind)) ||
    (value.status !== "pending" && value.status !== "claimed") ||
    !validInteger(value.connectionGeneration, 1) ||
    !validInteger(value.dueMonotonicMs) ||
    !validInteger(value.dueWallMs)
  )
    return false;
  if (value.kind === "heartbeat")
    return (
      validInteger(value.deadlineAtMs) &&
      typeof value.first === "boolean" &&
      value.mode === undefined
    );
  if (value.kind === "handshake")
    return (
      validInteger(value.deadlineAtMs) &&
      value.first === undefined &&
      (value.mode === "identify" || value.mode === "resume")
    );
  if (value.kind === "reconnect")
    return (
      value.deadlineAtMs === undefined &&
      value.first === undefined &&
      (value.mode === "fresh" || value.mode === "resume")
    );
  return value.deadlineAtMs === undefined && value.first === undefined && value.mode === undefined;
}

function validatePersistedState(value: unknown): PersistedGatewayAdapterState {
  if (!isRecord(value)) throw new TypeError("invalid_gateway_adapter_state");
  const state = value as Partial<PersistedGatewayAdapterState>;
  if (
    state.version !== 1 ||
    !validSession(state.session) ||
    !validInteger(state.connectionGeneration) ||
    !validInteger(state.constructorInvocations) ||
    !validInteger(state.reconnectAttempts) ||
    !validInteger(state.nextScheduleId, 1) ||
    !Array.isArray(state.schedules) ||
    !state.schedules.every(validSchedule) ||
    !Array.isArray(state.completedScheduleIds) ||
    !state.completedScheduleIds.every((id) => validInteger(id, 1)) ||
    new Set(state.completedScheduleIds).size !== state.completedScheduleIds.length ||
    state.completedScheduleIds.length > MAX_COMPLETED_SCHEDULE_IDS ||
    (state.checkpoint !== null && !validInteger(state.checkpoint)) ||
    (state.lastMonotonicMs !== null && !validInteger(state.lastMonotonicMs)) ||
    !validSessionStartLimit(state.sessionStartLimit) ||
    (state.safety !== null && (!isRecord(state.safety) || state.safety.version !== 1)) ||
    typeof state.metrics !== "object" ||
    state.metrics === null ||
    Object.entries(state.metrics).some(
      ([category, count]) =>
        !METRIC_CATEGORIES.has(category as GatewayAdapterMetricCategory) || !validInteger(count),
    )
  )
    throw new TypeError("invalid_gateway_adapter_state");
  if ((state.session === null) !== (state.checkpoint === null))
    throw new TypeError("invalid_gateway_adapter_state");
  const schedules = state.schedules as PersistedLogicalSchedule[];
  const scheduleIds = schedules.map((schedule) => schedule.id);
  if (
    new Set(scheduleIds).size !== scheduleIds.length ||
    schedules.some(
      (schedule) =>
        schedule.id >= (state.nextScheduleId as number) ||
        schedule.connectionGeneration > (state.connectionGeneration as number) ||
        state.completedScheduleIds?.includes(schedule.id),
    ) ||
    state.completedScheduleIds.some((id) => id >= (state.nextScheduleId as number))
  )
    throw new TypeError("invalid_gateway_adapter_state");
  return state as PersistedGatewayAdapterState;
}

function scheduleOrder(left: PersistedLogicalSchedule, right: PersistedLogicalSchedule): number {
  return left.dueWallMs - right.dueWallMs || left.id - right.id;
}

function unhandledGatewayCommand(command: never): never {
  void command;
  throw new Error("unhandled_gateway_command");
}

function ignoredCategory(
  command: RecordIgnoredDispatchCommand,
): PersistedIgnoredEvidence["authorCategory"] {
  if (command.evidence.author_is_system) return "system";
  if (command.evidence.webhook_id !== null) return "webhook";
  if (command.evidence.author_is_bot) return "bot";
  return "human";
}

async function exactStagingSpikeEvidence(db: D1Database, eventId: string): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT
          CASE WHEN e.acceptance_class='staging_spike'
            AND e.status='finalized' AND e.outcome='invalid'
            AND e.operation_id IS NULL AND e.validation_reason IS NOT NULL
            AND e.output_delivery_group IS NOT NULL
            AND e.received_at IS NOT NULL AND e.accepted_at IS NOT NULL
            AND e.committed_at IS NULL AND e.finalized_at IS e.accepted_at
          THEN 1 ELSE 0 END AS marker_exact,
          COUNT(d.delivery_id) AS output_count,
          SUM(CASE WHEN d.delivery_group IS e.output_delivery_group
            AND d.operation_id IS NULL AND d.output_type='validation_reply'
            AND d.chunk_index=1 AND d.chunk_total=1
            AND d.content<>'' AND d.content_hash<>'' AND d.nonce<>'' AND d.has_footer=0
            AND d.status='superseded' AND d.dispatch_eligible=0
            AND d.suppression_reason='staging_spike_sender'
            AND d.suppressed_at IS e.accepted_at AND d.permanent_dispatch_block=1
            AND d.blocked_at IS e.accepted_at
            AND d.claim_token IS NULL AND d.claim_expires_at IS NULL AND d.attempts=0
            AND d.discord_message_id IS NULL AND d.sent_at IS NULL
            AND d.available_at IS NULL AND d.last_error IS NULL AND d.alerted_at IS NULL
            AND d.created_at IS e.accepted_at AND d.updated_at IS e.accepted_at
          THEN 1 ELSE 0 END) AS exact_output_count,
          SUM(CASE WHEN d.status IN ('pending','claimed')
            AND d.blocked_at IS NULL AND d.dispatch_eligible=1
            AND d.permanent_dispatch_block=0 AND d.suppression_reason IS NULL
            AND d.suppressed_at IS NULL
          THEN 1 ELSE 0 END) AS dispatcher_eligible_count
        FROM processed_events e
        LEFT JOIN discord_output_deliveries d ON d.event_id=e.event_id
        WHERE e.event_id=?1
        GROUP BY e.event_id`,
      )
      .bind(eventId)
      .first<{
        marker_exact: number;
        output_count: number;
        exact_output_count: number;
        dispatcher_eligible_count: number;
      }>();
    return (
      row?.marker_exact === 1 &&
      row.output_count === 1 &&
      row.exact_output_count === 1 &&
      row.dispatcher_eligible_count === 0
    );
  } catch {
    return false;
  }
}

/**
 * Serialized adapter engine. The only path to the trusted acceptance operation starts with an
 * AcceptTargetMessageCommand emitted by the deterministic core for this connection lifecycle.
 */
export class GatewayDurableAdapter {
  readonly #storage: GatewayAdapterStorage;
  readonly #env: Env;
  readonly #config: AppConfig;
  #state: PersistedGatewayAdapterState = initialState();
  #core: GatewayProtocolState | null = null;
  #dependencies: GatewayAdapterDependencies | null = null;
  #active: ActiveConnection | null = null;
  #hydrated = false;
  #serial: Promise<void> = Promise.resolve();

  constructor(storage: GatewayAdapterStorage, env: Env) {
    this.#storage = storage;
    this.#env = env;
    this.#config = loadConfig(env);
  }

  async hydrate(): Promise<void> {
    if (this.#hydrated) return;
    const stored = await this.#storage.get<unknown>(ADAPTER_STATE_KEY);
    this.#state = stored === undefined ? initialState() : validatePersistedState(stored);
    this.#state.constructorInvocations += 1;
    this.#metric("constructor");
    await this.#persist();

    // A constructor runs before an alarm handler after activation. Preserve an alarm that the
    // platform already retained; install one only when logical work exists and none is set.
    const existingAlarm = await this.#storage.getAlarm();
    if (existingAlarm === null && this.#state.schedules.length > 0) {
      const earliest = [...this.#state.schedules].sort(scheduleOrder)[0];
      if (earliest !== undefined) await this.#storage.setAlarm(earliest.dueWallMs);
    }
    this.#hydrated = true;
  }

  configure(dependencies: GatewayAdapterDependencies): Promise<void> {
    return this.#serialize(async () => {
      this.#requireHydrated();
      this.#dependencies = dependencies;
      if (this.#state.sessionStartLimit === null) {
        this.#state.sessionStartLimit = {
          limit: { ...dependencies.sessionStartLimit },
          observedAtMs: dependencies.sessionStartLimitObservedAtMs,
        };
        await this.#persist();
      }
    });
  }

  start(): Promise<void> {
    return this.#serialize(async () => {
      this.#dependenciesOrThrow();
      if (this.#active?.valid || (this.#core !== null && this.#core.phase === "reconnecting")) {
        this.#metric("concurrent_start", "reconnect", "stale");
        await this.#persist();
        return;
      }
      if (this.#core?.phase === "halted") return;

      this.#state.connectionGeneration += 1;
      this.#core = this.#createCore(this.#state.connectionGeneration);
      this.#metric("start");
      await this.#persistCore();
      await this.#connectCurrentGeneration();
    });
  }

  alarm(): Promise<void> {
    return this.#serialize(async () => {
      const dependencies = this.#dependenciesOrThrow();
      const wallNow = this.#wallNow();
      this.#metric("alarm_delivery", "schedule", "success");
      const due = this.#state.schedules
        .filter((schedule) => schedule.dueWallMs <= wallNow)
        .sort(scheduleOrder);
      if (due.length === 0) {
        this.#metric("alarm_without_due_work", "schedule", "stale");
        await this.#persist();
        await this.#synchronizeAlarm();
        return;
      }

      for (const schedule of due) {
        const current = this.#state.schedules.find((candidate) => candidate.id === schedule.id);
        if (current === undefined) continue;
        if (wallNow > schedule.dueWallMs) this.#metric("late_alarm", "schedule", "success");
        if (schedule.connectionGeneration !== this.#state.connectionGeneration) {
          this.#metric("stale_alarm", "schedule", "stale");
          await this.#finishSchedule(schedule.id);
          continue;
        }

        // A claimed item survived an indeterminate handler. Never repeat its possibly completed
        // side effect; durably fence the generation and recover on a replacement lifecycle.
        if (current.status === "claimed") {
          await this.#recoverClaimedSchedule(current);
          continue;
        }

        this.#state.schedules = this.#state.schedules.map((candidate) =>
          candidate.id === current.id ? { ...candidate, status: "claimed" } : candidate,
        );
        this.#metric("schedule_claimed", "schedule", "success");
        await this.#persist();
        const fault = dependencies.scheduleFault?.(current.kind) ?? "proceed";
        if (fault === "fail_before") throw new Error("modeled_schedule_interruption");
        await this.#executeSchedule(schedule);
        if (fault === "lose_after") throw new Error("modeled_schedule_interruption");
        await this.#finishSchedule(schedule.id);
      }
      await this.#synchronizeAlarm();
    });
  }

  inspect(): Promise<GatewayAdapterInspection> {
    return this.#serialize(async () => {
      this.#requireHydrated();
      return {
        version: 1,
        hydrated: this.#hydrated,
        configured: this.#dependencies !== null,
        hasActiveConnection: this.#active?.valid === true,
        connectionGeneration: this.#state.connectionGeneration,
        checkpoint: this.#state.checkpoint,
        hasSession: this.#state.session !== null,
        constructorInvocations: this.#state.constructorInvocations,
        reconnectAttempts: this.#state.reconnectAttempts,
        logicalSchedules: [...this.#state.schedules].sort(scheduleOrder).map((schedule) => ({
          id: schedule.id,
          kind: schedule.kind,
          connectionGeneration: schedule.connectionGeneration,
        })),
        metrics: { ...this.#state.metrics },
        protocol: this.#core === null ? null : summarizeGatewayState(this.#core),
      };
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.#serial.then(operation, operation);
    this.#serial = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }

  #requireHydrated(): void {
    if (!this.#hydrated) throw new Error("gateway_adapter_not_hydrated");
  }

  #dependenciesOrThrow(): GatewayAdapterDependencies {
    this.#requireHydrated();
    if (this.#dependencies === null) throw new Error("gateway_adapter_not_configured");
    return this.#dependencies;
  }

  #metric(
    category: GatewayAdapterMetricCategory,
    commandCategory?: GatewayAdapterDiagnostic["commandCategory"],
    outcomeCategory?: GatewayAdapterDiagnostic["outcomeCategory"],
  ): void {
    this.#incrementMetric(category);
    this.#emitDiagnostic({
      category,
      connectionGeneration: this.#state.connectionGeneration,
      lifecycle: this.#core?.phase ?? "uninitialized",
      ...(commandCategory === undefined ? {} : { commandCategory }),
      ...(outcomeCategory === undefined ? {} : { outcomeCategory }),
    });
  }

  #incrementMetric(category: GatewayAdapterMetricCategory): void {
    const current = Object.prototype.hasOwnProperty.call(this.#state.metrics, category)
      ? (this.#state.metrics[category] ?? 0)
      : 0;
    this.#state.metrics[category] = current + 1;
  }

  #emitDiagnostic(diagnostic: GatewayAdapterDiagnostic): void {
    try {
      this.#dependencies?.diagnosticSink?.(diagnostic);
    } catch {
      // Diagnostics are observational and never participate in protocol correctness.
    }
  }

  #monotonicNow(): number {
    const value = this.#dependencies?.clock.monotonicNowMs();
    if (!validInteger(value)) throw new RangeError("invalid_gateway_adapter_clock");
    if (this.#state.lastMonotonicMs !== null && value < this.#state.lastMonotonicMs)
      throw new RangeError("non_monotonic_gateway_adapter_clock");
    this.#state.lastMonotonicMs = value;
    return value;
  }

  #wallNow(): number {
    const value = this.#dependencies?.clock.wallNowMs() ?? Date.now();
    if (!validInteger(value)) throw new RangeError("invalid_gateway_adapter_clock");
    return value;
  }

  #createCore(generation: number): GatewayProtocolState {
    const dependencies = this.#dependenciesOrThrow();
    const observation = this.#state.sessionStartLimit ?? {
      limit: dependencies.sessionStartLimit,
      observedAtMs: dependencies.sessionStartLimitObservedAtMs,
    };
    const persistedSession =
      this.#state.session === null || this.#state.checkpoint === null
        ? undefined
        : {
            handle: new GatewaySessionHandle(this.#state.session.handleReference),
            checkpoint: this.#state.checkpoint,
          };
    const safety =
      this.#state.safety === null
        ? undefined
        : {
            ...this.#state.safety,
            violationTracker: {
              checkpoint: this.#state.checkpoint,
              count:
                this.#state.safety.violationTracker.checkpoint === this.#state.checkpoint
                  ? this.#state.safety.violationTracker.count
                  : 0,
            },
          };
    return createGatewayProtocolState({
      sessionStartLimit: observation.limit,
      sessionStartLimitObservedAtMs: observation.observedAtMs,
      classifyMessage: (metadata) => this.#classifyMessage(metadata),
      connectionGeneration: generation,
      ...(persistedSession === undefined ? {} : { persistedSession }),
      ...(safety === undefined ? {} : { persistedSafety: safety }),
    });
  }

  #classifyMessage(metadata: GatewayMessageMetadata): "target" | "ignored" {
    const event: RegistrationMessageEvent = { ...metadata, content: "" };
    return classifyAcceptedAuthor(event, this.#config, true) === null ? "ignored" : "target";
  }

  async #persist(): Promise<void> {
    await this.#storage.put(ADAPTER_STATE_KEY, this.#state);
  }

  async #persistCore(): Promise<void> {
    if (this.#core !== null) {
      this.#state.connectionGeneration = Math.max(
        this.#state.connectionGeneration,
        this.#core.connectionGeneration,
      );
      this.#state.safety = snapshotGatewayProtocolSafety(this.#core);
    }
    await this.#persist();
  }

  async #synchronizeAlarm(): Promise<void> {
    const existing = await this.#storage.getAlarm();
    const earliest = [...this.#state.schedules].sort(scheduleOrder)[0];
    if (earliest === undefined) {
      if (existing !== null) await this.#storage.deleteAlarm();
      return;
    }
    if (existing !== earliest.dueWallMs) await this.#storage.setAlarm(earliest.dueWallMs);
  }

  async #addSchedule(
    input: Omit<PersistedLogicalSchedule, "id" | "status" | "dueWallMs">,
  ): Promise<void> {
    const monotonicNow = this.#monotonicNow();
    const wallNow = this.#wallNow();
    const schedule: PersistedLogicalSchedule = {
      ...input,
      id: this.#state.nextScheduleId,
      status: "pending",
      dueWallMs: wallNow + Math.max(0, input.dueMonotonicMs - monotonicNow),
    };
    this.#state.nextScheduleId += 1;
    this.#state.schedules.push(schedule);
    this.#metric("schedule_added", "schedule", "success");
    await this.#persist();
    await this.#synchronizeAlarm();
  }

  async #finishSchedule(id: number): Promise<void> {
    this.#state.schedules = this.#state.schedules.filter((candidate) => candidate.id !== id);
    if (!this.#state.completedScheduleIds.includes(id)) {
      this.#state.completedScheduleIds = [...this.#state.completedScheduleIds, id].slice(
        -MAX_COMPLETED_SCHEDULE_IDS,
      );
    }
    await this.#persist();
  }

  async #recoverClaimedSchedule(schedule: PersistedLogicalSchedule): Promise<void> {
    const lifecycle = this.#isActive(schedule.connectionGeneration) ? this.#active : null;
    if (lifecycle !== null) lifecycle.valid = false;
    this.#active = null;
    this.#core = null;
    if (this.#state.connectionGeneration <= schedule.connectionGeneration)
      this.#state.connectionGeneration = schedule.connectionGeneration + 1;
    this.#state.schedules = this.#state.schedules.filter(
      (candidate) => candidate.id !== schedule.id,
    );
    if (!this.#state.completedScheduleIds.includes(schedule.id)) {
      this.#state.completedScheduleIds = [...this.#state.completedScheduleIds, schedule.id].slice(
        -MAX_COMPLETED_SCHEDULE_IDS,
      );
    }
    this.#metric("schedule_ambiguous_recovery", "schedule", "ambiguous");
    await this.#persist();
    try {
      await lifecycle?.socket?.close(4000);
    } catch {
      // The durable generation fence precedes this best-effort transport cleanup.
    }
    await this.#scheduleReconnect(
      this.#state.session !== null && this.#state.checkpoint !== null ? "resume" : "fresh",
    );
  }

  async #removeSchedules(
    kind: PersistedLogicalSchedule["kind"],
    generation: number,
  ): Promise<void> {
    const before = this.#state.schedules.length;
    this.#state.schedules = this.#state.schedules.filter(
      (schedule) => schedule.kind !== kind || schedule.connectionGeneration !== generation,
    );
    if (this.#state.schedules.length !== before) {
      await this.#persist();
      await this.#synchronizeAlarm();
    }
  }

  async #connectCurrentGeneration(): Promise<void> {
    const dependencies = this.#dependenciesOrThrow();
    if (this.#core === null) throw new Error("gateway_protocol_not_initialized");
    const generation = this.#state.connectionGeneration;
    if (this.#active?.valid) return;
    const lifecycle: ActiveConnection = { generation, valid: true, socket: null };
    this.#active = lifecycle;
    const now = this.#monotonicNow();
    await this.#addSchedule({
      kind: "watchdog",
      connectionGeneration: generation,
      dueMonotonicMs: now + (dependencies.helloWatchdogMs ?? DEFAULT_HELLO_WATCHDOG_MS),
    });

    const mode = this.#core.connectionIntent;
    const target = new OpaqueGatewayConnectionTarget(
      mode === "resume" ? (this.#state.session?.resumeGatewayUrl ?? null) : null,
    );
    try {
      const socket = await dependencies.webSocketFactory.connect({
        connectionGeneration: generation,
        mode,
        target,
        callbacks: {
          opened: () => this.#socketOpened(generation),
          text: (message) => this.#socketText(generation, message),
          closed: (code) => this.#socketClosed(generation, code),
          failed: () => this.#socketFailed(generation),
        },
      });
      if (this.#active !== lifecycle || !lifecycle.valid) {
        await socket.close(4000);
        this.#metric("stale_effect_completion", "reconnect", "stale");
        await this.#persist();
        return;
      }
      lifecycle.socket = socket;
    } catch {
      if (this.#active === lifecycle && lifecycle.valid) {
        await this.#fenceConnection(generation);
        this.#metric("socket_failure", "reconnect", "failed");
        await this.#applyTransition(gatewayConnectionClosed(this.#core, null));
      }
    }
  }

  #socketOpened(generation: number): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#isActive(generation)) {
        this.#metric("stale_socket_callback", "reconnect", "stale");
      } else {
        this.#metric("socket_open", "reconnect", "success");
      }
      await this.#persist();
    });
  }

  #socketText(generation: number, message: string): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#isActive(generation) || this.#core === null) {
        this.#metric("stale_socket_callback", "reconnect", "stale");
        await this.#persist();
        return;
      }
      const now = this.#monotonicNow();
      const previousPhase = this.#core.phase;
      const dependencies = this.#dependenciesOrThrow();
      const transition = receiveGatewayText(this.#core, message, {
        nowMs: now,
        firstHeartbeatJitter: dependencies.firstHeartbeatJitter(),
      });
      if (previousPhase === "connecting" && transition.state.phase === "hello")
        await this.#removeSchedules("watchdog", generation);
      await this.#applyTransition(transition);
      if (previousPhase === "connecting" && this.#core?.phase === "hello") {
        const deadlineAtMs =
          now + (dependencies.handshakeDeadlineMs ?? DEFAULT_HANDSHAKE_DEADLINE_MS);
        await this.#applyTransition(
          beginGatewayHandshake(this.#core, { nowMs: now, deadlineAtMs }),
        );
      }
    });
  }

  #socketClosed(generation: number, code: number | null): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#isActive(generation) || this.#core === null) {
        this.#metric("stale_socket_callback", "close", "stale");
        await this.#persist();
        return;
      }
      await this.#fenceConnection(generation);
      this.#metric("socket_close", "close", "success");
      await this.#applyTransition(gatewayConnectionClosed(this.#core, code));
    });
  }

  #socketFailed(generation: number): Promise<void> {
    return this.#serialize(async () => {
      if (!this.#isActive(generation) || this.#core === null) {
        this.#metric("stale_socket_callback", "close", "stale");
        await this.#persist();
        return;
      }
      await this.#fenceConnection(generation);
      this.#metric("socket_failure", "close", "failed");
      await this.#applyTransition(gatewayConnectionClosed(this.#core, null));
    });
  }

  #isActive(generation: number): boolean {
    return this.#active?.valid === true && this.#active.generation === generation;
  }

  async #fenceConnection(generation: number): Promise<GatewayWebSocketConnection | null> {
    if (!this.#isActive(generation)) return null;
    const lifecycle = this.#active;
    if (lifecycle === null) return null;
    lifecycle.valid = false;
    this.#active = null;
    if (this.#state.connectionGeneration <= generation)
      this.#state.connectionGeneration = generation + 1;
    await this.#persist();
    return lifecycle.socket;
  }

  async #applyTransition(transition: GatewayTransition): Promise<void> {
    const heartbeatAcknowledged =
      this.#core?.heartbeat?.ackOutstanding === true &&
      transition.state.heartbeat?.ackOutstanding === false;
    this.#core = transition.state;
    if (heartbeatAcknowledged) this.#metric("heartbeat_ack");
    for (const _diagnostic of transition.diagnostics) this.#recordProtocolDiagnostic(_diagnostic);
    if (this.#core.phase === "active") this.#state.reconnectAttempts = 0;
    await this.#persistCore();
    for (const command of transition.commands) await this.#executeCommand(command);
  }

  #recordProtocolDiagnostic(diagnostic: GatewayDiagnostic): void {
    this.#incrementMetric("protocol_diagnostic");
    this.#emitDiagnostic({
      category: "protocol_diagnostic",
      connectionGeneration: diagnostic.connectionGeneration,
      lifecycle: diagnostic.state,
      protocolCategory: diagnostic.category,
      occurrenceCount: diagnostic.occurrenceCount,
      ...(diagnostic.knownOpcodeCategory === undefined
        ? {}
        : { knownOpcodeCategory: diagnostic.knownOpcodeCategory }),
      ...(diagnostic.sequenceRelation === undefined
        ? {}
        : { sequenceRelation: diagnostic.sequenceRelation }),
    });
  }

  async #executeCommand(command: GatewayCommand): Promise<void> {
    switch (command.type) {
      case "schedule_heartbeat":
        await this.#addSchedule({
          kind: "heartbeat",
          connectionGeneration:
            this.#core?.connectionGeneration ?? this.#state.connectionGeneration,
          dueMonotonicMs: command.atMs,
          deadlineAtMs: command.deadlineAtMs,
          first: command.first,
        });
        return;
      case "schedule_handshake":
        await this.#addSchedule({
          kind: "handshake",
          connectionGeneration:
            this.#core?.connectionGeneration ?? this.#state.connectionGeneration,
          dueMonotonicMs: command.atMs,
          deadlineAtMs: command.deadlineAtMs,
          mode: command.mode,
        });
        return;
      case "send_gateway_event":
        await this.#sendGatewayEvent(command);
        return;
      case "persist_ready_session":
        await this.#persistReadySession(command);
        return;
      case "accept_target_message":
        await this.#acceptTargetMessage(command.effectId, command.event);
        return;
      case "record_ignored_dispatch":
        await this.#recordIgnored(command);
        return;
      case "checkpoint_dispatch":
        await this.#checkpoint(command.effectId, command.sequence);
        return;
      case "clear_gateway_session":
        await this.#clearSession(command.effectId);
        return;
      case "close_gateway_connection":
        await this.#closeConnection(command.code);
        return;
      case "reconnect_gateway":
        await this.#scheduleReconnect(command.mode);
        return;
      default:
        return unhandledGatewayCommand(command);
    }
  }

  async #sendGatewayEvent(command: SendGatewayEventCommand): Promise<void> {
    if (
      this.#core === null ||
      !this.#isActive(command.connectionGeneration) ||
      command.connectionGeneration !== this.#core.connectionGeneration
    ) {
      this.#metric("stale_effect_completion", "send", "stale");
      await this.#persist();
      return;
    }
    const socket = this.#active?.socket;
    if (socket === null || socket === undefined) {
      await this.#completeOutbound(command, "ambiguous");
      return;
    }
    const event = command.event;
    if (event.kind === "identify") this.#metric("identify", "send", "success");
    if (event.kind === "resume") this.#metric("resume", "send", "success");
    if (event.kind === "heartbeat_regular") this.#metric("heartbeat_regular", "send", "success");
    if (event.kind === "heartbeat_requested")
      this.#metric("heartbeat_requested", "send", "success");
    this.#metric("outbound_gate_pressure", "send", "success");

    let sessionId: string | null = null;
    if (event.kind === "resume") {
      const session = this.#state.session;
      if (session === null || session.handleReference !== event.session.forPersistenceAdapter()) {
        await this.#completeOutbound(command, "ambiguous");
        return;
      }
      sessionId = session.sessionId;
    }
    let result: GatewayTransportResult;
    try {
      result = await socket.send(event, new OpaqueGatewaySendContext(sessionId));
    } catch {
      result = "ambiguous";
    }
    await this.#completeOutbound(command, result);
  }

  async #completeOutbound(
    command: SendGatewayEventCommand,
    result: GatewayTransportResult,
  ): Promise<void> {
    if (this.#core === null || command.connectionGeneration !== this.#core.connectionGeneration) {
      this.#metric("stale_effect_completion", "send", "stale");
      await this.#persist();
      return;
    }
    this.#metric(
      result === "sent"
        ? "outbound_sent"
        : result === "failed"
          ? "outbound_failed"
          : "outbound_ambiguous",
      "send",
      result === "sent" ? "success" : result,
    );
    await this.#applyTransition(
      completeGatewayOutbound(this.#core, {
        authorizationId: command.authorizationId,
        result,
      }),
    );
  }

  #fault(effect: GatewayAdapterDurableEffect): GatewayAdapterFaultAction {
    try {
      return this.#dependencies?.durableEffectFault?.(effect) ?? "proceed";
    } catch {
      return "fail_before";
    }
  }

  async #persistReadySession(
    command: Extract<GatewayCommand, { type: "persist_ready_session" }>,
  ): Promise<void> {
    const action = this.#fault("ready_session");
    if (action === "fail_before") {
      await this.#completeEffect({
        effectId: command.effectId,
        type: "ready_session_persistence",
        outcome: "failed",
      });
      return;
    }
    const material = command.material.forPersistence();
    const handleReference = "gateway-session-v1";
    if (this.#state.checkpoint !== null && command.sequence < this.#state.checkpoint) {
      await this.#completeEffect({
        effectId: command.effectId,
        type: "ready_session_persistence",
        outcome: "failed",
      });
      return;
    }
    this.#state.session = { handleReference, ...material };
    this.#state.checkpoint = command.sequence;
    await this.#persist();
    this.#metric("ready_persisted", "ready", "success");
    await this.#persist();
    await this.#completeEffect(
      action === "lose_after"
        ? {
            effectId: command.effectId,
            type: "ready_session_persistence",
            outcome: "ambiguous",
          }
        : {
            effectId: command.effectId,
            type: "ready_session_persistence",
            outcome: "persisted",
            session: new GatewaySessionHandle(handleReference),
          },
    );
  }

  async #acceptTargetMessage(effectId: number, event: RegistrationMessageEvent): Promise<void> {
    let outcome: GatewayTargetAcceptanceOutcome;
    try {
      outcome = this.#dependencies?.targetAcceptance
        ? await this.#dependencies.targetAcceptance(event)
        : await this.#trustedAcceptance(event);
    } catch {
      outcome = "ambiguous";
    }
    const metric: GatewayAdapterMetricCategory =
      outcome === "accepted"
        ? "acceptance_accepted"
        : outcome === "duplicate"
          ? "acceptance_duplicate"
          : outcome === "rejected"
            ? "acceptance_rejected"
            : outcome === "failed"
              ? "acceptance_failed"
              : outcome === "timeout"
                ? "acceptance_timeout"
                : "acceptance_ambiguous";
    this.#metric(metric, "acceptance", outcome === "accepted" ? "success" : outcome);
    await this.#persist();
    await this.#completeEffect({
      effectId,
      type: "target_acceptance",
      outcome: outcome === "timeout" ? "ambiguous" : outcome,
    });
  }

  async #trustedAcceptance(
    event: RegistrationMessageEvent,
  ): Promise<GatewayTargetAcceptanceOutcome> {
    const now = new Date(this.#wallNow());
    if (!isRegistrationMessageEvent(event, now)) return "rejected";
    const acceptanceClass = classifyAcceptedAuthor(event, this.#config, true);
    if (acceptanceClass === null) return "rejected";
    const outcome = await acceptRegistrationEvent({
      db: this.#env.STAGING_DB,
      config: this.#config,
      event,
      parsed: parseRegistration(event.content, this.#config.defaultState),
      acceptanceClass,
      now,
      attemptRunId: newAttemptRunId(),
    });
    if (outcome.kind === "rejected") return "rejected";
    if (outcome.kind === "duplicate") {
      if (acceptanceClass !== "staging_spike") return "duplicate";
      return (await exactStagingSpikeEvidence(this.#env.STAGING_DB, event.event_id))
        ? "duplicate"
        : "rejected";
    }
    if (outcome.kind === "accepted_valid") {
      try {
        await dispatchOutbox({
          db: this.#env.STAGING_DB,
          config: this.#config,
          now,
          queues: {
            registration: this.#env.REGISTRATION_JOBS_QUEUE,
            distribution: this.#env.CODE_FANOUT_JOBS_QUEUE,
          },
          source: {
            kind: "operation",
            operationId: outcome.operationId,
            limit: INLINE_DISPATCH_LIMIT,
          },
        });
      } catch {
        // Durable acceptance already succeeded; scheduled outbox dispatch remains authoritative.
      }
    }
    return "accepted";
  }

  async #recordIgnored(command: RecordIgnoredDispatchCommand): Promise<void> {
    const action = this.#fault("ignored_evidence");
    if (action === "fail_before") {
      await this.#completeEffect({
        effectId: command.effectId,
        type: "ignored_evidence",
        outcome: "failed",
      });
      return;
    }
    const key = `${IGNORED_EVIDENCE_PREFIX}${command.sequence}`;
    const expected: PersistedIgnoredEvidence = {
      version: 1,
      sequence: command.sequence,
      reason: command.evidence.reason,
      authorCategory: ignoredCategory(command),
    };
    const existing = await this.#storage.get<PersistedIgnoredEvidence>(key);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(expected)) {
      await this.#completeEffect({
        effectId: command.effectId,
        type: "ignored_evidence",
        outcome: "ambiguous",
      });
      return;
    }
    if (existing === undefined) await this.#storage.put(key, expected);
    this.#metric("ignored_recorded", "ignored", "success");
    await this.#persist();
    await this.#completeEffect({
      effectId: command.effectId,
      type: "ignored_evidence",
      outcome: action === "lose_after" ? "ambiguous" : "recorded",
    });
  }

  async #checkpoint(effectId: number, sequence: number): Promise<void> {
    const action = this.#fault("checkpoint");
    if (
      action === "fail_before" ||
      (this.#state.checkpoint !== null && sequence < this.#state.checkpoint)
    ) {
      await this.#completeEffect({
        effectId,
        type: "checkpoint_persistence",
        outcome: "failed",
      });
      return;
    }
    if (this.#state.checkpoint === null || sequence > this.#state.checkpoint) {
      this.#state.checkpoint = sequence;
      await this.#persist();
    }
    this.#metric("checkpoint_persisted", "checkpoint", "success");
    await this.#persist();
    await this.#completeEffect({
      effectId,
      type: "checkpoint_persistence",
      outcome: action === "lose_after" ? "ambiguous" : "persisted",
    });
  }

  async #clearSession(effectId: number): Promise<void> {
    const action = this.#fault("session_clear");
    if (action === "fail_before") {
      await this.#completeEffect({
        effectId,
        type: "session_clear",
        outcome: "failed",
      });
      return;
    }
    this.#state.session = null;
    this.#state.checkpoint = null;
    await this.#persist();
    this.#metric("session_cleared", "session_clear", "success");
    await this.#persist();
    await this.#completeEffect({
      effectId,
      type: "session_clear",
      outcome: action === "lose_after" ? "ambiguous" : "cleared",
    });
  }

  async #completeEffect(completion: GatewayEffectCompletion): Promise<void> {
    if (this.#core === null) {
      this.#metric("stale_effect_completion", undefined, "stale");
      await this.#persist();
      return;
    }
    await this.#applyTransition(completeGatewayEffect(this.#core, completion));
  }

  async #closeConnection(code: number): Promise<void> {
    const generation = this.#core?.connectionGeneration ?? this.#state.connectionGeneration;
    const socket = await this.#fenceConnection(generation);
    try {
      await socket?.close(code);
    } catch {
      // Closing is best effort after the generation fence is already durable.
    }
  }

  async #scheduleReconnect(mode: "resume" | "fresh"): Promise<void> {
    const dependencies = this.#dependenciesOrThrow();
    const attempt = this.#state.reconnectAttempts + 1;
    const delay = dependencies.reconnectBackoffMs(attempt);
    this.#state.reconnectAttempts = attempt;
    if (delay === null || !validInteger(delay)) {
      this.#metric("retry_exhausted", "reconnect", "exhausted");
      await this.#persist();
      return;
    }
    const now = this.#monotonicNow();
    this.#metric("reconnect_scheduled", "reconnect", "success");
    await this.#addSchedule({
      kind: "reconnect",
      connectionGeneration: this.#state.connectionGeneration,
      dueMonotonicMs: now + delay,
      mode,
    });
  }

  async #executeSchedule(schedule: PersistedLogicalSchedule): Promise<void> {
    if (schedule.kind === "reconnect") {
      if (this.#dependencies === null || this.#active?.valid) {
        this.#metric("stale_alarm", "reconnect", "stale");
        await this.#persist();
        return;
      }
      this.#core = this.#createCore(schedule.connectionGeneration);
      await this.#persistCore();
      await this.#connectCurrentGeneration();
      return;
    }
    if (this.#core === null) {
      // The physical lifecycle vanished with an earlier isolate. Treat its claimed logical work
      // conservatively, fence the persisted generation, and let the one-alarm scheduler resume.
      await this.#recoverClaimedSchedule(schedule);
      return;
    }
    if (this.#core.connectionGeneration !== schedule.connectionGeneration) {
      this.#metric("stale_alarm", "schedule", "stale");
      await this.#persist();
      return;
    }
    if (schedule.kind === "heartbeat") {
      // The core consumes the logical deadline, while late physical delivery is separately
      // counted. This avoids assuming exact platform alarm timing.
      await this.#applyTransition(gatewayHeartbeatDue(this.#core, schedule.dueMonotonicMs));
      return;
    }
    if (schedule.kind === "handshake") {
      const now = Math.max(this.#monotonicNow(), schedule.dueMonotonicMs);
      await this.#applyTransition(
        beginGatewayHandshake(this.#core, {
          nowMs: now,
          deadlineAtMs: schedule.deadlineAtMs ?? schedule.dueMonotonicMs,
        }),
      );
      return;
    }

    const generation = schedule.connectionGeneration;
    const socket = await this.#fenceConnection(generation);
    try {
      await socket?.close(4000);
    } catch {
      // The durable fence, not transport close acknowledgement, owns correctness.
    }
    this.#metric("socket_failure", "close", "timeout");
    await this.#applyTransition(gatewayConnectionClosed(this.#core, null));
  }
}

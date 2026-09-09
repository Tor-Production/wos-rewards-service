import { env } from "cloudflare:workers";
import { loadConfig, type AppConfig } from "../../src/config";
import type { RegistrationMessageEvent } from "../../src/domain/discord-event";
import type { OutboxJobType, QueueProducer, RedemptionJobBody } from "../../src/domain/queue-jobs";
import {
  QUEUE_MESSAGE_METADATA_BYTES,
  SAFE_BATCH_BYTES,
  SAFE_BATCH_MESSAGES,
  SAFE_MESSAGE_BYTES,
} from "../../src/limits";
import { estimateBodyBytes, type OutboxRow } from "../../src/outbox/packing";

export const FIXTURE_NOW = new Date("2026-09-07T12:00:00.000Z");

/** Synthetic decimal identifiers, independent of test order and JS number precision. */
export function uniqueId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return bytes.reduce((value, byte) => value * 256n + BigInt(byte), 0n).toString();
}

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig(env), ...overrides };
}

export function makeEvent(
  overrides: Partial<RegistrationMessageEvent> = {},
): RegistrationMessageEvent {
  return {
    event_id: uniqueId(),
    guild_id: env.DISCORD_GUILD_ID,
    channel_id: env.DISCORD_REGISTRATION_CHANNEL_ID,
    author_id: uniqueId(),
    author_is_bot: false,
    author_is_system: false,
    webhook_id: null,
    application_id: null,
    content: uniqueId(),
    created_at: FIXTURE_NOW.toISOString(),
    ...overrides,
  };
}

export function ingestRequest(event: RegistrationMessageEvent): Request {
  return new Request("https://synthetic.invalid/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.INGESTION_SHARED_SECRET}`,
    },
    body: JSON.stringify(event),
  });
}

export async function seedCodes(
  db: D1Database,
  codes: readonly (string | { code: string; status?: "active" | "disabled" | "expired" })[],
  now = FIXTURE_NOW,
): Promise<void> {
  if (codes.length === 0) return;
  await db
    .prepare(
      `INSERT INTO gift_codes (code, status, discovered_at, source)
       SELECT json_extract(value, '$.code'), json_extract(value, '$.status'), ?1, 'synthetic-test'
       FROM json_each(?2)`,
    )
    .bind(
      now.toISOString(),
      JSON.stringify(
        codes.map((entry) =>
          typeof entry === "string"
            ? { code: entry, status: "active" }
            : { code: entry.code, status: entry.status ?? "active" },
        ),
      ),
    )
    .run();
}

export async function seedPlayer(
  db: D1Database,
  playerId: string,
  state = "0",
  displayName: string | null = null,
  now = FIXTURE_NOW,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO players (player_id, state, state_updated_at, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?3, ?3)",
    )
    .bind(playerId, state, now.toISOString(), displayName)
    .run();
}

export async function disableCodes(db: D1Database, codes: readonly string[]): Promise<void> {
  if (codes.length === 0) return;
  await db
    .prepare(
      "UPDATE gift_codes SET status='disabled' WHERE code IN (SELECT value FROM json_each(?1))",
    )
    .bind(JSON.stringify(codes))
    .run();
}

export async function closeOutbox(db: D1Database, operationIds: readonly string[]): Promise<void> {
  if (operationIds.length === 0) return;
  await db
    .prepare(
      "UPDATE outbox_jobs SET status='dead' WHERE status='pending' AND operation_id IN (SELECT value FROM json_each(?1))",
    )
    .bind(JSON.stringify(operationIds))
    .run();
}

export async function seedOperation(
  db: D1Database,
  operationId: string,
  overrides: {
    triggerRef?: string;
    expectedCount?: number;
    type?: "registration_run" | "code_distribution_run" | "repair_run";
    now?: Date;
  } = {},
): Promise<void> {
  const now = overrides.now ?? FIXTURE_NOW;
  await db
    .prepare(
      `INSERT INTO operations
       (operation_id, type, trigger_kind, trigger_ref, snapshot_at, expected_count,
        expansion_state, deadline_at, created_at, updated_at)
       VALUES (?1, ?2, 'discord_event', ?3, ?4, ?5, 'expanded', ?6, ?4, ?4)`,
    )
    .bind(
      operationId,
      overrides.type ?? "registration_run",
      overrides.triggerRef ?? uniqueId(),
      now.toISOString(),
      overrides.expectedCount ?? 0,
      new Date(now.getTime() + 3_600_000).toISOString(),
    )
    .run();
}

export interface PreparedRecord {
  readonly sql: string;
  bindings: readonly unknown[];
}

/** Counts attempted SQL statements, including every member of a failed batch. */
export function countD1(database: D1Database): {
  db: D1Database;
  stats: {
    statements: number;
    batchSizes: number[];
    prepared: PreparedRecord[];
    maxBindings: number;
  };
} {
  const stats = {
    statements: 0,
    batchSizes: [] as number[],
    prepared: [] as PreparedRecord[],
    maxBindings: 0,
  };
  const original = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(statement: D1PreparedStatement, record: PreparedRecord): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...bindings: unknown[]) => {
            record.bindings = bindings;
            stats.maxBindings = Math.max(stats.maxBindings, bindings.length);
            return wrap(target.bind(...bindings), record);
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (["all", "first", "raw", "run"].includes(String(property))) stats.statements++;
          return Reflect.apply(value, target, args);
        };
      },
    });
    original.set(proxy, statement);
    return proxy;
  }
  const db = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          const record: PreparedRecord = { sql, bindings: [] };
          stats.prepared.push(record);
          return wrap(target.prepare(sql), record);
        };
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => {
          stats.statements += statements.length;
          stats.batchSizes.push(statements.length);
          return target.batch(statements.map((statement) => original.get(statement) ?? statement));
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db, stats };
}

export class RecordingQueue implements QueueProducer {
  readonly calls: RedemptionJobBody[][] = [];

  get bodies(): RedemptionJobBody[] {
    return this.calls.flat();
  }

  async sendBatch(messages: Iterable<{ body: RedemptionJobBody }>): Promise<void> {
    this.calls.push(Array.from(messages, ({ body }) => body));
  }
}

export class FailingQueue extends RecordingQueue {
  override async sendBatch(messages: Iterable<{ body: RedemptionJobBody }>): Promise<void> {
    await super.sendBatch(messages);
    throw new Error("synthetic queue failure");
  }
}

export class SizeAwareQueue extends RecordingQueue {
  override async sendBatch(messages: Iterable<{ body: RedemptionJobBody }>): Promise<void> {
    const list = [...messages];
    const charges = list.map(({ body }) => estimateBodyBytes(body) + QUEUE_MESSAGE_METADATA_BYTES);
    if (
      list.length > SAFE_BATCH_MESSAGES ||
      charges.some((bytes) => bytes > SAFE_MESSAGE_BYTES) ||
      charges.reduce((sum, bytes) => sum + bytes, 0) > SAFE_BATCH_BYTES
    ) {
      throw new Error("synthetic queue size violation");
    }
    await super.sendBatch(list);
  }
}

export interface SendConcurrency {
  inFlight: number;
  maxInFlight: number;
}

/** Pass the same tracker to both queues to observe combined connection usage. */
export class ConcurrencyTrackingQueue extends SizeAwareQueue {
  constructor(
    readonly tracker: SendConcurrency = { inFlight: 0, maxInFlight: 0 },
    private readonly pause: () => Promise<void> = () =>
      new Promise((resolve) => setTimeout(resolve, 1)),
  ) {
    super();
  }

  get maxInFlight(): number {
    return this.tracker.maxInFlight;
  }

  override async sendBatch(messages: Iterable<{ body: RedemptionJobBody }>): Promise<void> {
    this.tracker.inFlight++;
    this.tracker.maxInFlight = Math.max(this.tracker.maxInFlight, this.tracker.inFlight);
    try {
      await this.pause();
      await super.sendBatch(messages);
    } finally {
      this.tracker.inFlight--;
    }
  }
}

export interface OutboxSeed {
  readonly type?: OutboxJobType;
  readonly attempts?: number;
  readonly body?: Partial<RedemptionJobBody>;
  readonly payloadJson?: string;
  readonly availableAt?: Date;
  readonly status?: "pending" | "enqueued" | "dead";
}

/** Codes start disabled; large Queue-size fixtures use bounded D1 string parameters. */
export async function seedOutbox(
  db: D1Database,
  seeds: readonly OutboxSeed[],
  now = FIXTURE_NOW,
): Promise<{ operationId: string; rows: OutboxRow[]; bodies: RedemptionJobBody[] }> {
  const operationId = `test-${crypto.randomUUID()}`;
  const playerId = uniqueId();
  await seedPlayer(db, playerId, "0", null, now);
  await seedOperation(db, operationId, { expectedCount: seeds.length, now });
  const data = seeds.map((seed, index) => {
    const type = seed.type ?? "registration";
    const code = `${operationId}:${index}`;
    const itemKey = String(index).padStart(3, "0");
    const jobId = `${type}:${operationId}:${itemKey}`;
    const body: RedemptionJobBody = {
      operation_id: operationId,
      item_key: itemKey,
      job_id: jobId,
      player_id: playerId,
      code,
      attempt_id: `attempt:${operationId}:${itemKey}`,
      ...seed.body,
    };
    return {
      code,
      itemKey,
      jobId,
      type,
      attempts: seed.attempts ?? 0,
      status: seed.status ?? "pending",
      availableAt: (seed.availableAt ?? now).toISOString(),
      payload: seed.payloadJson ?? JSON.stringify(body),
      body,
    };
  });
  await seedCodes(
    db,
    data.map(({ code }) => ({ code, status: "disabled" })),
    now,
  );
  await db
    .prepare(
      `INSERT INTO operation_items
         (operation_id, item_key, player_id, code, job_id, display_label, updated_at)
         SELECT ?1, json_extract(value, '$.itemKey'), ?2, json_extract(value, '$.code'),
                json_extract(value, '$.jobId'), 'Synthetic player', ?3 FROM json_each(?4)`,
    )
    .bind(
      operationId,
      playerId,
      now.toISOString(),
      JSON.stringify(data.map(({ code, itemKey, jobId }) => ({ code, itemKey, jobId }))),
    )
    .run();
  const outboxData = data.map(({ body: entryBody, ...entry }) => ({
    ...entry,
    attemptId: entryBody.attempt_id,
  }));
  // Eight worst-case 96 KB payloads fit under D1's 2 MB per-string ceiling even
  // after JSON escaping. Setup does not count toward a measured Worker invocation.
  for (let offset = 0; offset < outboxData.length; offset += 8) {
    await db
      .prepare(
        `INSERT INTO outbox_jobs
         (job_id, operation_id, item_key, type, attempt_id, payload_json, status, attempts,
          available_at, created_at, updated_at)
         SELECT json_extract(value, '$.jobId'), ?1, json_extract(value, '$.itemKey'),
                json_extract(value, '$.type'), json_extract(value, '$.attemptId'),
                json_extract(value, '$.payload'), json_extract(value, '$.status'),
                json_extract(value, '$.attempts'), json_extract(value, '$.availableAt'), ?2, ?2
         FROM json_each(?3)`,
      )
      .bind(operationId, now.toISOString(), JSON.stringify(outboxData.slice(offset, offset + 8)))
      .run();
  }
  return {
    operationId,
    rows: data.map((entry) => ({
      job_id: entry.jobId,
      attempt_id: entry.body.attempt_id,
      type: entry.type,
      payload_json: entry.payload,
      attempts: entry.attempts,
    })),
    bodies: data.map(({ body }) => body),
  };
}

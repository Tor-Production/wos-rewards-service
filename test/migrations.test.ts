import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * Migration and schema contract tests for `migrations/0001_initial_schema.sql`.
 *
 * These run against the real Workers-runtime D1 implementation (Miniflare), not a Node
 * SQLite shim. `test/apply-migrations.ts` applies the migration set before any test runs.
 *
 * Every test is self-contained: it creates whatever rows it needs and asserts only on the
 * schema or on its own rows. No test reads another test's writes, no test depends on
 * declaration order, and no test assumes a table is globally empty — so the suite is correct
 * whether the pool isolates storage per test, per test file, or not at all.
 */

const db = env.STAGING_DB;

const MIGRATION_NAME = "0001_initial_schema.sql";
const MIGRATIONS_LEDGER = "d1_migrations";

/** The twelve application tables of docs/architecture/data-model-and-outbox.md section 12. */
const APPLICATION_TABLES = [
  "discord_output_deliveries",
  "gift_codes",
  "operation_items",
  "operation_late_results",
  "operation_players_snapshot",
  "operations",
  "outbox_jobs",
  "players",
  "processed_events",
  "redemptions",
  "summary_chunk_layout",
  "summary_item_snapshot",
] as const;

/** Every user table the migration set is allowed to leave behind: the twelve plus the ledger. */
const EXPECTED_USER_TABLES = [...APPLICATION_TABLES, MIGRATIONS_LEDGER].sort();

// ---------------------------------------------------------------------------------------
// Read-only schema helpers.
//
// All of these use pragmas that workerd's SQLite authorizer permits, so they behave the same
// in Miniflare and on production D1. Pragmas do not accept bound parameters, so table and
// index names are interpolated — always from the fixed lists above, never from a value.
// ---------------------------------------------------------------------------------------

function quoteId(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function pragma<T>(sql: string): Promise<T[]> {
  const { results } = await db.prepare(sql).all<T>();
  return results;
}

interface TableListRow {
  schema: string;
  name: string;
  type: string;
}

/** Every user table, INCLUDING the `d1_migrations` ledger. SQLite/Miniflare internals only are dropped. */
async function userTables(): Promise<string[]> {
  const rows = await pragma<TableListRow>("PRAGMA table_list");
  return rows
    .filter((row) => row.schema === "main" && row.type === "table")
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("_cf_"));
}

/** The application tables: every user table except the migration ledger, excluded by name. */
async function applicationTables(): Promise<string[]> {
  return (await userTables()).filter((name) => name !== MIGRATIONS_LEDGER);
}

interface ColumnInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

async function columns(table: string): Promise<ColumnInfoRow[]> {
  return pragma<ColumnInfoRow>(`PRAGMA table_info(${quoteId(table)})`);
}

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

async function indexList(table: string): Promise<IndexListRow[]> {
  return pragma<IndexListRow>(`PRAGMA index_list(${quoteId(table)})`);
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string | null;
}

async function indexColumns(index: string): Promise<(string | null)[]> {
  const rows = await pragma<IndexInfoRow>(`PRAGMA index_info(${quoteId(index)})`);
  return [...rows].sort((a, b) => a.seqno - b.seqno).map((row) => row.name);
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_update: string;
  on_delete: string;
}

async function foreignKeys(table: string): Promise<ForeignKeyRow[]> {
  return pragma<ForeignKeyRow>(`PRAGMA foreign_key_list(${quoteId(table)})`);
}

interface ForeignKeyConstraint {
  table: string;
  columnPairs: [string, string | null][];
  on_update: string;
  on_delete: string;
}

/**
 * Collapse `PRAGMA foreign_key_list` rows into constraints.
 *
 * A composite foreign key emits one row per column pair, all sharing an `id` and ordered by
 * `seq`. Both fields are used here — `id` to group and `seq` to order — so a composite key is
 * proved to be one ordered constraint rather than several single-column ones. The absolute
 * value of `id` is assigned by SQLite and is never asserted.
 */
function groupForeignKeys(rows: ForeignKeyRow[]): ForeignKeyConstraint[] {
  const byId = new Map<number, ForeignKeyRow[]>();
  for (const row of rows) {
    byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
  }
  return [...byId.values()]
    .map((group) => {
      const ordered = [...group].sort((a, b) => a.seq - b.seq);
      const first = ordered[0]!;
      return {
        table: first.table,
        columnPairs: ordered.map((row) => [row.from, row.to] as [string, string | null]),
        on_update: first.on_update,
        on_delete: first.on_delete,
      };
    })
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function ledgerRows(): Promise<{ id: number; name: string }[]> {
  const { results } = await db
    .prepare(`SELECT id, name FROM ${quoteId(MIGRATIONS_LEDGER)} ORDER BY id`)
    .all<{ id: number; name: string }>();
  return results;
}

/** A deep-comparable picture of the whole schema, for the re-application test. */
async function schemaSnapshot(): Promise<unknown> {
  const perTable: Record<string, unknown> = {};
  for (const table of APPLICATION_TABLES) {
    perTable[table] = {
      columns: await columns(table),
      indexes: (await indexList(table))
        .map(({ name, unique, origin, partial }) => ({ name, unique, origin, partial }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      foreignKeys: groupForeignKeys(await foreignKeys(table)),
    };
  }
  return { tables: (await userTables()).sort(), perTable };
}

// ---------------------------------------------------------------------------------------
// Failure-kind assertions.
//
// Every CHECK in the migration is named, so a failure names the exact rule. No test here uses
// a bare `rejects.toThrow()`: a test must never pass because an unrelated NOT NULL, PRIMARY
// KEY or FOREIGN KEY constraint rejected the row first.
// ---------------------------------------------------------------------------------------

async function expectCheckFailure(work: Promise<unknown>, constraint: string): Promise<void> {
  await expect(work).rejects.toThrow(new RegExp(`CHECK constraint failed: ${constraint}`, "i"));
}

async function expectForeignKeyFailure(work: Promise<unknown>): Promise<void> {
  await expect(work).rejects.toThrow(/FOREIGN KEY constraint failed/i);
}

async function expectUniqueFailure(work: Promise<unknown>): Promise<void> {
  await expect(work).rejects.toThrow(/UNIQUE constraint failed/i);
}

// ---------------------------------------------------------------------------------------
// Fixtures.
//
// Every identifier is unique per call. The counter lives in module scope, which survives any
// storage reset, so ids stay unique whether or not storage is rolled back between tests.
// ---------------------------------------------------------------------------------------

let fixtureCounter = 0;

interface Fixture {
  n: string;
  playerId: string;
  state: string;
  code: string;
  operationId: string;
  eventId: string;
  itemKey: string;
  jobId: string;
  attemptId: string;
  deliveryGroup: string;
  deliveryId: string;
  sortKey: string;
  now: string;
}

function makeFixture(): Fixture {
  const n = String(++fixtureCounter).padStart(4, "0");
  const operationId = `op-${n}`;
  const code = `CODE-${n}`;
  const playerId = `9${n}`;
  const deliveryGroup = `sum:${operationId}`;
  return {
    n,
    playerId,
    // Digit-only, as `ck_players_state_digits` requires.
    state: `1${n}`,
    code,
    operationId,
    eventId: `evt-${n}`,
    itemKey: code,
    jobId: `registration:${operationId}:${code}`,
    attemptId: `att-${n}`,
    deliveryGroup,
    deliveryId: `out:${deliveryGroup}:1`,
    sortKey: `0|${playerId}|${code}`,
    now: "2026-09-02T00:00:00.000Z",
  };
}

type Row = Record<string, unknown>;

function insert(table: string, row: Row): D1PreparedStatement {
  const names = Object.keys(row);
  const sql =
    `INSERT INTO ${quoteId(table)} (${names.map(quoteId).join(", ")}) ` +
    `VALUES (${names.map(() => "?").join(", ")})`;
  return db.prepare(sql).bind(...names.map((name) => row[name] ?? null));
}

const playersRow = (f: Fixture, o: Row = {}): Row => ({
  player_id: f.playerId,
  state: f.state,
  state_updated_at: null,
  display_name: `Player ${f.n}`,
  created_at: f.now,
  updated_at: f.now,
  ...o,
});

const giftCodesRow = (f: Fixture, o: Row = {}): Row => ({
  code: f.code,
  status: "active",
  discovered_at: f.now,
  source: "manual",
  first_seen_event_id: null,
  ...o,
});

const operationsRow = (f: Fixture, o: Row = {}): Row => ({
  operation_id: f.operationId,
  type: "registration_run",
  trigger_kind: "discord_event",
  trigger_ref: f.eventId,
  snapshot_at: f.now,
  expected_count: 1,
  expansion_state: "expanded",
  expansion_cursor: null,
  state: "in_progress",
  deadline_at: "2026-09-02T01:00:00.000Z",
  summary_state: "none",
  snapshot_cursor: null,
  snapshot_sealed_at: null,
  summary_delivery_group: f.deliveryGroup,
  summary_chunk_total: 1,
  summary_layout_cursor: null,
  summary_layout_open: null,
  summary_build_cursor: 0,
  success_count: null,
  already_redeemed_count: null,
  permanent_failure_count: null,
  retry_exhausted_count: null,
  completed_count: null,
  created_at: f.now,
  updated_at: f.now,
  ...o,
});

const processedEventsRow = (f: Fixture, o: Row = {}): Row => ({
  event_id: f.eventId,
  kind: "registration",
  status: "accepted_valid",
  outcome: "valid",
  operation_id: f.operationId,
  validation_reason: null,
  output_delivery_group: `evt:${f.eventId}`,
  received_at: f.now,
  accepted_at: f.now,
  committed_at: null,
  finalized_at: null,
  ...o,
});

const redemptionsRow = (f: Fixture, o: Row = {}): Row => ({
  player_id: f.playerId,
  code: f.code,
  idempotency_key: `redeem:v1:${f.playerId}:${f.code}`,
  status: "success",
  current_attempt_id: null,
  current_invocation_token: null,
  invocation_expires_at: null,
  retry_due_at: null,
  attempt_state: f.state,
  attempt_generation: 1,
  attempts: 1,
  reeval_count: 0,
  provider_receipt: null,
  reason_code: null,
  first_claimed_at: f.now,
  terminal_at: f.now,
  updated_at: f.now,
  ...o,
});

const operationItemsRow = (f: Fixture, o: Row = {}): Row => ({
  operation_id: f.operationId,
  item_key: f.itemKey,
  player_id: f.playerId,
  code: f.code,
  job_id: f.jobId,
  status: "success",
  display_label: `Player ${f.n}`,
  claim_token: null,
  claim_expires_at: null,
  reason_code: null,
  attempts: 1,
  updated_at: f.now,
  ...o,
});

const operationPlayersSnapshotRow = (f: Fixture, o: Row = {}): Row => ({
  operation_id: f.operationId,
  player_id: f.playerId,
  ...o,
});

const operationLateResultsRow = (f: Fixture, o: Row = {}): Row => ({
  operation_id: f.operationId,
  player_id: f.playerId,
  code: f.code,
  observed_at: f.now,
  // The post-seal outbox-dead outcome of operations-and-reliability.md section 22.
  status: "retry_exhausted",
  reason_code: "outbox_dead",
  ...o,
});

const summaryItemSnapshotRow = (f: Fixture, o: Row = {}): Row => ({
  operation_id: f.operationId,
  player_id: f.playerId,
  code: f.code,
  status: "success",
  reason_code: null,
  display_label: `Player ${f.n}`,
  sort_key: f.sortKey,
  created_at: f.now,
  ...o,
});

const summaryChunkLayoutRow = (f: Fixture, o: Row = {}): Row => ({
  operation_id: f.operationId,
  chunk_index: 1,
  first_sort_key: f.sortKey,
  last_sort_key: f.sortKey,
  overflow_remaining: null,
  created_at: f.now,
  ...o,
});

const discordOutputDeliveriesRow = (f: Fixture, o: Row = {}): Row => ({
  delivery_id: f.deliveryId,
  delivery_group: f.deliveryGroup,
  event_id: f.eventId,
  operation_id: f.operationId,
  channel_id: `chan-${f.n}`,
  output_type: "registration_summary",
  chunk_index: 1,
  chunk_total: 1,
  content: `summary ${f.n}`,
  content_hash: `hash-${f.n}`,
  has_footer: 1,
  nonce: `nonce${f.n}`,
  status: "pending",
  claim_token: null,
  claim_expires_at: null,
  attempts: 0,
  discord_message_id: null,
  sent_at: null,
  created_at: f.now,
  updated_at: f.now,
  ...o,
});

const outboxJobsRow = (f: Fixture, o: Row = {}): Row => ({
  job_id: f.jobId,
  operation_id: f.operationId,
  item_key: f.itemKey,
  type: "registration",
  attempt_id: f.attemptId,
  payload_json: JSON.stringify({
    operation_id: f.operationId,
    item_key: f.itemKey,
    job_id: f.jobId,
    player_id: f.playerId,
    code: f.code,
    attempt_id: f.attemptId,
  }),
  status: "enqueued",
  attempts: 1,
  available_at: f.now,
  last_error: null,
  created_at: f.now,
  updated_at: f.now,
  ...o,
});

/**
 * The parent rows every negative test needs, in the documented parent-before-child order.
 * `redemptions` is deliberately excluded so a negative test can insert its own.
 */
function parentStatements(f: Fixture): D1PreparedStatement[] {
  return [
    insert("players", playersRow(f)),
    insert("gift_codes", giftCodesRow(f)),
    insert("operations", operationsRow(f)),
    insert("processed_events", processedEventsRow(f)),
    insert("operation_items", operationItemsRow(f)),
  ];
}

/** One consistent row in each of the twelve tables, parents before children. */
function fixtureStatements(f: Fixture): D1PreparedStatement[] {
  return [
    ...parentStatements(f),
    insert("redemptions", redemptionsRow(f)),
    insert("operation_players_snapshot", operationPlayersSnapshotRow(f)),
    insert("operation_late_results", operationLateResultsRow(f)),
    insert("summary_item_snapshot", summaryItemSnapshotRow(f)),
    insert("summary_chunk_layout", summaryChunkLayoutRow(f)),
    insert("discord_output_deliveries", discordOutputDeliveriesRow(f)),
    insert("outbox_jobs", outboxJobsRow(f)),
  ];
}

async function seedParents(): Promise<Fixture> {
  const f = makeFixture();
  await db.batch(parentStatements(f));
  return f;
}

// ---------------------------------------------------------------------------------------
// Expected schema contract.
// ---------------------------------------------------------------------------------------

type ExpectedColumn = readonly [
  name: string,
  type: string,
  notnull: number,
  dflt: string | null,
  pk: number,
];

const EXPECTED_COLUMNS: Record<string, readonly ExpectedColumn[]> = {
  players: [
    ["player_id", "TEXT", 1, null, 1],
    ["state", "TEXT", 1, null, 0],
    ["state_updated_at", "TEXT", 0, null, 0],
    ["display_name", "TEXT", 0, null, 0],
    ["created_at", "TEXT", 1, null, 0],
    ["updated_at", "TEXT", 1, null, 0],
  ],
  gift_codes: [
    ["code", "TEXT", 1, null, 1],
    ["status", "TEXT", 1, "'active'", 0],
    ["discovered_at", "TEXT", 1, null, 0],
    ["source", "TEXT", 1, null, 0],
    ["first_seen_event_id", "TEXT", 0, null, 0],
  ],
  operations: [
    ["operation_id", "TEXT", 1, null, 1],
    ["type", "TEXT", 1, null, 0],
    ["trigger_kind", "TEXT", 1, null, 0],
    ["trigger_ref", "TEXT", 1, null, 0],
    ["snapshot_at", "TEXT", 1, null, 0],
    ["expected_count", "INTEGER", 1, null, 0],
    ["expansion_state", "TEXT", 1, "'pending'", 0],
    ["expansion_cursor", "TEXT", 0, null, 0],
    ["state", "TEXT", 1, "'pending'", 0],
    ["deadline_at", "TEXT", 1, null, 0],
    ["summary_state", "TEXT", 1, "'none'", 0],
    ["snapshot_cursor", "TEXT", 0, null, 0],
    ["snapshot_sealed_at", "TEXT", 0, null, 0],
    ["summary_delivery_group", "TEXT", 0, null, 0],
    ["summary_chunk_total", "INTEGER", 0, null, 0],
    ["summary_layout_cursor", "TEXT", 0, null, 0],
    ["summary_layout_open", "TEXT", 0, null, 0],
    ["summary_build_cursor", "INTEGER", 1, "0", 0],
    ["success_count", "INTEGER", 0, null, 0],
    ["already_redeemed_count", "INTEGER", 0, null, 0],
    ["permanent_failure_count", "INTEGER", 0, null, 0],
    ["retry_exhausted_count", "INTEGER", 0, null, 0],
    ["completed_count", "INTEGER", 0, null, 0],
    ["created_at", "TEXT", 1, null, 0],
    ["updated_at", "TEXT", 1, null, 0],
  ],
  processed_events: [
    ["event_id", "TEXT", 1, null, 1],
    ["kind", "TEXT", 1, null, 0],
    ["status", "TEXT", 1, null, 0],
    ["outcome", "TEXT", 0, null, 0],
    ["operation_id", "TEXT", 0, null, 0],
    ["validation_reason", "TEXT", 0, null, 0],
    ["output_delivery_group", "TEXT", 1, null, 0],
    ["received_at", "TEXT", 0, null, 0],
    ["accepted_at", "TEXT", 0, null, 0],
    ["committed_at", "TEXT", 0, null, 0],
    ["finalized_at", "TEXT", 0, null, 0],
  ],
  redemptions: [
    ["player_id", "TEXT", 1, null, 1],
    ["code", "TEXT", 1, null, 2],
    ["idempotency_key", "TEXT", 1, null, 0],
    ["status", "TEXT", 1, "'pending'", 0],
    ["current_attempt_id", "TEXT", 0, null, 0],
    ["current_invocation_token", "TEXT", 0, null, 0],
    ["invocation_expires_at", "TEXT", 0, null, 0],
    ["retry_due_at", "TEXT", 0, null, 0],
    ["attempt_state", "TEXT", 0, null, 0],
    ["attempt_generation", "INTEGER", 1, "0", 0],
    ["attempts", "INTEGER", 1, "0", 0],
    ["reeval_count", "INTEGER", 1, "0", 0],
    ["provider_receipt", "TEXT", 0, null, 0],
    ["reason_code", "TEXT", 0, null, 0],
    ["first_claimed_at", "TEXT", 0, null, 0],
    ["terminal_at", "TEXT", 0, null, 0],
    ["updated_at", "TEXT", 0, null, 0],
  ],
  operation_items: [
    ["operation_id", "TEXT", 1, null, 1],
    ["item_key", "TEXT", 1, null, 2],
    ["player_id", "TEXT", 1, null, 0],
    ["code", "TEXT", 1, null, 0],
    ["job_id", "TEXT", 1, null, 0],
    ["status", "TEXT", 1, "'pending'", 0],
    ["display_label", "TEXT", 1, null, 0],
    ["claim_token", "TEXT", 0, null, 0],
    ["claim_expires_at", "TEXT", 0, null, 0],
    ["reason_code", "TEXT", 0, null, 0],
    ["attempts", "INTEGER", 1, "0", 0],
    ["updated_at", "TEXT", 1, null, 0],
  ],
  operation_players_snapshot: [
    ["operation_id", "TEXT", 1, null, 1],
    ["player_id", "TEXT", 1, null, 2],
  ],
  operation_late_results: [
    ["operation_id", "TEXT", 1, null, 1],
    ["player_id", "TEXT", 1, null, 2],
    ["code", "TEXT", 1, null, 3],
    ["observed_at", "TEXT", 1, null, 4],
    ["status", "TEXT", 1, null, 0],
    ["reason_code", "TEXT", 0, null, 0],
  ],
  summary_item_snapshot: [
    ["operation_id", "TEXT", 1, null, 1],
    ["player_id", "TEXT", 1, null, 2],
    ["code", "TEXT", 1, null, 3],
    ["status", "TEXT", 1, null, 0],
    ["reason_code", "TEXT", 0, null, 0],
    ["display_label", "TEXT", 1, null, 0],
    ["sort_key", "TEXT", 1, null, 0],
    ["created_at", "TEXT", 1, null, 0],
  ],
  summary_chunk_layout: [
    ["operation_id", "TEXT", 1, null, 1],
    ["chunk_index", "INTEGER", 1, null, 2],
    ["first_sort_key", "TEXT", 0, null, 0],
    ["last_sort_key", "TEXT", 0, null, 0],
    ["overflow_remaining", "INTEGER", 0, null, 0],
    ["created_at", "TEXT", 1, null, 0],
  ],
  discord_output_deliveries: [
    ["delivery_id", "TEXT", 1, null, 1],
    ["delivery_group", "TEXT", 1, null, 0],
    ["event_id", "TEXT", 0, null, 0],
    ["operation_id", "TEXT", 0, null, 0],
    ["channel_id", "TEXT", 1, null, 0],
    ["output_type", "TEXT", 1, null, 0],
    ["chunk_index", "INTEGER", 1, null, 0],
    ["chunk_total", "INTEGER", 1, null, 0],
    ["content", "TEXT", 1, null, 0],
    ["content_hash", "TEXT", 1, null, 0],
    ["has_footer", "INTEGER", 1, "0", 0],
    ["nonce", "TEXT", 1, null, 0],
    ["status", "TEXT", 1, "'pending'", 0],
    ["claim_token", "TEXT", 0, null, 0],
    ["claim_expires_at", "TEXT", 0, null, 0],
    ["attempts", "INTEGER", 1, "0", 0],
    ["discord_message_id", "TEXT", 0, null, 0],
    ["sent_at", "TEXT", 0, null, 0],
    ["created_at", "TEXT", 0, null, 0],
    ["updated_at", "TEXT", 0, null, 0],
  ],
  outbox_jobs: [
    ["job_id", "TEXT", 1, null, 1],
    ["operation_id", "TEXT", 1, null, 0],
    ["item_key", "TEXT", 1, null, 0],
    ["type", "TEXT", 1, null, 0],
    ["attempt_id", "TEXT", 1, null, 0],
    ["payload_json", "TEXT", 1, null, 0],
    ["status", "TEXT", 1, "'pending'", 0],
    ["attempts", "INTEGER", 1, "0", 0],
    ["available_at", "TEXT", 1, null, 0],
    ["last_error", "TEXT", 0, null, 0],
    ["created_at", "TEXT", 1, null, 0],
    ["updated_at", "TEXT", 1, null, 0],
  ],
};

/** 16 foreign-key constraints; `outbox_jobs` is composite and emits two pragma rows. */
const EXPECTED_FOREIGN_KEYS: Record<string, ForeignKeyConstraint[]> = {
  players: [],
  gift_codes: [],
  operations: [],
  processed_events: [
    {
      table: "operations",
      columnPairs: [["operation_id", "operation_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
  ],
  redemptions: [
    {
      table: "players",
      columnPairs: [["player_id", "player_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
    {
      table: "gift_codes",
      columnPairs: [["code", "code"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
  ],
  operation_items: [
    {
      table: "operations",
      columnPairs: [["operation_id", "operation_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
    {
      table: "players",
      columnPairs: [["player_id", "player_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
    {
      table: "gift_codes",
      columnPairs: [["code", "code"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
  ],
  operation_players_snapshot: [
    {
      table: "operations",
      columnPairs: [["operation_id", "operation_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
    {
      table: "players",
      columnPairs: [["player_id", "player_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
  ],
  operation_late_results: [
    {
      table: "operations",
      columnPairs: [["operation_id", "operation_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
    {
      table: "players",
      columnPairs: [["player_id", "player_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
    {
      table: "gift_codes",
      columnPairs: [["code", "code"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
  ],
  summary_item_snapshot: [
    {
      table: "operations",
      columnPairs: [["operation_id", "operation_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
  ],
  summary_chunk_layout: [
    {
      table: "operations",
      columnPairs: [["operation_id", "operation_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
  ],
  discord_output_deliveries: [
    {
      table: "processed_events",
      columnPairs: [["event_id", "event_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
    {
      table: "operations",
      columnPairs: [["operation_id", "operation_id"]],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
  ],
  outbox_jobs: [
    {
      table: "operation_items",
      columnPairs: [
        ["operation_id", "operation_id"],
        ["item_key", "item_key"],
      ],
      on_update: "NO ACTION",
      on_delete: "NO ACTION",
    },
  ],
};

const EXPECTED_FOREIGN_KEY_PRAGMA_ROWS = 17;

/** The 14 indexes the migration owns, by table. Auto-created PK indexes are not listed. */
const EXPECTED_INDEXES: Record<string, Record<string, string[]>> = {
  players: {},
  gift_codes: {
    idx_gift_codes_status_code: ["status", "code"],
  },
  operations: {
    idx_operations_state_deadline_at: ["state", "deadline_at"],
    idx_operations_summary_state_updated_at: ["summary_state", "updated_at"],
    idx_operations_trigger: ["trigger_kind", "trigger_ref"],
  },
  processed_events: {
    idx_processed_events_status_accepted_at: ["status", "accepted_at"],
  },
  redemptions: {
    idx_redemptions_status_invocation_expires_at: ["status", "invocation_expires_at"],
  },
  operation_items: {
    idx_operation_items_operation_player_code: ["operation_id", "player_id", "code"],
    idx_operation_items_operation_status_claim: ["operation_id", "status", "claim_expires_at"],
    idx_operation_items_player_code: ["player_id", "code"],
  },
  operation_players_snapshot: {},
  operation_late_results: {},
  summary_item_snapshot: {
    idx_summary_item_snapshot_sort: ["operation_id", "sort_key"],
  },
  summary_chunk_layout: {},
  discord_output_deliveries: {
    idx_discord_output_deliveries_group_chunk: ["delivery_group", "chunk_index"],
    idx_discord_output_deliveries_status_claim: ["status", "claim_expires_at"],
  },
  outbox_jobs: {
    idx_outbox_jobs_status_available_at: ["status", "available_at"],
    idx_outbox_jobs_operation_item: ["operation_id", "item_key"],
  },
};

// ---------------------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------------------

describe("baseline migration application", () => {
  it("applied the baseline migration to a fresh Workers-runtime D1 database", async () => {
    const rows = await ledgerRows();

    expect(rows.map((row) => row.name)).toStrictEqual([MIGRATION_NAME]);
  });

  it("leaves exactly the twelve application tables plus the migration ledger", async () => {
    const allUserTables = await userTables();

    // Set equality over the full user-table set: an accidentally added application table
    // fails here, and the ledger is excluded from the application set by name, never by an
    // implicit filter.
    expect([...allUserTables].sort()).toStrictEqual(EXPECTED_USER_TABLES);
    expect(allUserTables).toContain(MIGRATIONS_LEDGER);
    expect((await applicationTables()).sort()).toStrictEqual([...APPLICATION_TABLES].sort());
    expect(await applicationTables()).toHaveLength(12);
  });
});

describe("column contract", () => {
  it.each([...APPLICATION_TABLES])(
    "%s has the documented columns, order, types, nullability, defaults and primary-key ordinals",
    async (table) => {
      const actual = (await columns(table)).map((column) => [
        column.name,
        column.type,
        column.notnull,
        column.dflt_value,
        column.pk,
      ]);

      expect(actual).toStrictEqual(EXPECTED_COLUMNS[table]!.map((column) => [...column]));
    },
  );

  it("declares 130 columns across the twelve tables", async () => {
    let total = 0;
    for (const table of APPLICATION_TABLES) {
      total += (await columns(table)).length;
    }

    expect(total).toBe(130);
  });

  it.each([
    ["redemptions", ["player_id", "code"]],
    ["operation_items", ["operation_id", "item_key"]],
    ["operation_late_results", ["operation_id", "player_id", "code", "observed_at"]],
    ["summary_item_snapshot", ["operation_id", "player_id", "code"]],
    ["summary_chunk_layout", ["operation_id", "chunk_index"]],
    ["operation_players_snapshot", ["operation_id", "player_id"]],
  ] as const)("%s has the documented composite primary-key order", async (table, expected) => {
    const key = (await columns(table))
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);

    expect(key).toStrictEqual([...expected]);
  });
});

describe("foreign keys", () => {
  it.each([...APPLICATION_TABLES])("%s declares the documented foreign keys", async (table) => {
    const actual = groupForeignKeys(await foreignKeys(table));
    const expected = [...EXPECTED_FOREIGN_KEYS[table]!].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );

    expect(actual).toStrictEqual(expected);
  });

  it("declares 16 constraints across 17 PRAGMA foreign_key_list rows", async () => {
    let rows = 0;
    let constraints = 0;
    for (const table of APPLICATION_TABLES) {
      const raw = await foreignKeys(table);
      rows += raw.length;
      constraints += new Set(raw.map((row) => row.id)).size;
    }

    expect(constraints).toBe(16);
    expect(rows).toBe(EXPECTED_FOREIGN_KEY_PRAGMA_ROWS);
  });

  it("declares outbox_jobs as ONE ordered composite key, not two single-column keys", async () => {
    const raw = await foreignKeys("outbox_jobs");

    expect(raw).toHaveLength(2);
    // A single `id` shared by both rows is what makes this one constraint.
    expect(new Set(raw.map((row) => row.id)).size).toBe(1);
    expect(
      [...raw].sort((a, b) => a.seq - b.seq).map((row) => [row.seq, row.table, row.from, row.to]),
    ).toStrictEqual([
      [0, "operation_items", "operation_id", "operation_id"],
      [1, "operation_items", "item_key", "item_key"],
    ]);
  });

  it("uses no cascade behaviour anywhere", async () => {
    for (const table of APPLICATION_TABLES) {
      for (const row of await foreignKeys(table)) {
        expect(row.on_delete).toBe("NO ACTION");
        expect(row.on_update).toBe("NO ACTION");
      }
    }
  });
});

describe("indexes", () => {
  it.each([...APPLICATION_TABLES])(
    "%s has exactly the migration-owned indexes, with the documented column order",
    async (table) => {
      const expected = EXPECTED_INDEXES[table]!;
      const owned = (await indexList(table)).filter((index) => index.origin === "c");

      expect([...owned.map((index) => index.name)].sort()).toStrictEqual(
        Object.keys(expected).sort(),
      );

      for (const index of owned) {
        expect(await indexColumns(index.name)).toStrictEqual(expected[index.name]!);
      }
    },
  );

  it("declares 14 migration-owned indexes in total", async () => {
    let total = 0;
    for (const table of APPLICATION_TABLES) {
      total += (await indexList(table)).filter((index) => index.origin === "c").length;
    }

    expect(total).toBe(14);
  });

  it("declares no unique constraint other than the primary keys", async () => {
    for (const table of APPLICATION_TABLES) {
      const uniqueConstraintIndexes = (await indexList(table)).filter(
        (index) => index.origin === "u",
      );

      expect(uniqueConstraintIndexes).toStrictEqual([]);
    }
  });
});

describe("enum-domain CHECK constraints", () => {
  const cases: {
    label: string;
    table: string;
    constraint: string;
    row: (f: Fixture) => Row;
  }[] = [
    {
      label: "gift_codes.status",
      table: "gift_codes",
      constraint: "ck_gift_codes_status",
      row: (f) => giftCodesRow(f, { code: `${f.code}-x`, status: "retired" }),
    },
    {
      label: "processed_events.kind",
      table: "processed_events",
      constraint: "ck_processed_events_kind",
      row: (f) => processedEventsRow(f, { event_id: `${f.eventId}-x`, kind: "reaction" }),
    },
    {
      label: "processed_events.status",
      table: "processed_events",
      constraint: "ck_processed_events_status",
      row: (f) => processedEventsRow(f, { event_id: `${f.eventId}-x`, status: "done" }),
    },
    {
      label: "processed_events.outcome",
      table: "processed_events",
      constraint: "ck_processed_events_outcome",
      row: (f) => processedEventsRow(f, { event_id: `${f.eventId}-x`, outcome: "maybe" }),
    },
    {
      label: "redemptions.status",
      table: "redemptions",
      constraint: "ck_redemptions_status",
      row: (f) => redemptionsRow(f, { status: "queued" }),
    },
    {
      label: "operations.type",
      table: "operations",
      constraint: "ck_operations_type",
      row: (f) => operationsRow(f, { operation_id: `${f.operationId}-x`, type: "cleanup_run" }),
    },
    {
      label: "operations.trigger_kind",
      table: "operations",
      constraint: "ck_operations_trigger_kind",
      row: (f) => operationsRow(f, { operation_id: `${f.operationId}-x`, trigger_kind: "cron" }),
    },
    {
      label: "operations.state",
      table: "operations",
      constraint: "ck_operations_state",
      row: (f) => operationsRow(f, { operation_id: `${f.operationId}-x`, state: "finished" }),
    },
    {
      label: "operations.expansion_state",
      table: "operations",
      constraint: "ck_operations_expansion_state",
      row: (f) => operationsRow(f, { operation_id: `${f.operationId}-x`, expansion_state: "done" }),
    },
    {
      label: "operations.summary_state",
      table: "operations",
      constraint: "ck_operations_summary_state",
      row: (f) => operationsRow(f, { operation_id: `${f.operationId}-x`, summary_state: "sent" }),
    },
    {
      label: "operation_items.status",
      table: "operation_items",
      constraint: "ck_operation_items_status",
      row: (f) => operationItemsRow(f, { item_key: `${f.itemKey}-x`, status: "queued" }),
    },
    {
      label: "operation_late_results.status",
      table: "operation_late_results",
      constraint: "ck_operation_late_results_status",
      row: (f) => operationLateResultsRow(f, { status: "still_pending" }),
    },
    {
      label: "summary_item_snapshot.status",
      table: "summary_item_snapshot",
      constraint: "ck_summary_item_snapshot_status",
      row: (f) => summaryItemSnapshotRow(f, { status: "queued" }),
    },
    {
      label: "discord_output_deliveries.output_type",
      table: "discord_output_deliveries",
      constraint: "ck_dod_output_type",
      row: (f) => discordOutputDeliveriesRow(f, { output_type: "digest" }),
    },
    {
      label: "discord_output_deliveries.status",
      table: "discord_output_deliveries",
      constraint: "ck_dod_status",
      row: (f) => discordOutputDeliveriesRow(f, { status: "queued" }),
    },
    {
      label: "outbox_jobs.type",
      table: "outbox_jobs",
      constraint: "ck_outbox_jobs_type",
      row: (f) => outboxJobsRow(f, { type: "repair" }),
    },
    {
      label: "outbox_jobs.status",
      table: "outbox_jobs",
      constraint: "ck_outbox_jobs_status",
      row: (f) => outboxJobsRow(f, { status: "queued" }),
    },
  ];

  it.each(cases)("rejects an invalid $label", async ({ table, constraint, row }) => {
    // All parents exist and every other column is valid: only the enum value differs.
    const f = await seedParents();

    await expectCheckFailure(insert(table, row(f)).run(), constraint);
  });
});

describe("boolean, counter and chunk CHECK constraints", () => {
  it("rejects a has_footer value outside 0/1", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert("discord_output_deliveries", discordOutputDeliveriesRow(f, { has_footer: 2 })).run(),
      "ck_dod_has_footer_bool",
    );
  });

  it("rejects a footer on any chunk but the last", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert(
        "discord_output_deliveries",
        discordOutputDeliveriesRow(f, { chunk_index: 1, chunk_total: 3, has_footer: 1 }),
      ).run(),
      "ck_dod_footer_placement",
    );
  });

  it("rejects a footer on a validation reply", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert(
        "discord_output_deliveries",
        discordOutputDeliveriesRow(f, { output_type: "validation_reply", has_footer: 1 }),
      ).run(),
      "ck_dod_footer_placement",
    );
  });

  it("accepts a footer on the final chunk of a summary", async () => {
    const f = await seedParents();

    const result = await insert(
      "discord_output_deliveries",
      discordOutputDeliveriesRow(f, { chunk_index: 3, chunk_total: 3, has_footer: 1 }),
    ).run();

    expect(result.success).toBe(true);
  });

  it("rejects a negative attempts counter", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert("discord_output_deliveries", discordOutputDeliveriesRow(f, { attempts: -1 })).run(),
      "ck_dod_attempts_nonneg",
    );
  });

  it("rejects a zero chunk_index", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert(
        "discord_output_deliveries",
        discordOutputDeliveriesRow(f, { chunk_index: 0, chunk_total: 2, has_footer: 0 }),
      ).run(),
      "ck_dod_chunk_index_positive",
    );
  });

  it("rejects a chunk_index beyond chunk_total", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert(
        "discord_output_deliveries",
        discordOutputDeliveriesRow(f, { chunk_index: 3, chunk_total: 2, has_footer: 0 }),
      ).run(),
      "ck_dod_chunk_within_total",
    );
  });

  it("rejects a negative expected_count", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert(
        "operations",
        operationsRow(f, { operation_id: `${f.operationId}-x`, expected_count: -1 }),
      ).run(),
      "ck_operations_expected_count_nonneg",
    );
  });

  it("rejects a half-populated summary_chunk_layout sort-key pair", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert("summary_chunk_layout", summaryChunkLayoutRow(f, { last_sort_key: null })).run(),
      "ck_scl_sort_key_pair",
    );
  });

  it("accepts a zero-result summary_chunk_layout row with no sort-key bounds", async () => {
    const f = await seedParents();

    const result = await insert(
      "summary_chunk_layout",
      summaryChunkLayoutRow(f, { first_sort_key: null, last_sort_key: null }),
    ).run();

    expect(result.success).toBe(true);
  });
});

describe("nonce bounds", () => {
  it("rejects an empty nonce", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert("discord_output_deliveries", discordOutputDeliveriesRow(f, { nonce: "" })).run(),
      "ck_dod_nonce_length",
    );
  });

  it("rejects a nonce longer than 25 characters", async () => {
    const f = await seedParents();

    await expectCheckFailure(
      insert(
        "discord_output_deliveries",
        discordOutputDeliveriesRow(f, { nonce: "n".repeat(26) }),
      ).run(),
      "ck_dod_nonce_length",
    );
  });

  it.each([1, 25])("accepts a nonce of %i character(s)", async (length) => {
    const f = await seedParents();

    const result = await insert(
      "discord_output_deliveries",
      discordOutputDeliveriesRow(f, { nonce: "n".repeat(length) }),
    ).run();

    expect(result.success).toBe(true);
  });
});

describe("identifier-shape CHECK constraints", () => {
  it.each(["abc", "12a", "12 3", ""])("rejects the non-numeric player_id %o", async (playerId) => {
    const f = makeFixture();

    await expectCheckFailure(
      insert("players", playersRow(f, { player_id: playerId })).run(),
      "ck_players_player_id_digits",
    );
  });

  it.each(["x1", ""])("rejects the non-numeric state %o", async (state) => {
    const f = makeFixture();

    await expectCheckFailure(
      insert("players", playersRow(f, { state })).run(),
      "ck_players_state_digits",
    );
  });
});

describe("uniqueness and composite primary keys", () => {
  const duplicateCases: {
    label: string;
    table: string;
    row: (f: Fixture) => Row;
    needsParents: boolean;
  }[] = [
    { label: "players.player_id", table: "players", row: playersRow, needsParents: false },
    { label: "gift_codes.code", table: "gift_codes", row: giftCodesRow, needsParents: false },
    {
      label: "redemptions (player_id, code)",
      table: "redemptions",
      row: redemptionsRow,
      needsParents: true,
    },
    {
      label: "operation_items (operation_id, item_key)",
      table: "operation_items",
      row: operationItemsRow,
      needsParents: true,
    },
    {
      label: "operation_late_results (operation_id, player_id, code, observed_at)",
      table: "operation_late_results",
      row: operationLateResultsRow,
      needsParents: true,
    },
    {
      label: "summary_item_snapshot (operation_id, player_id, code)",
      table: "summary_item_snapshot",
      row: summaryItemSnapshotRow,
      needsParents: true,
    },
    {
      label: "summary_chunk_layout (operation_id, chunk_index)",
      table: "summary_chunk_layout",
      row: summaryChunkLayoutRow,
      needsParents: true,
    },
    {
      label: "discord_output_deliveries.delivery_id",
      table: "discord_output_deliveries",
      row: discordOutputDeliveriesRow,
      needsParents: true,
    },
    {
      label: "outbox_jobs.job_id",
      table: "outbox_jobs",
      row: outboxJobsRow,
      needsParents: true,
    },
  ];

  it.each(duplicateCases)("rejects a duplicate $label", async ({ table, row, needsParents }) => {
    const f = needsParents ? await seedParents() : makeFixture();

    // `operation_items` already has its fixture row from the parent set; every other table
    // needs its first row inserted here.
    if (table !== "operation_items") {
      const first = await insert(table, row(f)).run();
      expect(first.success).toBe(true);
    }

    await expectUniqueFailure(insert(table, row(f)).run());
  });

  it("accepts the same item_key under a different operation_id", async () => {
    const first = await seedParents();
    const second = await seedParents();

    const result = await insert(
      "operation_items",
      operationItemsRow(second, { item_key: first.itemKey }),
    ).run();

    expect(result.success).toBe(true);
  });
});

describe("identifier storage", () => {
  it("stores numeric-looking identifiers as strings, without precision loss", async () => {
    const f = makeFixture();
    const bigPlayerId = "123456789012345678901";
    const numericCode = "00987654321098765432";

    await db.batch([
      insert("players", playersRow(f, { player_id: bigPlayerId })),
      insert("gift_codes", giftCodesRow(f, { code: numericCode })),
    ]);

    const player = await db
      .prepare("SELECT player_id, state FROM players WHERE player_id = ?")
      .bind(bigPlayerId)
      .first<{ player_id: unknown; state: unknown }>();
    const code = await db
      .prepare("SELECT code FROM gift_codes WHERE code = ?")
      .bind(numericCode)
      .first<{ code: unknown }>();

    expect(typeof player?.player_id).toBe("string");
    expect(player?.player_id).toBe(bigPlayerId);
    expect(typeof player?.state).toBe("string");
    expect(typeof code?.code).toBe("string");
    expect(code?.code).toBe(numericCode);
  });

  it("round-trips leading zeroes in PLAYER_ID and STATE unchanged", async () => {
    const f = makeFixture();
    const playerId = `0000123${f.n}`;
    const state = "007";

    await insert("players", playersRow(f, { player_id: playerId, state })).run();

    const stored = await db
      .prepare("SELECT player_id, state FROM players WHERE player_id = ?")
      .bind(playerId)
      .first<{ player_id: string; state: string }>();

    expect(stored?.player_id).toBe(playerId);
    expect(stored?.state).toBe(state);

    // The zero-stripped form is a different key, which is the whole point of TEXT storage.
    const stripped = await db
      .prepare("SELECT player_id FROM players WHERE player_id = ?")
      .bind(playerId.replace(/^0+/, ""))
      .first<{ player_id: string }>();

    expect(stripped).toBeNull();
  });
});

describe("representative data and referential integrity", () => {
  it("accepts one consistent row in each of the twelve tables", async () => {
    const f = makeFixture();

    const results = await db.batch(fixtureStatements(f));

    expect(results).toHaveLength(12);
    for (const result of results) {
      expect(result.success).toBe(true);
    }

    const checks: [string, string, unknown[]][] = [
      ["players", "player_id = ?", [f.playerId]],
      ["gift_codes", "code = ?", [f.code]],
      ["operations", "operation_id = ?", [f.operationId]],
      ["processed_events", "event_id = ?", [f.eventId]],
      ["redemptions", "player_id = ? AND code = ?", [f.playerId, f.code]],
      ["operation_items", "operation_id = ? AND item_key = ?", [f.operationId, f.itemKey]],
      ["operation_players_snapshot", "operation_id = ?", [f.operationId]],
      ["operation_late_results", "operation_id = ?", [f.operationId]],
      ["summary_item_snapshot", "operation_id = ?", [f.operationId]],
      ["summary_chunk_layout", "operation_id = ?", [f.operationId]],
      ["discord_output_deliveries", "delivery_id = ?", [f.deliveryId]],
      ["outbox_jobs", "job_id = ?", [f.jobId]],
    ];

    for (const [table, where, binds] of checks) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM ${quoteId(table)} WHERE ${where}`)
        .bind(...binds)
        .first<{ n: number }>();

      expect(row?.n).toBe(1);
    }
  });

  it("enforces foreign keys, rejecting otherwise-valid orphan rows", async () => {
    const f = await seedParents();

    await expectForeignKeyFailure(
      insert(
        "operation_items",
        operationItemsRow(f, { operation_id: "op-missing", item_key: `${f.itemKey}-x` }),
      ).run(),
    );

    await expectForeignKeyFailure(
      insert("outbox_jobs", outboxJobsRow(f, { item_key: "item-missing" })).run(),
    );

    await expectForeignKeyFailure(
      insert(
        "discord_output_deliveries",
        discordOutputDeliveriesRow(f, { event_id: "evt-missing" }),
      ).run(),
    );
  });

  it("reports no foreign-key violations after writing a complete row set", async () => {
    const f = makeFixture();
    await db.batch(fixtureStatements(f));

    const violations = await pragma<Record<string, unknown>>("PRAGMA foreign_key_check");

    expect(violations).toStrictEqual([]);
  });
});

describe("migration re-application", () => {
  it("is a no-op that preserves the schema, the ledger and existing data", async () => {
    const f = makeFixture();
    await db.batch(fixtureStatements(f));

    const rowsBefore: Record<string, unknown>[] = [];
    const keys: [string, string, unknown[]][] = [
      ["players", "player_id = ?", [f.playerId]],
      ["gift_codes", "code = ?", [f.code]],
      ["operations", "operation_id = ?", [f.operationId]],
      ["processed_events", "event_id = ?", [f.eventId]],
      ["redemptions", "player_id = ? AND code = ?", [f.playerId, f.code]],
      ["operation_items", "operation_id = ? AND item_key = ?", [f.operationId, f.itemKey]],
      ["operation_players_snapshot", "operation_id = ?", [f.operationId]],
      ["operation_late_results", "operation_id = ?", [f.operationId]],
      ["summary_item_snapshot", "operation_id = ?", [f.operationId]],
      ["summary_chunk_layout", "operation_id = ?", [f.operationId]],
      ["discord_output_deliveries", "delivery_id = ?", [f.deliveryId]],
      ["outbox_jobs", "job_id = ?", [f.jobId]],
    ];

    async function readOwnRows(): Promise<Record<string, unknown>[]> {
      const out: Record<string, unknown>[] = [];
      for (const [table, where, binds] of keys) {
        const row = await db
          .prepare(`SELECT * FROM ${quoteId(table)} WHERE ${where}`)
          .bind(...binds)
          .first<Record<string, unknown>>();
        out.push(row ?? {});
      }
      return out;
    }

    rowsBefore.push(...(await readOwnRows()));
    const schemaBefore = await schemaSnapshot();
    const ledgerBefore = await ledgerRows();

    // Re-apply the whole migration set against the same database.
    await applyD1Migrations(env.STAGING_DB, env.TEST_MIGRATIONS);

    // The ledger still records the migration exactly once: it was not re-run.
    expect(await ledgerRows()).toStrictEqual(ledgerBefore);
    expect(ledgerBefore.map((row) => row.name)).toStrictEqual([MIGRATION_NAME]);

    // No table was recreated and no index or foreign key was lost.
    expect(await schemaSnapshot()).toStrictEqual(schemaBefore);

    // This test's own rows survive byte-identically.
    expect(await readOwnRows()).toStrictEqual(rowsBefore);
  });
});

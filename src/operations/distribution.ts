import {
  DISCOVERY_SOURCE,
  type FollowCodeEvent,
  type FollowCandidate,
} from "../../shared/discord-follow";
import type { AppConfig } from "../config";
import { deterministicUuid } from "../ingest/identity";
import { renderDisplayLabel } from "../ingest/sanitize";
import type { ManualCodeCommandEvent, ManualCodeResult } from "../manual-code/types";
import { mutableOperation, progress, rotation } from "../runtime/db";

export function openDistribution(
  db: D1Database,
  config: AppConfig,
  code: string,
  now: Date,
): Promise<string | null>;
export function openDistribution(
  db: D1Database,
  config: AppConfig,
  code: string,
  now: Date,
  command: ManualCodeCommandEvent,
): Promise<ManualCodeResult>;

/** One distribution-opening transaction, reached by synthetic tests or the staging command. */
export async function openDistribution(
  db: D1Database,
  config: AppConfig,
  code: string,
  now: Date,
  command?: ManualCodeCommandEvent,
): Promise<string | null | ManualCodeResult> {
  if (!code || new TextEncoder().encode(code).length > 128) throw new Error("synthetic_code_size");
  if (command)
    return openEventDistribution(db, config, code, now, {
      kind: "manual",
      event: command,
    }) as Promise<ManualCodeResult>;
  return openSyntheticDistribution(db, config, code, now);
}

export function openCommunityDistribution(
  db: D1Database,
  config: AppConfig,
  code: string,
  now: Date,
): Promise<string | null> {
  return openSyntheticDistribution(db, config, code, now, "community-json-wosc-staging");
}

async function openSyntheticDistribution(
  db: D1Database,
  config: AppConfig,
  code: string,
  now: Date,
  source = "synthetic-local",
): Promise<string | null> {
  const id = await deterministicUuid(`distribution:${code}`);
  const stamp = now.toISOString();
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO gift_codes(code,status,discovered_at,source) VALUES (?1,'active',?2,?3)",
        )
        .bind(code, stamp, source),
      db
        .prepare(
          `INSERT INTO operations(operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,deadline_at,created_at,updated_at,summary_context)
        SELECT ?1,'code_distribution_run','discovered_code',?2,?3,CASE WHEN COUNT(*)<=2000 THEN COUNT(*) ELSE -1 END,?4,?3,?3,?5 FROM players`,
        )
        .bind(
          id,
          code,
          stamp,
          new Date(now.getTime() + config.operationDeadlineSeconds * 1000).toISOString(),
          JSON.stringify({
            version: 1,
            code,
            channelId: config.discordRegistrationChannelId,
            maxLength: config.discordMessageMaxLength,
            maxChunks: config.summaryMaxChunks,
          }),
        ),
      db
        .prepare(
          "INSERT INTO operation_players_snapshot(operation_id,player_id,display_name) SELECT ?1,player_id,display_name FROM players ORDER BY player_id",
        )
        .bind(id),
    ]);
    return id;
  } catch {
    const existing = await db.prepare("SELECT 1 FROM gift_codes WHERE code=?1").bind(code).first();
    if (existing) return null;
    throw new Error("distribution_not_accepted");
  }
}

export type DiscoveryResult =
  | { readonly kind: "accepted"; readonly operationId: string }
  | { readonly kind: "duplicate_event" | "duplicate_code" | "duplicate_source" };

type DistributionInput =
  | { kind: "manual"; event: ManualCodeCommandEvent }
  | { kind: "discovery"; event: FollowCodeEvent; candidate: FollowCandidate };

export function openDiscoveredDistribution(
  db: D1Database,
  config: AppConfig,
  event: FollowCodeEvent,
  candidate: FollowCandidate,
  now: Date,
): Promise<DiscoveryResult> {
  return openEventDistribution(db, config, candidate.code, now, {
    kind: "discovery",
    event,
    candidate,
  });
}

/** Shared atomic acceptance and frozen membership; no provider calls at intake. */
async function openEventDistribution(
  db: D1Database,
  config: AppConfig,
  code: string,
  now: Date,
  input: DistributionInput,
): Promise<DiscoveryResult> {
  const command = input.event;
  // SQL identifiers/labels are chosen only from these closed internal alternatives.
  const table = input.kind === "manual" ? "manual_code_commands" : "discovered_code_events";
  const source = input.kind === "manual" ? "manual-staging" : DISCOVERY_SOURCE;
  const operationId = await deterministicUuid(`distribution:${code}`);
  const stamp = now.toISOString();
  const acceptanceId = crypto.randomUUID();
  const deadline = new Date(now.getTime() + config.operationDeadlineSeconds * 1000).toISOString();
  const context = JSON.stringify({
    version: 1,
    code,
    channelId: input.kind === "manual" ? command.channel_id : config.discordMvpAdminChannelId,
    maxLength: config.discordMessageMaxLength,
    maxChunks: config.summaryMaxChunks,
  });
  const canonical = `SELECT event_id FROM discovered_code_events
    WHERE source_guild_id=?5 AND source_channel_id=?6 AND source_message_id=?7 AND canonical_event_id IS NULL`;
  const marker =
    input.kind === "manual"
      ? db
          .prepare(
            `INSERT INTO manual_code_commands
          (event_id,guild_id,channel_id,author_id,code,status,operation_id,discord_created_at,
           accepted_at,acceptance_id)
          VALUES (?1,?2,?3,?4,?5,'pending',NULL,?6,?7,?8)
          ON CONFLICT(event_id) DO NOTHING`,
          )
          .bind(
            command.event_id,
            command.guild_id,
            command.channel_id,
            input.event.author_id,
            code,
            command.created_at,
            stamp,
            acceptanceId,
          )
      : db
          .prepare(
            `INSERT INTO discovered_code_events
      (event_id,guild_id,channel_id,webhook_id,source_guild_id,source_channel_id,source_message_id,
       code,expiry_label,status,canonical_event_id,operation_id,discord_created_at,accepted_at,acceptance_id)
     SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,
       CASE WHEN EXISTS (${canonical}) THEN 'duplicate_source' ELSE 'pending' END,
       (${canonical}),NULL,?10,?11,?12
     WHERE NOT EXISTS (SELECT 1 FROM discovered_code_events WHERE event_id=?1)
     ON CONFLICT(event_id) DO NOTHING`,
          )
          .bind(
            command.event_id,
            command.guild_id,
            command.channel_id,
            input.event.webhook_id,
            input.event.source_guild_id,
            input.event.source_channel_id,
            input.event.source_message_id,
            code,
            input.candidate.expiryLabel,
            command.created_at,
            stamp,
            acceptanceId,
          );
  try {
    await db.batch([
      marker,
      db
        .prepare(
          `INSERT INTO gift_codes(code,status,discovered_at,source,first_seen_event_id)
          SELECT ?1,'active',?2,'${source}',?3
          WHERE EXISTS (
            SELECT 1 FROM ${table}
            WHERE event_id=?3 AND acceptance_id=?4 AND status='pending'
          )
          ON CONFLICT(code) DO NOTHING`,
        )
        .bind(code, stamp, command.event_id, acceptanceId),
      db
        .prepare(
          `INSERT INTO operations
          (operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,deadline_at,
           created_at,updated_at,summary_context)
          SELECT ?1,'code_distribution_run','discord_event',?2,?3,
            CASE WHEN p.n<=2000 THEN p.n ELSE -1 END,?4,?3,?3,?5
          FROM (SELECT COUNT(*) AS n FROM players) p
          WHERE EXISTS (
            SELECT 1 FROM ${table}
            WHERE event_id=?6 AND acceptance_id=?7 AND status='pending'
          ) AND EXISTS (
            SELECT 1 FROM gift_codes
            WHERE code=?2 AND source='${source}' AND first_seen_event_id=?6
          )`,
        )
        .bind(operationId, code, stamp, deadline, context, command.event_id, acceptanceId),
      db
        .prepare(
          `INSERT INTO operation_players_snapshot(operation_id,player_id,display_name)
          SELECT ?1,p.player_id,p.display_name FROM players p
          WHERE EXISTS (
            SELECT 1 FROM ${table}
            WHERE event_id=?2 AND acceptance_id=?3 AND status='pending'
          ) AND EXISTS (
            SELECT 1 FROM gift_codes
            WHERE code=?4 AND source='${source}' AND first_seen_event_id=?2
          )
          ORDER BY p.player_id`,
        )
        .bind(operationId, command.event_id, acceptanceId, code),
      db
        .prepare(
          `UPDATE ${table}
          SET status=CASE WHEN EXISTS (
                SELECT 1 FROM operations o JOIN gift_codes g ON g.code=o.trigger_ref
                WHERE o.operation_id=?1 AND o.trigger_ref=?2 AND o.snapshot_at=?3
                  AND g.source='${source}' AND g.first_seen_event_id=?4
              ) THEN 'accepted' ELSE 'duplicate_code' END,
              operation_id=CASE WHEN EXISTS (
                SELECT 1 FROM operations o JOIN gift_codes g ON g.code=o.trigger_ref
                WHERE o.operation_id=?1 AND o.trigger_ref=?2 AND o.snapshot_at=?3
                  AND g.source='${source}' AND g.first_seen_event_id=?4
              ) THEN ?1 ELSE NULL END
          WHERE event_id=?4 AND acceptance_id=?5 AND status='pending'`,
        )
        .bind(operationId, code, stamp, command.event_id, acceptanceId),
    ]);
  } catch {
    const duplicate = await db
      .prepare(`SELECT acceptance_id FROM ${table} WHERE event_id=?1`)
      .bind(command.event_id)
      .first<{ acceptance_id: string }>();
    if (duplicate && duplicate.acceptance_id !== acceptanceId) return { kind: "duplicate_event" };
    throw new Error("distribution_not_accepted");
  }
  const result = await db
    .prepare(`SELECT acceptance_id,status,operation_id FROM ${table} WHERE event_id=?1`)
    .bind(command.event_id)
    .first<{ acceptance_id: string; status: string; operation_id: string | null }>();
  if (!result) throw new Error("distribution_not_accepted");
  if (result.acceptance_id !== acceptanceId) return { kind: "duplicate_event" };
  if (result.status === "duplicate_code" || result.status === "duplicate_source")
    return { kind: result.status };
  if (result.status === "accepted" && result.operation_id === operationId)
    return { kind: "accepted", operationId };
  throw new Error("distribution_not_accepted");
}

export async function expandPage(db: D1Database, now: string): Promise<void> {
  const op = await db
    .prepare(
      `SELECT o.operation_id,o.trigger_ref,o.expansion_cursor,o.expected_count FROM operations o
    WHERE o.type='code_distribution_run' AND o.expansion_state<>'expanded' AND ${mutableOperation} AND o.deadline_at>?1
    ORDER BY ${rotation("expansion")} LIMIT 1`,
    )
    .bind(now)
    .first<{
      operation_id: string;
      trigger_ref: string;
      expansion_cursor: string | null;
      expected_count: number;
    }>();
  if (!op) return;
  const rows = (
    await db
      .prepare(
        `SELECT player_id,display_name FROM operation_players_snapshot WHERE operation_id=?1 AND player_id>?2 ORDER BY player_id LIMIT 128`,
      )
      .bind(op.operation_id, op.expansion_cursor ?? "")
      .all<{ player_id: string; display_name: string | null }>()
  ).results;
  const page = rows.map((row) => ({
    ...row,
    label: renderDisplayLabel(row.display_name, row.player_id),
    attempt: crypto.randomUUID(),
  }));
  const cursor = rows.at(-1)?.player_id ?? op.expansion_cursor;
  const guard = `EXISTS(SELECT 1 FROM operations o WHERE o.operation_id=?1 AND o.expansion_cursor IS ?4 AND ${mutableOperation} AND o.deadline_at>?3)`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO operation_items(operation_id,item_key,player_id,code,job_id,status,display_label,updated_at)
      SELECT ?1,json_extract(j.value,'$.player_id'),json_extract(j.value,'$.player_id'),?2,
        'distribution:'||?1||':'||json_extract(j.value,'$.player_id'),'pending',json_extract(j.value,'$.label'),?3
      FROM json_each(?5) j WHERE ${guard} ON CONFLICT DO NOTHING`,
      )
      .bind(op.operation_id, op.trigger_ref, now, op.expansion_cursor, JSON.stringify(page)),
    db
      .prepare(
        `INSERT INTO outbox_jobs(job_id,operation_id,item_key,type,attempt_id,payload_json,status,attempts,available_at,created_at,updated_at)
      SELECT i.job_id,i.operation_id,i.item_key,'distribution',json_extract(j.value,'$.attempt'),
        json_object('operation_id',i.operation_id,'item_key',i.item_key,'job_id',i.job_id,'player_id',i.player_id,'code',i.code,'attempt_id',json_extract(j.value,'$.attempt')),
        'pending',0,?3,?3,?3 FROM json_each(?5) j JOIN operation_items i ON i.operation_id=?1 AND i.item_key=json_extract(j.value,'$.player_id')
      WHERE ${guard} AND ?2=?2 ON CONFLICT DO NOTHING`,
      )
      .bind(op.operation_id, op.trigger_ref, now, op.expansion_cursor, JSON.stringify(page)),
    db
      .prepare(
        `UPDATE operations AS o SET expansion_cursor=?2,expansion_state=CASE WHEN
        (SELECT COUNT(*) FROM operation_items i WHERE i.operation_id=o.operation_id)=expected_count THEN 'expanded' ELSE 'expanding' END,
        summary_state=CASE WHEN expected_count=0 THEN 'sealing' ELSE 'none' END,
        frozen_at=CASE WHEN expected_count=0 THEN ?3 ELSE NULL END,updated_at=?3
      WHERE operation_id=?1 AND expansion_cursor IS ?4 AND ${mutableOperation} AND deadline_at>?3`,
      )
      .bind(op.operation_id, cursor, now, op.expansion_cursor),
    progress(db, "expansion", op.operation_id),
  ]);
}

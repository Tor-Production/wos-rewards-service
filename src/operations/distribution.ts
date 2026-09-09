import type { AppConfig } from "../config";
import { deterministicUuid } from "../ingest/identity";
import { renderDisplayLabel } from "../ingest/sanitize";
import { mutableOperation, progress, rotation } from "../runtime/db";

/** Internal synthetic input only. No route, discovery adapter, or remote command exposes it. */
export async function openDistribution(
  db: D1Database,
  config: AppConfig,
  code: string,
  now: Date,
): Promise<string | null> {
  if (!code || new TextEncoder().encode(code).length > 128) throw new Error("synthetic_code_size");
  const id = await deterministicUuid(`distribution:${code}`);
  const stamp = now.toISOString();
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO gift_codes(code,status,discovered_at,source) VALUES (?1,'active',?2,'synthetic-local')",
        )
        .bind(code, stamp),
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

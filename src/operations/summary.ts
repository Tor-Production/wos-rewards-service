import { contentHash, deliveryId, nonceFor } from "../ingest/identity";
import { renderDisplayLabel } from "../ingest/sanitize";
import { progress, rotation, freeze, mutableOperation, terminalStatuses } from "../runtime/db";

export const RUNTIME_FOOTER =
  "ℹ️ To add yourself to automatic reward distribution, send the following in #wos-registration: PLAYER_ID [STATE] [NAME]. If STATE is omitted, the configured default state is used. Name is optional.";
interface Context {
  version: number;
  channelId: string;
  label?: string;
  playerId?: string;
  code?: string;
  maxLength: number;
  maxChunks: number;
}
interface Operation {
  operation_id: string;
  type: string;
  state: string;
  summary_state: string;
  summary_context: string | null;
  snapshot_cursor: string | null;
  summary_layout_cursor: string | null;
  summary_layout_open: string | null;
  summary_chunk_total: number | null;
  summary_build_cursor: number;
  expected_count: number;
  success_count: number | null;
  already_redeemed_count: number | null;
  permanent_failure_count: number | null;
  retry_exhausted_count: number | null;
  completed_count: number | null;
  uncertain_count: number | null;
}
interface Row {
  source_id?: number;
  code_label?: string;
  player_id: string;
  code: string;
  status: string;
  reason_code: string | null;
  display_label: string;
  sort_key: string;
}
interface Layout {
  chunk_index: number;
  first_sort_key: string | null;
  last_sort_key: string | null;
  overflow_remaining: number | null;
}
interface Open {
  index: number;
  first: string | null;
  last: string | null;
  length: number;
  listed: number;
  totalListed: number;
}
const ranks: Record<string, number> = {
  success: 0,
  already_redeemed: 1,
  permanent_failure: 2,
  retry_exhausted: 3,
  still_pending: 4,
};

function short(value: string, max: number): string {
  // Labels already escaped. Do not leave a dangling escape/surrogate at a truncation boundary.
  if (value.length <= max) return value;
  let result = "";
  for (const character of value) {
    if (result.length + character.length > max - 1) break;
    result += character;
  }
  result = result.replace(/\\+$/u, "");
  return result + "…";
}
function safeCode(code: string): string {
  return short(code.replace(/[\p{Cc}\p{Cf}]/gu, " "), 32).replace(/[\\`*_~|<>@#[\]()!]/gu, "\\$&");
}
function line(row: Row, ctx: Context, capacity = 160): string {
  const subject = ctx.code ? row.display_label : safeCode(row.code);
  const status =
    row.reason_code === "outcome_uncertain"
      ? "verification needed"
      : row.status === "success" || row.status === "already_redeemed"
        ? "applied"
        : row.status === "still_pending"
          ? "unfinished"
          : row.reason_code === "state_reevaluation_limit"
            ? "state re-check limit"
            : "failed";
  return `${short(subject, Math.max(8, Math.min(160, capacity - status.length - 4)))} — ${status}\n`;
}
function header(op: Operation, ctx: Context): string {
  const applied = (op.success_count ?? 0) + (op.already_redeemed_count ?? 0);
  const failed = (op.permanent_failure_count ?? 0) + (op.retry_exhausted_count ?? 0);
  const unfinished = op.expected_count - (op.completed_count ?? 0);
  return `${ctx.code ? `Code ${safeCode(ctx.code)}` : short(ctx.label ?? "Registration", 48)}\n${ctx.code ? `Applied to ${applied} players` : `${applied} codes applied`}; ${failed} failed; ${op.uncertain_count ? `${op.uncertain_count} need verification; ` : ""}${unfinished} unfinished.\n`;
}

/** One pass/page per call. Cursors and all page output commit together. */
export async function summaryPage(db: D1Database, now: string): Promise<void> {
  const op = await db
    .prepare(
      `SELECT o.* FROM operations o WHERE (o.summary_state IN ('sealing','building') OR (${mutableOperation} AND o.deadline_at>?1 AND o.expansion_state='expanded'
      AND o.expected_count=(SELECT COUNT(*) FROM operation_items i WHERE i.operation_id=o.operation_id)
      AND NOT EXISTS(SELECT 1 FROM operation_items i WHERE i.operation_id=o.operation_id AND i.status NOT IN (${terminalStatuses}))))
    AND o.summary_context IS NOT NULL ORDER BY ${rotation("summary")} LIMIT 1`,
    )
    .bind(now)
    .first<Operation>();
  if (!op) return;
  if (op.summary_state === "none") {
    await db.batch([freeze(db, now, op.operation_id), progress(db, "summary", op.operation_id)]);
    return;
  }
  const ctx = JSON.parse(op.summary_context!) as Context;
  if (
    ctx.version !== 1 ||
    !/^\d{1,20}$/.test(ctx.channelId) ||
    ctx.maxLength < 500 ||
    ctx.maxLength > 2000
  )
    throw new Error("summary_context_invalid");
  if (op.summary_state === "sealing") {
    const rows = (
      await db
        .prepare(
          `WITH page AS (SELECT i.rowid AS source_id,s.player_id,?2 AS code,COALESCE(i.status,'pending') AS status,i.reason_code,
        i.display_label,s.display_name FROM operation_players_snapshot s
        LEFT JOIN operation_items i ON i.operation_id=s.operation_id AND i.player_id=s.player_id AND i.code=?2
        WHERE s.operation_id=?1 AND (s.player_id||char(0)||?2)>?3 AND ?4='code_distribution_run'
      UNION ALL SELECT i.rowid AS source_id,i.player_id,i.code,i.status,i.reason_code,i.display_label,NULL FROM operation_items i
        WHERE i.operation_id=?1 AND (i.player_id||char(0)||i.code)>?3 AND ?4<>'code_distribution_run'
      ORDER BY player_id,code LIMIT 128), sized AS (SELECT *, SUM(length(CAST(code AS BLOB))+COALESCE(length(CAST(display_label AS BLOB)),0)+COALESCE(length(CAST(display_name AS BLOB)),0)+256) OVER(ORDER BY player_id,code) AS page_bytes,ROW_NUMBER() OVER(ORDER BY player_id,code) AS page_row FROM page) SELECT * FROM sized WHERE page_bytes<=262144 OR page_row=1 ORDER BY player_id,code`,
        )
        .bind(op.operation_id, ctx.code ?? "", op.snapshot_cursor ?? "", op.type)
        .all<Row & { display_name: string | null }>()
    ).results;
    const sealed = await Promise.all(
      rows.map(async (row) => {
        const status =
          row.status === "pending" || row.status === "in_progress" ? "still_pending" : row.status;
        return {
          source_id: row.source_id,
          player_id: row.player_id,
          status,
          reason_code: row.reason_code,
          display_label: row.source_id ? null : renderDisplayLabel(row.display_name, row.player_id),
          code_label: safeCode(row.code),
          sort_key: `${ranks[status]}|${row.player_id}|${await contentHash(row.code)}`,
        };
      }),
    );
    const last = rows.at(-1);
    const cursor = last ? `${last.player_id}\0${last.code}` : op.snapshot_cursor;
    await db.batch([
      db
        .prepare(
          `INSERT INTO summary_item_snapshot(operation_id,player_id,code,status,reason_code,display_label,sort_key,created_at,code_label)
        SELECT ?1,json_extract(j.value,'$.player_id'),COALESCE(source.code,?6),json_extract(j.value,'$.status'),json_extract(j.value,'$.reason_code'),
          COALESCE(source.display_label,json_extract(j.value,'$.display_label')),json_extract(j.value,'$.sort_key'),?2,json_extract(j.value,'$.code_label') FROM json_each(?3) j LEFT JOIN operation_items source ON source.rowid=json_extract(j.value,'$.source_id')
        WHERE EXISTS(SELECT 1 FROM operations WHERE operation_id=?1 AND summary_state='sealing' AND snapshot_cursor IS ?4) AND ?5=?5 ON CONFLICT DO NOTHING`,
        )
        .bind(
          op.operation_id,
          now,
          JSON.stringify(sealed),
          op.snapshot_cursor,
          rows.length,
          ctx.code ?? "",
        ),
      db
        .prepare(
          `UPDATE operations SET snapshot_cursor=?2,summary_state=CASE WHEN ?3=0 THEN 'building' ELSE 'sealing' END,
        snapshot_sealed_at=CASE WHEN ?3=0 THEN ?4 ELSE NULL END,updated_at=?4,
        success_count=(SELECT COUNT(*) FROM summary_item_snapshot WHERE operation_id=?1 AND status='success'),
        already_redeemed_count=(SELECT COUNT(*) FROM summary_item_snapshot WHERE operation_id=?1 AND status='already_redeemed'),
        permanent_failure_count=(SELECT COUNT(*) FROM summary_item_snapshot WHERE operation_id=?1 AND status='permanent_failure' AND reason_code IS NOT 'outcome_uncertain'),
        uncertain_count=(SELECT COUNT(*) FROM summary_item_snapshot WHERE operation_id=?1 AND reason_code='outcome_uncertain'),
        retry_exhausted_count=(SELECT COUNT(*) FROM summary_item_snapshot WHERE operation_id=?1 AND status='retry_exhausted'),
        completed_count=(SELECT COUNT(*) FROM summary_item_snapshot WHERE operation_id=?1 AND status<>'still_pending')
        WHERE operation_id=?1 AND summary_state='sealing' AND snapshot_cursor IS ?5`,
        )
        .bind(op.operation_id, cursor, rows.length, now, op.snapshot_cursor),
      progress(db, "summary", op.operation_id),
    ]);
    return;
  }
  if (op.summary_chunk_total === null) {
    const rows = (
      await db
        .prepare(
          "SELECT player_id,COALESCE(code_label,substr(code,1,64)) AS code,status,reason_code,substr(display_label,1,160) AS display_label,sort_key FROM summary_item_snapshot WHERE operation_id=?1 AND sort_key>?2 ORDER BY sort_key LIMIT 128",
        )
        .bind(op.operation_id, op.summary_layout_cursor ?? "")
        .all<Row>()
    ).results;
    const open: Open = op.summary_layout_open
      ? (JSON.parse(op.summary_layout_open) as Open)
      : { index: 1, first: null, last: null, length: 0, listed: 0, totalListed: 0 };
    // Reserve the final-only footer, largest part marker and overflow on EVERY boundary.
    const capacity = ctx.maxLength - header(op, ctx).length - RUNTIME_FOOTER.length - 55;
    const layouts: Layout[] = [];
    let lastCursor = op.summary_layout_cursor;
    let finished = false;
    for (const row of rows) {
      const length = line(row, ctx, capacity).length;
      if (length > capacity) throw new Error("summary_row_exceeds_reserved_capacity");
      if (open.length + length > capacity) {
        if (open.index === ctx.maxChunks) {
          finished = true;
          break;
        }
        layouts.push({
          chunk_index: open.index,
          first_sort_key: open.first,
          last_sort_key: open.last,
          overflow_remaining: null,
        });
        open.index++;
        open.first = null;
        open.last = null;
        open.length = 0;
        open.listed = 0;
      }
      open.first ??= row.sort_key;
      open.last = row.sort_key;
      open.length += length;
      open.listed++;
      open.totalListed++;
      lastCursor = row.sort_key;
    }
    finished ||= rows.length < 128;
    if (finished)
      layouts.push({
        chunk_index: open.index,
        first_sort_key: open.first,
        last_sort_key: open.last,
        overflow_remaining: op.expected_count - open.totalListed,
      });
    await db.batch([
      db
        .prepare(
          `INSERT INTO summary_chunk_layout(operation_id,chunk_index,first_sort_key,last_sort_key,overflow_remaining,created_at)
        SELECT ?1,json_extract(value,'$.chunk_index'),json_extract(value,'$.first_sort_key'),json_extract(value,'$.last_sort_key'),json_extract(value,'$.overflow_remaining'),?2
        FROM json_each(?3) WHERE EXISTS(SELECT 1 FROM operations WHERE operation_id=?1 AND summary_chunk_total IS NULL AND summary_layout_cursor IS ?4 AND summary_layout_open IS ?5)
        ON CONFLICT DO NOTHING`,
        )
        .bind(
          op.operation_id,
          now,
          JSON.stringify(layouts),
          op.summary_layout_cursor,
          op.summary_layout_open,
        ),
      db
        .prepare(
          `UPDATE operations SET summary_layout_cursor=?2,summary_layout_open=?3,summary_chunk_total=?4,updated_at=?5
        WHERE operation_id=?1 AND summary_chunk_total IS NULL AND summary_layout_cursor IS ?6 AND summary_layout_open IS ?7`,
        )
        .bind(
          op.operation_id,
          lastCursor,
          JSON.stringify(open),
          finished ? open.index : null,
          now,
          op.summary_layout_cursor,
          op.summary_layout_open,
        ),
      progress(db, "summary", op.operation_id),
    ]);
    return;
  }
  const index = op.summary_build_cursor + 1;
  const layout = await db
    .prepare("SELECT * FROM summary_chunk_layout WHERE operation_id=?1 AND chunk_index=?2")
    .bind(op.operation_id, index)
    .first<Layout>();
  if (!layout) throw new Error("missing_summary_layout");
  const rows = (
    await db
      .prepare(
        "SELECT player_id,COALESCE(code_label,substr(code,1,64)) AS code,status,reason_code,substr(display_label,1,160) AS display_label,sort_key FROM summary_item_snapshot WHERE operation_id=?1 AND sort_key BETWEEN ?2 AND ?3 ORDER BY sort_key LIMIT 256",
      )
      .bind(op.operation_id, layout.first_sort_key, layout.last_sort_key)
      .all<Row>()
  ).results;
  const final = index === op.summary_chunk_total;
  const content =
    header(op, ctx) +
    `(part ${index}/${op.summary_chunk_total})\n` +
    rows
      .map((row) =>
        line(row, ctx, ctx.maxLength - header(op, ctx).length - RUNTIME_FOOTER.length - 55),
      )
      .join("") +
    (layout.overflow_remaining ? `+${layout.overflow_remaining} more not listed\n` : "") +
    (final ? RUNTIME_FOOTER : "");
  if (content.length > ctx.maxLength) throw new Error("summary_content_overflow");
  const group = `sum:${op.operation_id}`;
  const id = deliveryId(group, index);
  await db.batch([
    db
      .prepare(
        `INSERT INTO discord_output_deliveries(delivery_id,delivery_group,operation_id,channel_id,output_type,chunk_index,chunk_total,content,content_hash,has_footer,nonce,created_at,updated_at,available_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?12
      WHERE EXISTS(SELECT 1 FROM operations WHERE operation_id=?3 AND summary_state='building' AND summary_build_cursor=?13) ON CONFLICT DO NOTHING`,
      )
      .bind(
        id,
        group,
        op.operation_id,
        ctx.channelId,
        op.state === "stale_closed"
          ? "partial_summary"
          : op.type === "registration_run"
            ? "registration_summary"
            : "distribution_summary",
        index,
        op.summary_chunk_total,
        content,
        await contentHash(content),
        final ? 1 : 0,
        await nonceFor(id),
        now,
        op.summary_build_cursor,
      ),
    db
      .prepare(
        `UPDATE operations SET summary_build_cursor=?2,summary_delivery_group=?3,summary_state=?4,updated_at=?5
      WHERE operation_id=?1 AND summary_state='building' AND summary_build_cursor=?6`,
      )
      .bind(
        op.operation_id,
        index,
        group,
        final ? "built" : "building",
        now,
        op.summary_build_cursor,
      ),
    progress(db, "summary", op.operation_id),
  ]);
}

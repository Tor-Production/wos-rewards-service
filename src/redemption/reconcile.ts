import { rotation, progress } from "../runtime/db";

const applicable = `r.current_terminal_generation=t.budget_generation AND r.status=t.status
  AND (t.reason_code IS NULL OR t.reason_code<>'player_ineligible' OR t.attempt_state=p.state)`;
export interface Recipient {
  row_id: number;
  operation_id: string;
  item_key: string;
  player_id: string;
  code: string;
  budget_generation: number;
}

/**
 * Account for the item that produced a terminal result in the same transaction as
 * the result and observation. This closes the crash window before asynchronous
 * mirror/reuse reconciliation while retaining the same applicability guards.
 */
export function initiatingRecipientStatements(
  db: D1Database,
  now: string,
  operationId: string,
  itemKey: string,
): D1PreparedStatement[] {
  const cte = `WITH c AS (SELECT i.*,o.summary_state,o.deadline_at,t.status AS outcome,t.reason_code AS reason,
    t.observed_at,t.budget_generation FROM operation_items i
    JOIN operations o ON o.operation_id=i.operation_id
    JOIN redemptions r ON r.player_id=i.player_id AND r.code=i.code
    JOIN players p ON p.player_id=i.player_id
    JOIN terminal_observations t ON t.player_id=r.player_id AND t.code=r.code
    WHERE i.operation_id=?1 AND i.item_key=?2 AND ${applicable}
    AND (o.type<>'repair_run' OR o.repair_authorized_at IS NOT NULL))`;
  return [
    db
      .prepare(
        `${cte} UPDATE operation_items AS i SET status=c.outcome,reason_code=c.reason,claim_token=NULL,claim_expires_at=NULL,updated_at=?3
      FROM c WHERE i.operation_id=c.operation_id AND i.item_key=c.item_key AND i.status IN ('pending','in_progress')
      AND c.summary_state='none' AND c.deadline_at>?3`,
      )
      .bind(operationId, itemKey, now),
    db
      .prepare(
        `${cte} INSERT INTO operation_late_results(operation_id,player_id,code,observed_at,status,reason_code)
      SELECT operation_id,player_id,code,observed_at,outcome,reason FROM c WHERE summary_state<>'none' OR deadline_at<=?3
      ON CONFLICT(operation_id,player_id,code,observed_at) DO NOTHING`,
      )
      .bind(operationId, itemKey, now),
    db
      .prepare(
        `${cte} INSERT INTO terminal_receipts(player_id,code,budget_generation,operation_id,item_key,disposition)
      SELECT player_id,code,budget_generation,operation_id,item_key,
        CASE WHEN summary_state<>'none' OR deadline_at<=?3 THEN 'audited' ELSE 'applied' END FROM c WHERE true
      ON CONFLICT DO NOTHING`,
      )
      .bind(operationId, itemKey, now),
  ];
}

/** Each page is revalidated inside its transaction, including a reopen/freeze after selection. */
export async function applyRecipients(
  db: D1Database,
  now: string,
  recipients: Recipient[],
  tail: D1PreparedStatement[] = [],
): Promise<void> {
  const cte = `WITH c AS (SELECT i.*,o.summary_state,o.deadline_at,t.status AS outcome,t.reason_code AS reason,
    t.observed_at,t.budget_generation FROM json_each(?1) j
    JOIN operation_items i ON i.rowid=json_extract(j.value,'$.row_id')
    JOIN operations o ON o.operation_id=i.operation_id
    JOIN redemptions r ON r.player_id=i.player_id AND r.code=i.code
    JOIN players p ON p.player_id=i.player_id
    JOIN terminal_observations t ON t.player_id=i.player_id AND t.code=i.code AND t.budget_generation=json_extract(j.value,'$.budget_generation')
    WHERE ${applicable})`;
  const json = JSON.stringify(
    recipients.map(({ row_id, budget_generation }) => ({ row_id, budget_generation })),
  );
  await db.batch([
    db
      .prepare(
        `${cte} UPDATE operation_items AS i SET status=c.outcome,reason_code=c.reason,claim_token=NULL,claim_expires_at=NULL,updated_at=?2
      FROM c WHERE i.operation_id=c.operation_id AND i.item_key=c.item_key AND i.status IN ('pending','in_progress')
      AND c.summary_state='none' AND c.deadline_at>?2`,
      )
      .bind(json, now),
    db
      .prepare(
        `${cte} INSERT INTO operation_late_results(operation_id,player_id,code,observed_at,status,reason_code)
      SELECT operation_id,player_id,code,observed_at,outcome,reason FROM c WHERE summary_state<>'none' OR deadline_at<=?2
      ON CONFLICT(operation_id,player_id,code,observed_at) DO NOTHING`,
      )
      .bind(json, now),
    db
      .prepare(
        `${cte} INSERT INTO terminal_receipts(player_id,code,budget_generation,operation_id,item_key,disposition)
      SELECT player_id,code,budget_generation,operation_id,item_key,
        CASE WHEN summary_state<>'none' OR deadline_at<=?2 THEN 'audited' ELSE 'applied' END FROM c WHERE true
      ON CONFLICT DO NOTHING`,
      )
      .bind(json, now),
    ...tail,
  ]);
}

export async function recipients(
  db: D1Database,
  filter: string,
  binds: (string | number)[],
): Promise<Recipient[]> {
  return (
    await db
      .prepare(
        `WITH page AS (SELECT i.rowid AS row_id,i.operation_id,i.item_key,i.player_id,i.code,t.budget_generation
    FROM operation_items i JOIN operations o ON o.operation_id=i.operation_id
    JOIN redemptions r ON r.player_id=i.player_id AND r.code=i.code JOIN players p ON p.player_id=i.player_id
    JOIN terminal_observations t ON t.player_id=r.player_id AND t.code=r.code AND t.budget_generation=r.current_terminal_generation
    WHERE ${applicable} AND (${filter}) AND (i.status IN ('pending','in_progress') OR o.summary_state<>'none')
    AND (o.type<>'repair_run' OR o.repair_authorized_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM terminal_receipts x WHERE x.player_id=t.player_id AND x.code=t.code
      AND x.budget_generation=t.budget_generation AND x.operation_id=i.operation_id AND x.item_key=i.item_key)
    ORDER BY i.operation_id,i.item_key LIMIT 128), sized AS (SELECT *,SUM(length(CAST(item_key AS BLOB))+length(CAST(code AS BLOB))+256) OVER(ORDER BY operation_id,item_key) AS page_bytes, ROW_NUMBER() OVER(ORDER BY operation_id,item_key) AS page_row FROM page) SELECT * FROM sized WHERE page_bytes<=262144 OR page_row=1 ORDER BY operation_id,item_key`,
      )
      .bind(...binds)
      .all<Recipient>()
  ).results;
}

export async function reuseTerminal(db: D1Database, now: string): Promise<void> {
  const op = await db
    .prepare(
      `SELECT o.operation_id FROM operations o WHERE (o.type<>'repair_run' OR o.repair_authorized_at IS NOT NULL)
    AND EXISTS (SELECT 1 FROM operation_items i JOIN redemptions r ON r.player_id=i.player_id AND r.code=i.code
      WHERE i.operation_id=o.operation_id AND r.current_terminal_generation IS NOT NULL
      AND (i.status IN ('pending','in_progress') OR o.summary_state<>'none')
      AND NOT EXISTS (SELECT 1 FROM terminal_receipts x WHERE x.player_id=i.player_id AND x.code=i.code
        AND x.budget_generation=r.current_terminal_generation AND x.operation_id=i.operation_id AND x.item_key=i.item_key))
    ORDER BY ${rotation("reuse")} LIMIT 1`,
    )
    .first<{ operation_id: string }>();
  if (!op) return;
  const page = await recipients(db, "i.operation_id=?1", [op.operation_id]);
  await applyRecipients(db, now, page, [progress(db, "reuse", op.operation_id)]);
}

/** A completed traversal is not a subscription: reuseTerminal separately finds new recipients. */
export async function mirrorObservation(db: D1Database, now: string): Promise<void> {
  const obs = await db
    .prepare(
      `SELECT t.* FROM terminal_observations t WHERE mirror_complete=0 ORDER BY observed_at,player_id,code LIMIT 1`,
    )
    .first<{
      player_id: string;
      code: string;
      budget_generation: number;
      mirror_cursor: string | null;
    }>();
  if (!obs) return;
  const page = await recipients(
    db,
    `i.player_id=?1 AND i.code=?2 AND t.budget_generation=?3 AND (i.operation_id || char(0) || i.item_key)>?4`,
    [obs.player_id, obs.code, obs.budget_generation, obs.mirror_cursor ?? ""],
  );
  const last = page.at(-1);
  await applyRecipients(db, now, page, [
    db
      .prepare(
        `UPDATE terminal_observations SET mirror_cursor=?1,mirror_complete=?2
    WHERE player_id=?3 AND code=?4 AND budget_generation=?5 AND mirror_cursor IS ?6 AND mirror_complete=0`,
      )
      .bind(
        last ? `${last.operation_id}\0${last.item_key}` : obs.mirror_cursor,
        page.length === 0 ? 1 : 0,
        obs.player_id,
        obs.code,
        obs.budget_generation,
        obs.mirror_cursor,
      ),
  ]);
}

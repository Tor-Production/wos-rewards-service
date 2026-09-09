import { deterministicUuid } from "../ingest/identity";
import { renderDisplayLabel } from "../ingest/sanitize";
import type { AppConfig } from "../config";
import { closeBudget } from "../redemption/consumer";
import { mirrorObservation, reuseTerminal } from "../redemption/reconcile";
import { mutableOperation, progress, rotation, terminalStatuses } from "../runtime/db";
interface Stuck {
  display_label: string;
  operation_id: string;
  item_key: string;
  player_id: string;
  code: string;
  job_id: string;
  attempt_id: string;
  current_attempt_id: string | null;
  status: string | null;
  provider_invocations: number | null;
  provider_invocation_limit: number | null;
  outbox_status: string;
}

export async function recover(db: D1Database, config: AppConfig, now: string): Promise<void> {
  const tick = await db
    .prepare(
      `INSERT INTO scheduler_progress(lane,cursor,turn) VALUES ('recovery','',0)
    ON CONFLICT(lane) DO UPDATE SET turn=turn+1 RETURNING turn`,
    )
    .first<{ turn: number }>();
  await db
    .prepare(
      `UPDATE operations AS o SET summary_state='sealing',frozen_at=?1,updated_at=?1,
    state=CASE WHEN expansion_state='expanded' AND expected_count=(SELECT COUNT(*) FROM operation_items i WHERE i.operation_id=o.operation_id)
      AND NOT EXISTS(SELECT 1 FROM operation_items i WHERE i.operation_id=o.operation_id AND (i.status NOT IN (${terminalStatuses}) OR i.updated_at>o.deadline_at))
      THEN 'awaiting_summary' ELSE 'stale_closed' END
    WHERE operation_id IN (SELECT o.operation_id FROM operations o WHERE ${mutableOperation} AND deadline_at<=?1 ORDER BY deadline_at,operation_id LIMIT 128)`,
    )
    .bind(now)
    .run();
  const turn = tick?.turn ?? 0;
  if (turn % 2 === 0) {
    await reuseTerminal(db, now);
    return;
  }
  switch (Math.floor(turn / 2) % 3) {
    case 0:
      await mirrorObservation(db, now);
      break;
    case 1:
      await redrive(db, config, now);
      break;
    case 2:
      await deadOutbox(db, now);
      break;
  }
}

export async function redrive(db: D1Database, config: AppConfig, now: string): Promise<void> {
  const threshold = new Date(Date.parse(now) - config.redemptionLeaseSeconds * 1000).toISOString();
  const row = await db
    .prepare(
      `SELECT i.*,b.attempt_id,b.status AS outbox_status,r.status AS status,r.current_attempt_id,r.provider_invocations,r.provider_invocation_limit
    FROM operation_items i JOIN operations o ON o.operation_id=i.operation_id JOIN outbox_jobs b ON b.job_id=i.job_id
    LEFT JOIN redemptions r ON r.player_id=i.player_id AND r.code=i.code JOIN players p ON p.player_id=i.player_id
    WHERE ${mutableOperation} AND o.deadline_at>?1 AND i.status IN ('pending','in_progress')
    AND (r.player_id IS NULL OR r.status='pending' OR (r.status IN ('in_progress','retry_wait') AND (r.invocation_expires_at IS NULL OR r.invocation_expires_at<?1))
      OR (r.status='permanent_failure' AND r.reason_code='player_ineligible' AND r.attempt_state<>p.state AND r.reeval_count<?3))
    AND b.status IN ('enqueued','dead') AND b.updated_at<?2 AND (r.updated_at IS NULL OR r.updated_at<?2)
    ORDER BY ${rotation("redrive")} LIMIT 1`,
    )
    .bind(now, threshold, config.redemptionMaxReeval)
    .first<Stuck>();
  if (!row) return;
  if (
    row.status !== "permanent_failure" &&
    (row.provider_invocations ?? 0) >=
      (row.provider_invocation_limit ?? config.providerMaxInvocations)
  ) {
    await closeBudget(
      db,
      { ...row, attempt_id: row.current_attempt_id ?? row.attempt_id },
      now,
      true,
    );
    return;
  }
  const aid = crypto.randomUUID();
  const guard = `EXISTS(SELECT 1 FROM operations o WHERE o.operation_id=?1 AND ${mutableOperation} AND deadline_at>?3)
    AND EXISTS(SELECT 1 FROM outbox_jobs b WHERE b.job_id=?2 AND b.attempt_id=?4 AND b.status IN ('enqueued','dead'))`;
  await db.batch([
    db
      .prepare(
        `UPDATE redemptions SET status='pending',current_attempt_id=NULL,current_invocation_token=NULL,invocation_expires_at=NULL,retry_due_at=NULL,
      budget_generation=budget_generation+CASE WHEN status='permanent_failure' THEN 1 ELSE 0 END,
      provider_invocations=CASE WHEN status='permanent_failure' THEN 0 ELSE provider_invocations END,
      provider_invocation_limit=CASE WHEN status='permanent_failure' THEN ?8 ELSE provider_invocation_limit END,
      reeval_count=reeval_count+CASE WHEN status='permanent_failure' THEN 1 ELSE 0 END,
      attempts=CASE WHEN status='permanent_failure' THEN 0 ELSE attempts END,attempt_generation=attempt_generation+CASE WHEN status='permanent_failure' THEN 1 ELSE 0 END,
      current_terminal_generation=NULL,reason_code=NULL,terminal_at=NULL,updated_at=?3
      WHERE player_id=?5 AND code=?6 AND ${guard} AND (status='pending' OR (status IN ('in_progress','retry_wait') AND (invocation_expires_at IS NULL OR invocation_expires_at<?3))
        OR (status='permanent_failure' AND reason_code='player_ineligible' AND attempt_state<>(SELECT state FROM players WHERE player_id=?5) AND reeval_count<?7))`,
      )
      .bind(
        row.operation_id,
        row.job_id,
        now,
        row.attempt_id,
        row.player_id,
        row.code,
        config.redemptionMaxReeval,
        config.providerMaxInvocations,
      ),
    db
      .prepare(
        `UPDATE operation_items SET status='pending',claim_token=NULL,claim_expires_at=NULL,updated_at=?3
      WHERE job_id=?2 AND status IN ('pending','in_progress') AND ${guard}
      AND NOT EXISTS(SELECT 1 FROM redemptions r WHERE r.player_id=operation_items.player_id AND r.code=operation_items.code AND r.status<>'pending')`,
      )
      .bind(row.operation_id, row.job_id, now, row.attempt_id),
    db
      .prepare(
        `UPDATE outbox_jobs SET attempt_id=?5,payload_json=json_object('operation_id',operation_id,'item_key',item_key,'job_id',job_id,'player_id',?6,'code',?7,'attempt_id',?5),status='pending',attempts=0,available_at=?3,updated_at=?3,last_error=NULL
      WHERE job_id=?2 AND ${guard} AND EXISTS(SELECT 1 FROM operation_items i WHERE i.job_id=?2 AND i.status='pending' AND i.updated_at=?3)`,
      )
      .bind(row.operation_id, row.job_id, now, row.attempt_id, aid, row.player_id, row.code),
    progress(db, "redrive", row.operation_id),
  ]);
}

/** Repair stubs contain one pair, so the existing distribution-shaped job identity suffices. */
export async function deadOutbox(db: D1Database, now: string): Promise<void> {
  const row = await db
    .prepare(
      `SELECT i.*,b.attempt_id,o.summary_state,o.state,o.deadline_at,o.summary_context FROM outbox_jobs b
    JOIN operation_items i ON i.job_id=b.job_id JOIN operations o ON o.operation_id=i.operation_id
    WHERE b.status='dead' AND NOT EXISTS(SELECT 1 FROM operations repair WHERE repair.operation_id='repair:'||b.job_id||':'||b.attempt_id)
    AND (i.status IN ('pending','in_progress') OR o.summary_state<>'none') ORDER BY b.updated_at,b.job_id LIMIT 1`,
    )
    .first<
      Stuck & {
        summary_state: string;
        state: string;
        deadline_at: string;
        summary_context: string | null;
      }
    >();
  if (!row) return;
  if (
    row.summary_state === "none" &&
    row.deadline_at > now &&
    !["summarized", "stale_closed"].includes(row.state)
  ) {
    const aid = crypto.randomUUID();
    const eligible = `EXISTS(SELECT 1 FROM operations o WHERE o.operation_id=?1 AND ${mutableOperation} AND deadline_at>?3)
      AND NOT EXISTS(SELECT 1 FROM redemptions r WHERE r.player_id=?5 AND r.code=?6 AND (r.status IN (${terminalStatuses}) OR (r.status IN ('in_progress','retry_wait') AND r.invocation_expires_at>=?3)))`;
    await db.batch([
      db
        .prepare(
          `UPDATE operation_items SET status='pending',claim_token=NULL,claim_expires_at=NULL,updated_at=?3
        WHERE job_id=?2 AND status IN ('pending','in_progress') AND ${eligible}
        AND EXISTS(SELECT 1 FROM outbox_jobs WHERE job_id=?2 AND status='dead' AND attempt_id=?4)`,
        )
        .bind(row.operation_id, row.job_id, now, row.attempt_id, row.player_id, row.code),
      db
        .prepare(
          `UPDATE outbox_jobs SET status='pending',attempts=0,attempt_id=?7,
        payload_json=json_object('operation_id',operation_id,'item_key',item_key,'job_id',job_id,'player_id',?5,'code',?6,'attempt_id',?7),
        available_at=?3,updated_at=?3,last_error=NULL WHERE job_id=?2 AND attempt_id=?4 AND status='dead' AND ${eligible}
        AND EXISTS(SELECT 1 FROM operation_items WHERE job_id=?2 AND status='pending' AND updated_at=?3)`,
        )
        .bind(row.operation_id, row.job_id, now, row.attempt_id, row.player_id, row.code, aid),
    ]);
    return;
  }
  const id = `repair:${row.job_id}:${row.attempt_id}`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO operation_late_results(operation_id,player_id,code,observed_at,status,reason_code)
      VALUES (?1,?2,?3,?4,'retry_exhausted','outbox_dead') ON CONFLICT DO NOTHING`,
      )
      .bind(row.operation_id, row.player_id, row.code, now),
    db
      .prepare(
        `INSERT INTO operations(operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,expansion_state,deadline_at,created_at,updated_at,summary_context)
      VALUES (?1,'repair_run','human_repair',?2,?3,1,'expanded',?3,?3,?3,?4) ON CONFLICT DO NOTHING`,
      )
      .bind(id, row.operation_id, now, row.summary_context),
    db
      .prepare(
        `INSERT INTO operation_items(operation_id,item_key,player_id,code,job_id,status,display_label,updated_at)
      VALUES (?1,?2,?2,?3,'distribution:'||?1||':'||?2,'pending',?4,?5) ON CONFLICT DO NOTHING`,
      )
      .bind(id, row.player_id, row.code, row.display_label, now),
  ]);
}

/** A caller must explicitly select this parked repair. This function is never called by a handler. */
export async function authorizeRepair(
  db: D1Database,
  config: AppConfig,
  id: string,
  now: Date,
  resetReeval = false,
): Promise<void> {
  const stamp = now.toISOString();
  const aid = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        `UPDATE operations SET repair_authorized_at=?2,deadline_at=?3,updated_at=?2
      WHERE operation_id=?1 AND type='repair_run' AND repair_authorized_at IS NULL AND summary_state='none'`,
      )
      .bind(
        id,
        stamp,
        new Date(now.getTime() + config.operationDeadlineSeconds * 1000).toISOString(),
      ),
    db
      .prepare(
        `UPDATE redemptions SET status='pending',budget_generation=budget_generation+1,provider_invocations=0,provider_invocation_limit=?3,attempt_generation=attempt_generation+1,attempts=0,
      current_terminal_generation=NULL,current_attempt_id=NULL,current_invocation_token=NULL,invocation_expires_at=NULL,retry_due_at=NULL,
      reason_code=NULL,terminal_at=NULL,reeval_count=CASE WHEN ?4=1 THEN 0 ELSE reeval_count END,updated_at=?2
      WHERE status IN ('permanent_failure','retry_exhausted') AND EXISTS(SELECT 1 FROM operation_items i JOIN operations o ON o.operation_id=i.operation_id
        WHERE i.operation_id=?1 AND i.player_id=redemptions.player_id AND i.code=redemptions.code AND o.repair_authorized_at=?2)
        AND NOT EXISTS(SELECT 1 FROM outbox_jobs b WHERE b.operation_id=?1)`,
      )
      .bind(id, stamp, config.providerMaxInvocations, resetReeval ? 1 : 0),
    db
      .prepare(
        `INSERT INTO outbox_jobs(job_id,operation_id,item_key,type,attempt_id,payload_json,status,available_at,created_at,updated_at)
      SELECT i.job_id,i.operation_id,i.item_key,'distribution',?3,
        json_object('operation_id',i.operation_id,'item_key',i.item_key,'job_id',i.job_id,'player_id',i.player_id,'code',i.code,'attempt_id',?3),'pending',?2,?2,?2
      FROM operation_items i JOIN operations o ON o.operation_id=i.operation_id WHERE i.operation_id=?1 AND o.repair_authorized_at=?2 ON CONFLICT DO NOTHING`,
      )
      .bind(id, stamp, aid),
  ]);
}

/** Explicit operator input only. requestId makes an operator retry idempotent. */
export async function openRepairRun(
  db: D1Database,
  config: AppConfig,
  requestId: string,
  playerId: string,
  code: string,
  now: Date,
): Promise<string | null> {
  if (!requestId || requestId.length > 128) throw new Error("repair_request_invalid");
  const id = await deterministicUuid(`repair:${requestId}`);
  const source = await db
    .prepare(
      `SELECT p.display_name FROM players p JOIN redemptions r ON r.player_id=p.player_id WHERE p.player_id=?1 AND r.code=?2 AND r.status IN ('permanent_failure','retry_exhausted')`,
    )
    .bind(playerId, code)
    .first<{ display_name: string | null }>();
  if (!source) return null;
  const stamp = now.toISOString();
  const label = renderDisplayLabel(source.display_name, playerId);
  await db.batch([
    db
      .prepare(
        `INSERT INTO operations(operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,expansion_state,deadline_at,created_at,updated_at,summary_context)
      SELECT ?1,'repair_run','human_repair',?2,?3,1,'expanded',?3,?3,?3,?4
      WHERE EXISTS(SELECT 1 FROM redemptions WHERE player_id=?5 AND code=?6 AND status IN ('permanent_failure','retry_exhausted')) ON CONFLICT DO NOTHING`,
      )
      .bind(
        id,
        requestId,
        stamp,
        JSON.stringify({
          version: 1,
          code,
          channelId: config.discordRegistrationChannelId,
          maxLength: config.discordMessageMaxLength,
          maxChunks: config.summaryMaxChunks,
        }),
        playerId,
        code,
      ),
    db
      .prepare(
        `INSERT INTO operation_items(operation_id,item_key,player_id,code,job_id,status,display_label,updated_at)
      SELECT ?1,?2,?2,?3,'distribution:'||?1||':'||?2,'pending',?4,?5
      WHERE EXISTS(SELECT 1 FROM operations WHERE operation_id=?1 AND repair_authorized_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM operation_items WHERE operation_id=?1) ON CONFLICT DO NOTHING`,
      )
      .bind(id, playerId, code, label, stamp),
  ]);
  return id;
}

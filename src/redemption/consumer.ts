import type { AppConfig } from "../config";
import { isRedemptionJobBody, type RedemptionJobBody } from "../domain/queue-jobs";
import type { RedeemResult, WhiteoutProvider } from "../domain/whiteout-provider";
import { isReplaySafeMock } from "../providers/mock-whiteout-provider";
import { budgetDatabase, freeze, mutableOperation } from "../runtime/db";
import { applyRecipients, initiatingRecipientStatements, recipients } from "./reconcile";

export interface Delivery {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds: number }): void;
}
interface Job extends RedemptionJobBody {
  state: string;
}
export interface ConsumerInput {
  db: D1Database;
  config: AppConfig;
  provider: WhiteoutProvider;
  now: () => Date;
  token?: () => string;
}
const due = `(r.dispatch_hold_token IS NULL AND ((r.status='pending' AND (r.last_attempt_id IS NULL OR r.last_attempt_id<>?1 OR r.last_attempt_budget_generation=r.budget_generation)) OR (r.status='retry_wait' AND r.current_attempt_id=?1 AND r.current_invocation_token IS NULL AND r.retry_due_at<=?2)
  OR (r.status='in_progress' AND r.current_attempt_id=?1 AND r.invocation_expires_at<?2)))`;
const expiredHold = `(r.dispatch_hold_token IS NOT NULL AND r.status IN ('pending','in_progress','retry_wait')
  AND (r.invocation_expires_at IS NULL OR r.invocation_expires_at<?2))`;
const observationTime = `CASE WHEN last_observation_at IS NOT NULL AND last_observation_at>=?2
  THEN strftime('%Y-%m-%dT%H:%M:%fZ',last_observation_at,'+0.001 seconds') ELSE ?2 END`;

export function insertObservation(
  db: D1Database,
  pid: string,
  code: string,
  cause: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO terminal_observations(player_id,code,budget_generation,status,reason_code,attempt_state,cause,observed_at)
    SELECT player_id,code,budget_generation,status,reason_code,attempt_state,CASE WHEN reason_code='outcome_uncertain' THEN 'uncertain_dispatch' ELSE ?3 END,last_observation_at FROM redemptions
    WHERE player_id=?1 AND code=?2 AND current_terminal_generation=budget_generation AND changes()>0
    ON CONFLICT DO NOTHING`,
    )
    .bind(pid, code, cause);
}

async function validJob(
  db: D1Database,
  body: unknown,
  route: "registration" | "distribution",
): Promise<Job | null> {
  if (
    !isRedemptionJobBody(body) ||
    Object.values(body).some((v) => !v.length) ||
    !/^\d{1,32}$/.test(body.player_id) ||
    new TextEncoder().encode(JSON.stringify(body)).length > 96_000
  )
    return null;
  const row = await db
    .prepare(
      `SELECT p.state FROM outbox_jobs b JOIN operation_items i ON i.operation_id=b.operation_id AND i.item_key=b.item_key
    JOIN players p ON p.player_id=i.player_id JOIN operations o ON o.operation_id=i.operation_id
    WHERE b.job_id=?1 AND b.attempt_id=?2 AND b.type=?3 AND i.operation_id=?4 AND i.item_key=?5 AND i.player_id=?6 AND i.code=?7
      AND i.job_id=b.job_id AND (o.type<>'repair_run' OR o.repair_authorized_at IS NOT NULL)`,
    )
    .bind(
      body.job_id,
      body.attempt_id,
      route,
      body.operation_id,
      body.item_key,
      body.player_id,
      body.code,
    )
    .first<{ state: string }>();
  if (!row) return null;
  const expectedItem = route === "registration" ? body.code : body.player_id;
  if (
    body.item_key !== expectedItem ||
    body.job_id !== `${route}:${body.operation_id}:${expectedItem}`
  )
    return null;
  return { ...body, state: row.state };
}

export async function closeExpiredOrExhausted(
  db: D1Database,
  job: RedemptionJobBody,
  now: string,
  recovery = false,
  route?: "registration" | "distribution",
): Promise<void> {
  const eligibility = recovery
    ? `(${due} OR (r.dispatch_hold_token IS NULL AND r.current_attempt_id=?1 AND r.status IN ('in_progress','retry_wait') AND (r.invocation_expires_at IS NULL OR r.invocation_expires_at<?2)))`
    : due;
  const outboxAuthority = route
    ? `AND EXISTS(SELECT 1 FROM outbox_jobs b WHERE b.job_id=?5 AND b.attempt_id=?1
      AND b.operation_id=?6 AND b.item_key=?7 AND b.type=?8)`
    : "";
  await db.batch([
    db
      .prepare(
        `UPDATE redemptions AS r SET status=CASE WHEN dispatch_hold_token IS NOT NULL THEN 'permanent_failure' ELSE 'retry_exhausted' END,
      reason_code=CASE WHEN dispatch_hold_token IS NOT NULL THEN 'outcome_uncertain' ELSE 'provider_retry_exhausted' END,
      current_attempt_id=NULL,current_invocation_token=NULL,invocation_expires_at=NULL,retry_due_at=NULL,
      current_terminal_generation=budget_generation,last_observation_at=${observationTime},terminal_at=?2,updated_at=?2
      WHERE player_id=?3 AND code=?4 AND ((provider_invocations>=provider_invocation_limit AND ${eligibility})
        OR (${expiredHold} AND ${recovery ? "true" : "r.current_attempt_id=?1"}))
      ${outboxAuthority}`,
      )
      .bind(
        job.attempt_id,
        now,
        job.player_id,
        job.code,
        ...(route ? [job.job_id, job.operation_id, job.item_key, route] : []),
      ),
    insertObservation(db, job.player_id, job.code, "logical_budget_exhausted"),
  ]);
}

export async function consume(
  message: Delivery,
  route: "registration" | "distribution",
  input: ConsumerInput,
): Promise<void> {
  const db = budgetDatabase(input.db, 16);
  const { config } = input;
  try {
    // Keep the checked implementation identical to the one invoked after the D1 await.
    const provider = input.provider;
    const redeem = provider.redeem;
    const safeMock = isReplaySafeMock(provider, redeem);
    const job = await validJob(db, message.body, route);
    if (!job) {
      message.ack();
      return;
    }
    const now = input.now().toISOString();
    const token = (input.token ?? (() => crypto.randomUUID()))();
    const exp = new Date(Date.parse(now) + config.redemptionLeaseSeconds * 1000).toISOString();
    const currentOutbox = `EXISTS(SELECT 1 FROM outbox_jobs b WHERE b.job_id=?8 AND b.attempt_id=?1
      AND b.operation_id=?5 AND b.item_key=?6 AND b.type=?9)`;
    const eligibleItem = `EXISTS(SELECT 1 FROM operation_items i JOIN operations o ON o.operation_id=i.operation_id
      WHERE i.operation_id=?5 AND i.item_key=?6 AND ${mutableOperation} AND o.deadline_at>?2
      AND i.job_id=?8 AND ${currentOutbox}
      AND (i.status='pending' OR (i.status='in_progress' AND (i.claim_token=?1 OR i.claim_expires_at<?2))))`;
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO redemptions(player_id,code,idempotency_key,status,provider_invocation_limit,updated_at)
        SELECT ?3,?4,'redeem:v1:'||?3||':'||?4,'pending',?7,?2 WHERE ${eligibleItem}
        ON CONFLICT(player_id,code) DO NOTHING`,
        )
        .bind(
          job.attempt_id,
          now,
          job.player_id,
          job.code,
          job.operation_id,
          job.item_key,
          config.providerMaxInvocations,
          job.job_id,
          route,
        ),
      db
        .prepare(
          `UPDATE operation_items AS i SET status='in_progress',claim_token=?1,claim_expires_at=?7,updated_at=?2
        WHERE i.operation_id=?5 AND i.item_key=?6 AND ${eligibleItem}
        AND EXISTS(SELECT 1 FROM redemptions r WHERE r.player_id=?3 AND r.code=?4 AND ${due} AND r.provider_invocations<r.provider_invocation_limit)`,
        )
        .bind(
          job.attempt_id,
          now,
          job.player_id,
          job.code,
          job.operation_id,
          job.item_key,
          new Date(Date.parse(now) + config.itemLeaseSeconds * 1000).toISOString(),
          job.job_id,
          route,
        ),
      db
        .prepare(
          `UPDATE redemptions AS r SET status='in_progress',current_invocation_token=?7,invocation_expires_at=?10,
        dispatch_hold_token=CASE WHEN ?11=1 THEN NULL ELSE ?7 END,
        dispatch_hold_generation=CASE WHEN ?11=1 THEN NULL ELSE budget_generation END,
        dispatch_hold_at=CASE WHEN ?11=1 THEN NULL ELSE ?2 END,
        retry_due_at=NULL,attempt_state=(SELECT state FROM players WHERE player_id=?3),provider_invocations=provider_invocations+1,
        attempts=CASE WHEN current_attempt_id=?1 THEN attempts+1 ELSE 1 END,
        attempt_generation=attempt_generation+CASE WHEN current_attempt_id=?1 THEN 0 ELSE 1 END,
        current_attempt_id=?1,last_attempt_id=?1,last_attempt_budget_generation=budget_generation,first_claimed_at=COALESCE(first_claimed_at,?2),updated_at=?2
        WHERE player_id=?3 AND code=?4 AND ${due} AND provider_invocations<provider_invocation_limit AND ${eligibleItem}
        RETURNING attempt_state,provider_invocations,provider_invocation_limit,budget_generation`,
        )
        .bind(
          job.attempt_id,
          now,
          job.player_id,
          job.code,
          job.operation_id,
          job.item_key,
          token,
          job.job_id,
          route,
          exp,
          safeMock ? 1 : 0,
        ),
    ]);
    const claim = results[2]!.results[0] as
      | {
          attempt_state: string;
          provider_invocations: number;
          provider_invocation_limit: number;
          budget_generation: number;
        }
      | undefined;
    if (!claim) {
      // T3 is write-free. Expired holds and exhausted safe budgets close without a call.
      const exhausted = await db
        .prepare(
          `SELECT 1 FROM redemptions r WHERE player_id=?3 AND code=?4 AND ((${due} AND provider_invocations>=provider_invocation_limit)
          OR (${expiredHold} AND r.current_attempt_id=?1))
          AND EXISTS(SELECT 1 FROM outbox_jobs b WHERE b.job_id=?5 AND b.attempt_id=?1
            AND b.operation_id=?6 AND b.item_key=?7 AND b.type=?8)`,
        )
        .bind(
          job.attempt_id,
          now,
          job.player_id,
          job.code,
          job.job_id,
          job.operation_id,
          job.item_key,
          route,
        )
        .first();
      if (exhausted) await closeExpiredOrExhausted(db, job, now, false, route);
      message.ack();
      return;
    }
    let outcome: RedeemResult;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      outcome = await Promise.race([
        redeem.call(
          provider,
          { playerId: job.player_id, state: claim.attempt_state },
          job.code,
          `redeem:v1:${job.player_id}:${job.code}`,
        ),
        new Promise<RedeemResult>((resolve) => {
          timeout = setTimeout(
            () => resolve({ outcome: "uncertain", reasonCode: "outcome_uncertain" }),
            config.providerTimeoutSeconds * 1000,
          );
        }),
      ]);
    } catch {
      outcome = { outcome: "uncertain", reasonCode: "outcome_uncertain" };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const stamp = input.now().toISOString();
    const backoff = Math.min(60 * 2 ** (claim.provider_invocations - 1), 3600);
    if (
      outcome.outcome === "retryable" &&
      claim.provider_invocations < claim.provider_invocation_limit
    ) {
      const changed = await db
        .prepare(
          `UPDATE redemptions SET status='retry_wait',current_invocation_token=NULL,retry_due_at=?1,
        dispatch_hold_token=NULL,dispatch_hold_generation=NULL,dispatch_hold_at=NULL,
        invocation_expires_at=?2,updated_at=?3 WHERE player_id=?4 AND code=?5 AND status='in_progress' AND current_attempt_id=?6 AND current_invocation_token=?7 AND budget_generation=?8`,
        )
        .bind(
          new Date(Date.parse(stamp) + backoff * 1000).toISOString(),
          new Date(
            Date.parse(stamp) + (backoff + config.redemptionLeaseSeconds) * 1000,
          ).toISOString(),
          stamp,
          job.player_id,
          job.code,
          job.attempt_id,
          token,
          claim.budget_generation,
        )
        .run();
      if (changed.meta.changes) message.retry({ delaySeconds: backoff });
      else message.ack();
      return;
    }
    const reason =
      outcome.outcome === "uncertain"
        ? "outcome_uncertain"
        : outcome.outcome === "retryable"
          ? "provider_retry_exhausted"
          : outcome.outcome === "permanent"
            ? [
                "player_ineligible",
                "code_invalid",
                "code_expired",
                "provider_bad_request",
                "provider_auth_failed",
              ].includes(outcome.reasonCode)
              ? outcome.reasonCode
              : "provider_bad_request"
            : null;
    const status =
      outcome.outcome === "uncertain"
        ? "permanent_failure"
        : outcome.outcome === "retryable"
          ? "retry_exhausted"
          : outcome.outcome === "permanent"
            ? "permanent_failure"
            : outcome.outcome;
    const mismatch = `(?8='player_ineligible' AND attempt_state<>(SELECT state FROM players WHERE player_id=?3))`;
    const reopen = `(${mismatch} AND reeval_count<?9)`;
    const terminalResult = await db.batch([
      db
        .prepare(
          `UPDATE redemptions SET status=CASE WHEN ${reopen} THEN 'pending' ELSE ?7 END,
        reason_code=CASE WHEN ${reopen} THEN NULL WHEN ${mismatch} THEN 'state_reevaluation_limit' ELSE ?8 END,
        current_terminal_generation=CASE WHEN ${reopen} THEN NULL ELSE budget_generation END,
        last_observation_at=CASE WHEN ${reopen} THEN last_observation_at ELSE ${observationTime} END,
        terminal_at=CASE WHEN ${reopen} THEN NULL ELSE ?2 END,
        budget_generation=budget_generation+CASE WHEN ${reopen} THEN 1 ELSE 0 END,
        provider_invocations=CASE WHEN ${reopen} THEN 0 ELSE provider_invocations END,
        provider_invocation_limit=CASE WHEN ${reopen} THEN ?11 ELSE provider_invocation_limit END,
        attempts=CASE WHEN ${reopen} THEN 0 ELSE attempts END,
        attempt_generation=attempt_generation+CASE WHEN ${reopen} THEN 1 ELSE 0 END,
        reeval_count=reeval_count+CASE WHEN ${reopen} THEN 1 ELSE 0 END,
        dispatch_hold_token=CASE WHEN ?8='outcome_uncertain' THEN ?5 ELSE NULL END,
        dispatch_hold_generation=CASE WHEN ?8='outcome_uncertain' THEN budget_generation ELSE NULL END,
        dispatch_hold_at=CASE WHEN ?8='outcome_uncertain' THEN COALESCE(dispatch_hold_at,?2) ELSE NULL END,
        provider_receipt=?10,current_attempt_id=NULL,current_invocation_token=NULL,invocation_expires_at=NULL,retry_due_at=NULL,updated_at=?2
        WHERE player_id=?3 AND code=?4 AND status='in_progress' AND current_attempt_id=?1 AND current_invocation_token=?5 AND ?6=?6 AND budget_generation=?12 RETURNING reason_code`,
        )
        .bind(
          job.attempt_id,
          stamp,
          job.player_id,
          job.code,
          token,
          job.operation_id,
          status,
          reason,
          config.redemptionMaxReeval,
          outcome.outcome === "success" || outcome.outcome === "already_redeemed"
            ? (outcome.providerReceipt ?? null)
            : null,
          config.providerMaxInvocations,
          claim.budget_generation,
        ),
      insertObservation(
        db,
        job.player_id,
        job.code,
        outcome.outcome === "retryable" ? "logical_budget_exhausted" : "provider",
      ),
      ...initiatingRecipientStatements(db, stamp, job.operation_id, job.item_key),
      freeze(db, stamp, job.operation_id),
    ]);
    const terminalReason = terminalResult[0]?.results[0] as
      { reason_code: string | null } | undefined;
    if (terminalReason?.reason_code === "state_reevaluation_limit")
      console.warn("redemption_state_reevaluation_limit");
    message.ack();
  } catch {
    message.retry({ delaySeconds: 60 });
  }
}

export async function consumeDlq(
  message: Delivery,
  input: Pick<ConsumerInput, "db" | "now">,
): Promise<void> {
  const db = budgetDatabase(input.db, 8);
  const body = message.body;
  if (!isRedemptionJobBody(body)) {
    message.ack();
    return;
  }
  try {
    const route = body.job_id.startsWith("registration:") ? "registration" : "distribution";
    if (!(await validJob(db, body, route))) {
      message.ack();
      return;
    }
    const now = input.now().toISOString();
    const result = await db.batch([
      db
        .prepare(
          `UPDATE redemptions SET status=CASE WHEN dispatch_hold_token IS NOT NULL THEN 'permanent_failure' ELSE 'retry_exhausted' END,
        reason_code=CASE WHEN dispatch_hold_token IS NOT NULL THEN 'outcome_uncertain' ELSE 'provider_retry_exhausted' END,
        current_terminal_generation=budget_generation,last_observation_at=${observationTime},terminal_at=?2,updated_at=?2,
        current_attempt_id=NULL,current_invocation_token=NULL,invocation_expires_at=NULL,retry_due_at=NULL
        WHERE player_id=?3 AND code=?4 AND current_attempt_id=?1 AND
        ((status='retry_wait' AND current_invocation_token IS NULL) OR (status='in_progress' AND (current_invocation_token IS NULL OR invocation_expires_at<?2)))`,
        )
        .bind(body.attempt_id, now, body.player_id, body.code),
      insertObservation(db, body.player_id, body.code, "platform_dlq"),
    ]);
    if (!result[0]!.meta.changes) {
      const classification = await db
        .prepare(
          `SELECT CASE WHEN current_attempt_id=?1 AND status='in_progress' AND current_invocation_token IS NOT NULL AND invocation_expires_at>=?2 THEN 'dlq_invocation_active' ELSE 'dlq_stale_attempt' END AS classification FROM redemptions WHERE player_id=?3 AND code=?4`,
        )
        .bind(body.attempt_id, now, body.player_id, body.code)
        .first<string>("classification");
      console.info(classification ?? "dlq_stale_attempt");
      message.ack();
      return;
    }
    const page = await recipients(db, "i.player_id=?1 AND i.code=?2", [body.player_id, body.code]);
    await applyRecipients(db, now, page);
    message.ack();
  } catch {
    message.retry({ delaySeconds: 60 });
  }
}

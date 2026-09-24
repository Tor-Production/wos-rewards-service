import type { AppConfig } from "../config";
import { deterministicUuid } from "../ingest/identity";
import { COMMUNITY_JSON_SOURCE, fetchCommunityJson } from "./community-json";
import { logCommunityFetchOutcome } from "../runtime/scheduled-lane-log";

const CLAIM_SECONDS = 60;
const POLL_SECONDS = 1_800;
const owned = `EXISTS(SELECT 1 FROM community_json_source_state s
  WHERE s.source_id='${COMMUNITY_JSON_SOURCE}' AND s.claim_token=?1 AND s.claim_expires_at>?2
    AND s.pending_snapshot_json IS NOT NULL)`;
const independentlyEligible = `EXISTS(SELECT 1 FROM discovered_code_events d
    WHERE d.code=?3 AND d.status IN ('accepted','duplicate_code'))
  OR EXISTS(SELECT 1 FROM manual_code_commands m
    WHERE m.code=?3 AND m.status IN ('accepted','duplicate_code'))`;

interface SourceState {
  initialized: number;
  stopped: number;
  etag: string | null;
  last_source_updated_at: string | null;
  next_fetch_at: string;
  pending_snapshot_json: string | null;
  claim_expires_at: string | null;
}
interface Change {
  code: string;
  status: "active" | "inactive" | "expired" | "removed";
  source_updated_at: string | null;
  source_first_seen_at: string | null;
  seen_before: number;
}

/** One bounded source action per Cron tick. Disabled config touches neither D1 nor network. */
export async function runCommunityJsonSource(
  db: D1Database,
  config: AppConfig,
  now: Date,
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => now,
): Promise<void> {
  if (!config.communityJsonSource) return;
  const stamp = now.toISOString();
  await db
    .prepare(
      `INSERT INTO community_json_source_state(source_id,next_fetch_at,updated_at)
    VALUES (?1,?2,?2) ON CONFLICT(source_id) DO NOTHING`,
    )
    .bind(COMMUNITY_JSON_SOURCE, stamp)
    .run();
  const state = await db
    .prepare(
      `SELECT initialized,stopped,etag,last_source_updated_at,next_fetch_at,pending_snapshot_json,
      claim_expires_at FROM community_json_source_state WHERE source_id=?1`,
    )
    .bind(COMMUNITY_JSON_SOURCE)
    .first<SourceState>();
  if (!state || state.stopped) return;
  if (state.pending_snapshot_json !== null) {
    await reconcileOne(db, config, stamp, clock);
    return;
  }
  if (state.next_fetch_at > stamp || (state.claim_expires_at && state.claim_expires_at >= stamp))
    return;

  const token = crypto.randomUUID();
  const deadline = new Date(now.getTime() + POLL_SECONDS * 1_000).toISOString();
  const lease = new Date(now.getTime() + CLAIM_SECONDS * 1_000).toISOString();
  // Reserve the request slot before I/O. Losing a response cannot shorten the poll interval.
  const claim = await db
    .prepare(
      `UPDATE community_json_source_state SET claim_token=?1,
      claim_expires_at=?2,next_fetch_at=?3,updated_at=?4 WHERE source_id=?5 AND stopped=0
      AND pending_snapshot_json IS NULL AND next_fetch_at<=?4
      AND (claim_expires_at IS NULL OR claim_expires_at<?4)`,
    )
    .bind(token, lease, deadline, stamp, COMMUNITY_JSON_SOURCE)
    .run();
  if (!claim.meta.changes) return;

  const result = await fetchCommunityJson(config.communityJsonSource, state.etag, fetcher, clock());
  const finish = clock().toISOString();
  const stale =
    result.kind === "ok" &&
    state.last_source_updated_at !== null &&
    Date.parse(result.sourceUpdatedAt) < Date.parse(state.last_source_updated_at);
  logCommunityFetchOutcome(
    stale
      ? "stale_snapshot"
      : result.kind === "transient_failure" || result.kind === "invalid_payload"
        ? result.reason
        : result.kind,
    config.environment,
  );
  if (result.kind === "ok" && !stale) {
    if (state.initialized === 0) {
      // One SQL statement handles any baseline permitted by the response byte bound.
      await db.batch([
        db
          .prepare(
            `INSERT INTO community_json_code_observations
          (source_id,code,first_source_updated_at,first_source_seen_at,first_observed_at,
           baseline,source_active,withdrawn_at,operation_id)
          SELECT ?3,json_extract(j.value,'$.code'),json_extract(j.value,'$.sourceUpdatedAt'),
            json_extract(j.value,'$.sourceFirstSeenAt'),?2,1,
            CASE WHEN json_extract(j.value,'$.sourceStatus')='active' THEN 1 ELSE 0 END,NULL,NULL
          FROM json_each(?4) j WHERE EXISTS(SELECT 1 FROM community_json_source_state
            WHERE source_id=?3 AND claim_token=?1 AND claim_expires_at>?2 AND initialized=0)
          ON CONFLICT(source_id,code) DO NOTHING`,
          )
          .bind(token, finish, COMMUNITY_JSON_SOURCE, JSON.stringify(result.candidates)),
        db
          .prepare(
            `UPDATE community_json_source_state SET initialized=1,etag=?3,
          last_source_updated_at=?5,
          last_success_at=?2,claim_token=NULL,claim_expires_at=NULL,updated_at=?2
          WHERE source_id=?4 AND claim_token=?1 AND claim_expires_at>?2 AND initialized=0`,
          )
          .bind(token, finish, result.etag, COMMUNITY_JSON_SOURCE, result.sourceUpdatedAt),
      ]);
    } else {
      await db
        .prepare(
          `UPDATE community_json_source_state SET pending_snapshot_json=?3,
        pending_etag=?4,pending_source_updated_at=?6,
        claim_token=NULL,claim_expires_at=NULL,updated_at=?2
        WHERE source_id=?5 AND claim_token=?1 AND claim_expires_at>?2`,
        )
        .bind(
          token,
          finish,
          JSON.stringify(result.candidates),
          result.etag,
          COMMUNITY_JSON_SOURCE,
          result.sourceUpdatedAt,
        )
        .run();
    }
    return;
  }
  const retrySeconds = result.kind === "rate_limited" ? result.retryAfterSeconds : null;
  const retryMillis =
    retrySeconds === null ? null : now.getTime() + Math.max(POLL_SECONDS, retrySeconds) * 1_000;
  // An unrepresentable Retry-After is not permission to poll sooner.
  const unrepresentableRetry =
    retryMillis !== null && !Number.isFinite(new Date(retryMillis).getTime());
  const retryAt =
    retryMillis === null || unrepresentableRetry ? deadline : new Date(retryMillis).toISOString();
  await db
    .prepare(
      `UPDATE community_json_source_state SET
    stopped=CASE WHEN ?3=1 THEN 1 ELSE stopped END,
    next_fetch_at=CASE WHEN next_fetch_at>?4 THEN next_fetch_at ELSE ?4 END,
    claim_token=NULL,claim_expires_at=NULL,updated_at=?2
    WHERE source_id=?5 AND claim_token=?1 AND claim_expires_at>?2`,
    )
    .bind(
      token,
      finish,
      result.kind === "access_denied" || unrepresentableRetry ? 1 : 0,
      retryAt,
      COMMUNITY_JSON_SOURCE,
    )
    .run();
}

async function reconcileOne(
  db: D1Database,
  config: AppConfig,
  stamp: string,
  clock: () => Date,
): Promise<void> {
  const token = crypto.randomUUID();
  const lease = new Date(Date.parse(stamp) + CLAIM_SECONDS * 1_000).toISOString();
  const claim = await db
    .prepare(
      `UPDATE community_json_source_state SET claim_token=?1,
    claim_expires_at=?2,updated_at=?3 WHERE source_id=?4 AND pending_snapshot_json IS NOT NULL
    AND (claim_expires_at IS NULL OR claim_expires_at<?3)`,
    )
    .bind(token, lease, stamp, COMMUNITY_JSON_SOURCE)
    .run();
  if (!claim.meta.changes) return;
  const change = await db
    .prepare(
      `WITH feed AS (
      SELECT json_extract(j.value,'$.code') code,
        json_extract(j.value,'$.sourceStatus') status,
        json_extract(j.value,'$.sourceUpdatedAt') source_updated_at,
        json_extract(j.value,'$.sourceFirstSeenAt') source_first_seen_at
      FROM community_json_source_state s,json_each(s.pending_snapshot_json) j
      WHERE s.source_id=?1 AND s.claim_token=?2),
    changes AS (
      SELECT f.code,f.status,f.source_updated_at,f.source_first_seen_at,
        CASE WHEN o.code IS NULL THEN 0 ELSE 1 END seen_before
      FROM feed f LEFT JOIN community_json_code_observations o
        ON o.source_id=?1 AND o.code=f.code
      WHERE o.code IS NULL OR o.source_active<>(f.status='active')
      UNION ALL
      SELECT o.code,'removed',NULL,NULL,1 FROM community_json_code_observations o
      WHERE o.source_id=?1 AND o.source_active=1
        AND NOT EXISTS(SELECT 1 FROM feed f WHERE f.code=o.code))
    SELECT * FROM changes ORDER BY code LIMIT 1`,
    )
    .bind(COMMUNITY_JSON_SOURCE, token)
    .first<Change>();
  const finish = clock().toISOString();
  if (!change) {
    await db
      .prepare(
        `UPDATE community_json_source_state SET etag=pending_etag,
      last_source_updated_at=pending_source_updated_at,
      pending_etag=NULL,pending_source_updated_at=NULL,pending_snapshot_json=NULL,last_success_at=?2,
      claim_token=NULL,claim_expires_at=NULL,updated_at=?2
      WHERE source_id=?3 AND claim_token=?1 AND claim_expires_at>?2`,
      )
      .bind(token, finish, COMMUNITY_JSON_SOURCE)
      .run();
    return;
  }
  if (!change.seen_before) await acceptNew(db, config, token, clock, change);
  else if (change.status === "active") {
    await db.batch([
      db
        .prepare(
          `UPDATE community_json_code_observations SET source_active=1,withdrawn_at=NULL
        WHERE source_id=?4 AND code=?3 AND source_active=0 AND ${owned}`,
        )
        .bind(token, finish, change.code, COMMUNITY_JSON_SOURCE),
      db
        .prepare(
          `UPDATE gift_codes SET status='active' WHERE code=?3
        AND source='${COMMUNITY_JSON_SOURCE}' AND status='disabled' AND ${owned}`,
        )
        .bind(token, finish, change.code),
      release(db, token, finish),
    ]);
  } else await withdraw(db, token, finish, change.code);
}

function release(db: D1Database, token: string, stamp: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE community_json_source_state SET claim_token=NULL,
    claim_expires_at=NULL,updated_at=?2 WHERE source_id=?3 AND claim_token=?1
    AND claim_expires_at>?2`,
    )
    .bind(token, stamp, COMMUNITY_JSON_SOURCE);
}

async function acceptNew(
  db: D1Database,
  config: AppConfig,
  token: string,
  clock: () => Date,
  change: Change,
): Promise<void> {
  const stamp = clock().toISOString();
  const active = change.status === "active";
  const marker = `community-json:${change.code}`;
  const operationId = await deterministicUuid(`distribution:${change.code}`);
  const deadline = new Date(
    Date.parse(stamp) + config.operationDeadlineSeconds * 1_000,
  ).toISOString();
  const context = JSON.stringify({
    version: 1,
    code: change.code,
    channelId: config.discordMvpAdminChannelId,
    maxLength: config.discordMessageMaxLength,
    maxChunks: config.summaryMaxChunks,
  });
  // A deterministic operation ID may already belong to Follow or manual intake.
  // Only this acceptance's community-owned operation may receive a player snapshot/reference.
  const acceptedOperation = `EXISTS(SELECT 1 FROM operations o
    JOIN gift_codes g ON g.code=o.trigger_ref
    WHERE o.operation_id=?4 AND o.trigger_ref=?3 AND o.snapshot_at=?2
      AND g.source='${COMMUNITY_JSON_SOURCE}' AND g.first_seen_event_id=?5
      AND EXISTS(SELECT 1 FROM community_json_code_observations c
        WHERE c.source_id='${COMMUNITY_JSON_SOURCE}' AND c.code=?3 AND c.acceptance_id=?1))`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO community_json_code_observations
      (source_id,code,first_source_updated_at,first_source_seen_at,first_observed_at,
       baseline,source_active,withdrawn_at,operation_id,acceptance_id)
      SELECT ?4,?3,?5,?6,?2,0,?7,NULL,NULL,?1 WHERE ${owned}
      ON CONFLICT(source_id,code) DO NOTHING`,
      )
      .bind(
        token,
        stamp,
        change.code,
        COMMUNITY_JSON_SOURCE,
        change.source_updated_at,
        change.source_first_seen_at,
        active ? 1 : 0,
      ),
  ];
  if (active)
    statements.push(
      db
        .prepare(
          `INSERT INTO gift_codes(code,status,discovered_at,source,first_seen_event_id)
      SELECT ?3,'active',?2,'${COMMUNITY_JSON_SOURCE}',?4
      WHERE ${owned} AND EXISTS(SELECT 1 FROM community_json_code_observations
        WHERE source_id='${COMMUNITY_JSON_SOURCE}' AND code=?3 AND acceptance_id=?1)
      ON CONFLICT(code) DO NOTHING`,
        )
        .bind(token, stamp, change.code, marker),
      db
        .prepare(
          `INSERT INTO operations
      (operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,deadline_at,
       created_at,updated_at,summary_context)
      SELECT ?4,'code_distribution_run','discovered_code',?3,?2,
        CASE WHEN p.n<=2000 THEN p.n ELSE -1 END,?5,?2,?2,?6
      FROM (SELECT COUNT(*) AS n FROM players) p WHERE ${owned}
      AND EXISTS(SELECT 1 FROM gift_codes
        WHERE code=?3 AND source='${COMMUNITY_JSON_SOURCE}' AND first_seen_event_id=?7)
      AND EXISTS(SELECT 1 FROM community_json_code_observations
        WHERE source_id='${COMMUNITY_JSON_SOURCE}' AND code=?3 AND acceptance_id=?1)`,
        )
        .bind(token, stamp, change.code, operationId, deadline, context, marker),
      db
        .prepare(
          `INSERT INTO operation_players_snapshot(operation_id,player_id,display_name)
      SELECT ?4,p.player_id,p.display_name FROM players p WHERE ${owned}
      AND ${acceptedOperation}
      ORDER BY p.player_id`,
        )
        .bind(token, stamp, change.code, operationId, marker),
      db
        .prepare(
          `UPDATE community_json_code_observations SET operation_id=?4
      WHERE source_id='${COMMUNITY_JSON_SOURCE}' AND code=?3 AND acceptance_id=?1
      AND ${owned} AND ${acceptedOperation}`,
        )
        .bind(token, stamp, change.code, operationId, marker),
    );
  statements.push(release(db, token, stamp));
  await db.batch(statements);
}

async function withdraw(db: D1Database, token: string, stamp: string, code: string): Promise<void> {
  const disabled = `EXISTS(SELECT 1 FROM gift_codes g WHERE g.code=?3
    AND g.source='${COMMUNITY_JSON_SOURCE}' AND g.status='disabled')`;
  await db.batch([
    db
      .prepare(
        `UPDATE community_json_code_observations SET source_active=0,
      withdrawn_at=COALESCE(withdrawn_at,?2) WHERE source_id='${COMMUNITY_JSON_SOURCE}'
      AND code=?3 AND source_active=1 AND ${owned}`,
      )
      .bind(token, stamp, code),
    db
      .prepare(
        `UPDATE gift_codes SET status='disabled' WHERE code=?3
      AND source='${COMMUNITY_JSON_SOURCE}' AND status='active' AND ${owned}
      AND NOT (${independentlyEligible})`,
      )
      .bind(token, stamp, code),
    db
      .prepare(
        `UPDATE operations AS o SET expansion_state='expanded',
      expected_count=(SELECT COUNT(*) FROM operation_items i WHERE i.operation_id=o.operation_id),
      updated_at=?2 WHERE o.type='code_distribution_run' AND o.trigger_ref=?3
      AND o.expansion_state<>'expanded' AND o.summary_state='none'
      AND o.state NOT IN ('summarized','stale_closed')
      AND ${disabled} AND ${owned}`,
      )
      .bind(token, stamp, code),
    db
      .prepare(
        `UPDATE operation_items SET status='permanent_failure',
      reason_code='source_withdrawn',claim_token=NULL,claim_expires_at=NULL,updated_at=?2
      WHERE code=?3 AND status='pending' AND ${disabled} AND ${owned}
      AND EXISTS(SELECT 1 FROM operations o WHERE o.operation_id=operation_items.operation_id
        AND o.summary_state='none' AND o.state NOT IN ('summarized','stale_closed'))`,
      )
      .bind(token, stamp, code),
    db
      .prepare(
        `UPDATE outbox_jobs SET status='dead',last_error='source_withdrawn',updated_at=?2
      WHERE job_id IN (SELECT i.job_id FROM operation_items i WHERE i.code=?3
        AND i.status='permanent_failure' AND i.reason_code='source_withdrawn')
      AND status IN ('pending','enqueued') AND ${disabled} AND ${owned}`,
      )
      .bind(token, stamp, code),
    release(db, token, stamp),
  ]);
}

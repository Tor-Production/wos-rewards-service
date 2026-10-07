import type { AppConfig } from "../config";
import { deterministicUuid } from "../ingest/identity";
import type { RssFetchResult } from "./rss";
import { RSS_SOURCE, fetchRss } from "./rss";
import { logRssFetchOutcome } from "../runtime/scheduled-lane-log";

const CLAIM_SECONDS = 60;
const ownedSnapshot = `EXISTS(SELECT 1 FROM rss_source_state s
  WHERE s.source_id='${RSS_SOURCE}' AND s.claim_token=?1 AND s.claim_expires_at>?2
    AND s.pending_snapshot_json IS NOT NULL)`;

interface SourceState {
  initialized: number;
  stopped: number;
  next_fetch_at: string;
  pending_snapshot_json: string | null;
  claim_expires_at: string | null;
}

interface CandidateRow {
  item_id: string;
  code: string;
  source_published_at: string;
}

/** One bounded RSS action per Cron tick. Disabled config touches neither D1 nor network. */
export async function runRssSource(
  db: D1Database,
  config: AppConfig,
  now: Date,
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => now,
): Promise<void> {
  const source = config.rssSource;
  if (!source) return;
  const stamp = now.toISOString();
  await db
    .prepare(
      `INSERT INTO rss_source_state(source_id,next_fetch_at,updated_at)
       VALUES (?1,?2,?2) ON CONFLICT(source_id) DO NOTHING`,
    )
    .bind(RSS_SOURCE, stamp)
    .run();
  const state = await db
    .prepare(
      `SELECT initialized,stopped,next_fetch_at,pending_snapshot_json,claim_expires_at
       FROM rss_source_state WHERE source_id=?1`,
    )
    .bind(RSS_SOURCE)
    .first<SourceState>();
  if (!state || state.stopped) return;
  if (state.pending_snapshot_json !== null) {
    await reconcileOne(db, config, stamp, clock, state.initialized === 1);
    return;
  }
  if (state.next_fetch_at > stamp || (state.claim_expires_at && state.claim_expires_at >= stamp))
    return;

  const token = crypto.randomUUID();
  const minPollSeconds = source.minPollSeconds;
  const deadline = new Date(now.getTime() + minPollSeconds * 1_000).toISOString();
  const lease = new Date(now.getTime() + CLAIM_SECONDS * 1_000).toISOString();
  // Reserve the durable slot before I/O. A lost response never shortens the poll interval.
  const claim = await db
    .prepare(
      `UPDATE rss_source_state SET claim_token=?1,claim_expires_at=?2,next_fetch_at=?3,updated_at=?4
       WHERE source_id=?5 AND stopped=0 AND pending_snapshot_json IS NULL AND next_fetch_at<=?4
         AND (claim_expires_at IS NULL OR claim_expires_at<?4)`,
    )
    .bind(token, lease, deadline, stamp, RSS_SOURCE)
    .run();
  if (!claim.meta.changes) return;

  const result = await fetchRss(source, fetcher, now);
  logRssFetchOutcome(outcome(result), config.environment);
  const retryMillis =
    result.retryAfterSeconds === null
      ? null
      : now.getTime() + Math.max(minPollSeconds, result.retryAfterSeconds) * 1_000;
  let nextFetchAt = deadline;
  let invalidRetryDate = false;
  if (retryMillis !== null) {
    const retryDate = new Date(retryMillis);
    if (!Number.isFinite(retryDate.getTime())) invalidRetryDate = true;
    else nextFetchAt = retryDate.toISOString();
  }
  const stopped = result.kind === "access_denied" || result.retryAfterInvalid || invalidRetryDate;
  if (result.kind === "ok" && !stopped) {
    await db
      .prepare(
        `UPDATE rss_source_state SET pending_snapshot_json=?3,
           next_fetch_at=CASE WHEN next_fetch_at>?4 THEN next_fetch_at ELSE ?4 END,
           claim_token=NULL,claim_expires_at=NULL,updated_at=?2
         WHERE source_id=?5 AND claim_token=?1 AND claim_expires_at>?2`,
      )
      .bind(
        token,
        clock().toISOString(),
        JSON.stringify(result.candidates),
        nextFetchAt,
        RSS_SOURCE,
      )
      .run();
    return;
  }
  await db
    .prepare(
      `UPDATE rss_source_state SET stopped=CASE WHEN ?3=1 THEN 1 ELSE stopped END,
         next_fetch_at=CASE WHEN next_fetch_at>?4 THEN next_fetch_at ELSE ?4 END,
         claim_token=NULL,claim_expires_at=NULL,updated_at=?2
       WHERE source_id=?5 AND claim_token=?1 AND claim_expires_at>?2`,
    )
    .bind(token, clock().toISOString(), stopped ? 1 : 0, nextFetchAt, RSS_SOURCE)
    .run();
}

async function reconcileOne(
  db: D1Database,
  config: AppConfig,
  stamp: string,
  clock: () => Date,
  initialized: boolean,
): Promise<void> {
  const token = crypto.randomUUID();
  const lease = new Date(Date.parse(stamp) + CLAIM_SECONDS * 1_000).toISOString();
  const claim = await db
    .prepare(
      `UPDATE rss_source_state SET claim_token=?1,claim_expires_at=?2,updated_at=?3
       WHERE source_id=?4 AND pending_snapshot_json IS NOT NULL
         AND (claim_expires_at IS NULL OR claim_expires_at<?3)`,
    )
    .bind(token, lease, stamp, RSS_SOURCE)
    .run();
  if (!claim.meta.changes) return;

  const change = await db
    .prepare(
      `SELECT json_extract(j.value,'$.itemId') item_id,
          json_extract(j.value,'$.code') code,
          json_extract(j.value,'$.sourcePublishedAt') source_published_at
       FROM rss_source_state s,json_each(s.pending_snapshot_json) j
       WHERE s.source_id=?1 AND s.claim_token=?2 AND s.claim_expires_at>?3
         AND s.pending_snapshot_json IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM rss_item_observations o
           WHERE o.source_id=?1 AND o.item_id=json_extract(j.value,'$.itemId')
             AND o.code=json_extract(j.value,'$.code'))
       ORDER BY CAST(j.key AS INTEGER) LIMIT 1`,
    )
    .bind(RSS_SOURCE, token, stamp)
    .first<CandidateRow>();
  const finish = clock().toISOString();
  if (!change) {
    await db
      .prepare(
        `UPDATE rss_source_state SET initialized=1,pending_snapshot_json=NULL,last_success_at=?2,
           claim_token=NULL,claim_expires_at=NULL,updated_at=?2
         WHERE source_id=?3 AND claim_token=?1 AND claim_expires_at>?2`,
      )
      .bind(token, finish, RSS_SOURCE)
      .run();
    return;
  }
  if (initialized) await acceptNew(db, config, token, clock, change);
  else await recordBaseline(db, token, finish, change);
}

async function recordBaseline(
  db: D1Database,
  token: string,
  stamp: string,
  change: CandidateRow,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO rss_item_observations
           (source_id,item_id,code,source_published_at,first_observed_at,baseline)
         SELECT ?3,?4,?5,?6,?2,1 WHERE ${ownedSnapshot}
         ON CONFLICT(source_id,item_id,code) DO NOTHING`,
      )
      .bind(token, stamp, RSS_SOURCE, change.item_id, change.code, change.source_published_at),
    db
      .prepare(
        `INSERT INTO rss_code_observations
           (source_id,code,first_item_id,source_published_at,first_observed_at,baseline,
            source_active,operation_id,acceptance_id)
         SELECT ?3,?4,?5,?6,?2,1,1,NULL,NULL WHERE ${ownedSnapshot}
           AND EXISTS (SELECT 1 FROM rss_item_observations
             WHERE source_id=?3 AND item_id=?5 AND code=?4)
         ON CONFLICT(source_id,code) DO NOTHING`,
      )
      .bind(token, stamp, RSS_SOURCE, change.code, change.item_id, change.source_published_at),
    release(db, token, stamp),
  ]);
}

async function acceptNew(
  db: D1Database,
  config: AppConfig,
  token: string,
  clock: () => Date,
  change: CandidateRow,
): Promise<void> {
  const stamp = clock().toISOString();
  const marker = `rss:${change.item_id}`;
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
  const acceptedOperation = `EXISTS(SELECT 1 FROM operations o
    JOIN gift_codes g ON g.code=o.trigger_ref
    WHERE o.operation_id=?4 AND o.trigger_ref=?3 AND o.snapshot_at=?2
      AND g.source='${RSS_SOURCE}' AND g.first_seen_event_id=?5
      AND EXISTS(SELECT 1 FROM rss_code_observations r
        WHERE r.source_id='${RSS_SOURCE}' AND r.code=?3 AND r.acceptance_id=?1))`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO rss_item_observations
           (source_id,item_id,code,source_published_at,first_observed_at,baseline)
         SELECT ?3,?4,?5,?6,?2,0 WHERE ${ownedSnapshot}
         ON CONFLICT(source_id,item_id,code) DO NOTHING`,
      )
      .bind(token, stamp, RSS_SOURCE, change.item_id, change.code, change.source_published_at),
    db
      .prepare(
        `INSERT INTO rss_code_observations
           (source_id,code,first_item_id,source_published_at,first_observed_at,baseline,
            source_active,operation_id,acceptance_id)
         SELECT ?3,?4,?5,?6,?2,0,1,NULL,?1 WHERE ${ownedSnapshot}
           AND EXISTS (SELECT 1 FROM rss_item_observations
             WHERE source_id=?3 AND item_id=?5 AND code=?4)
         ON CONFLICT(source_id,code) DO NOTHING`,
      )
      .bind(token, stamp, RSS_SOURCE, change.code, change.item_id, change.source_published_at),
    db
      .prepare(
        `INSERT INTO gift_codes(code,status,discovered_at,source,first_seen_event_id)
         SELECT ?3,'active',?2,'${RSS_SOURCE}',?4 WHERE ${ownedSnapshot}
           AND EXISTS (SELECT 1 FROM rss_code_observations
             WHERE source_id='${RSS_SOURCE}' AND code=?3 AND acceptance_id=?1)
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
         FROM (SELECT COUNT(*) n FROM players) p WHERE ${ownedSnapshot}
           AND EXISTS (SELECT 1 FROM gift_codes
             WHERE code=?3 AND source='${RSS_SOURCE}' AND first_seen_event_id=?7)
           AND EXISTS (SELECT 1 FROM rss_code_observations
             WHERE source_id='${RSS_SOURCE}' AND code=?3 AND acceptance_id=?1)`,
      )
      .bind(token, stamp, change.code, operationId, deadline, context, marker),
    db
      .prepare(
        `INSERT INTO operation_players_snapshot(operation_id,player_id,display_name)
         SELECT ?4,p.player_id,p.display_name FROM players p WHERE ${ownedSnapshot}
           AND ${acceptedOperation} ORDER BY p.player_id`,
      )
      .bind(token, stamp, change.code, operationId, marker),
    db
      .prepare(
        `UPDATE rss_code_observations SET operation_id=?4
         WHERE source_id='${RSS_SOURCE}' AND code=?3 AND acceptance_id=?1
           AND ${ownedSnapshot} AND ${acceptedOperation}`,
      )
      .bind(token, stamp, change.code, operationId, marker),
    release(db, token, stamp),
  ]);
}

function release(db: D1Database, token: string, stamp: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE rss_source_state SET claim_token=NULL,claim_expires_at=NULL,updated_at=?2
       WHERE source_id=?3 AND claim_token=?1 AND claim_expires_at>?2`,
    )
    .bind(token, stamp, RSS_SOURCE);
}

function outcome(
  result: RssFetchResult,
):
  | "ok"
  | "access_denied"
  | "rate_limited"
  | "http_5xx"
  | "http_other"
  | "timeout"
  | "transport_error"
  | "body_read_error"
  | "content_length_invalid"
  | "content_length_oversize"
  | "body_oversize"
  | "content_type_invalid"
  | "xml_invalid"
  | "schema_invalid"
  | "retry_after_invalid" {
  if (result.retryAfterInvalid) return "retry_after_invalid";
  if (result.kind === "ok" || result.kind === "access_denied" || result.kind === "rate_limited")
    return result.kind;
  return result.reason;
}

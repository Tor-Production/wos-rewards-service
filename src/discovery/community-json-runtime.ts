import type { AppConfig } from "../config";
import { openCommunityDistribution } from "../operations/distribution";
import {
  COMMUNITY_JSON_MIN_POLL_SECONDS,
  COMMUNITY_JSON_SOURCE,
  fetchCommunityJson,
  type CommunityCodeCandidate,
} from "./community-json";

const CLAIM_SECONDS = 60;

/** Disabled unless COMMUNITY_JSON_SOURCE_ENABLED is explicitly true; no route calls this. */
export async function runCommunityJsonSource(
  db: D1Database,
  config: AppConfig,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!config.communityJsonSource) return;
  const stamp = now.toISOString();
  const token = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO community_json_source_state(source_id,next_fetch_at,updated_at)
      VALUES (?1,?2,?2) ON CONFLICT(source_id) DO NOTHING`,
    )
    .bind(COMMUNITY_JSON_SOURCE, stamp)
    .run();
  await db
    .prepare(
      `UPDATE community_json_source_state SET claim_token=?2,claim_expires_at=?3,updated_at=?1
      WHERE source_id=?4 AND next_fetch_at<=?1 AND (claim_expires_at IS NULL OR claim_expires_at<?1)`,
    )
    .bind(
      stamp,
      token,
      new Date(now.getTime() + CLAIM_SECONDS * 1000).toISOString(),
      COMMUNITY_JSON_SOURCE,
    )
    .run();
  const state = await db
    .prepare(
      "SELECT initialized,etag FROM community_json_source_state WHERE source_id=?1 AND claim_token=?2",
    )
    .bind(COMMUNITY_JSON_SOURCE, token)
    .first<{ initialized: number; etag: string | null }>();
  if (!state) return;
  const result = await fetchCommunityJson(config.communityJsonSource, state.etag, fetcher);
  const delay =
    result.kind === "rate_limited" && result.retryAfterSeconds !== null
      ? Math.max(COMMUNITY_JSON_MIN_POLL_SECONDS, result.retryAfterSeconds)
      : COMMUNITY_JSON_MIN_POLL_SECONDS;
  const next = new Date(now.getTime() + delay * 1000).toISOString();
  if (result.kind !== "ok") {
    await db
      .prepare(
        "UPDATE community_json_source_state SET next_fetch_at=?1,claim_token=NULL,claim_expires_at=NULL,updated_at=?2 WHERE source_id=?3 AND claim_token=?4",
      )
      .bind(next, stamp, COMMUNITY_JSON_SOURCE, token)
      .run();
    return;
  }
  if (state.initialized === 0) {
    await db.batch([
      ...result.candidates.map((candidate) => observation(db, candidate, stamp, 1)),
      db
        .prepare(
          "UPDATE community_json_source_state SET initialized=1,etag=?1,next_fetch_at=?2,last_success_at=?3,claim_token=NULL,claim_expires_at=NULL,updated_at=?3 WHERE source_id=?4 AND claim_token=?5",
        )
        .bind(result.etag, next, stamp, COMMUNITY_JSON_SOURCE, token),
    ]);
    return;
  }
  const active = new Set(result.candidates.map((candidate) => candidate.code));
  const known = (
    await db
      .prepare(
        "SELECT code FROM community_json_code_observations WHERE source_id=?1 AND source_active=1",
      )
      .bind(COMMUNITY_JSON_SOURCE)
      .all<{ code: string }>()
  ).results;
  for (const row of known.filter((row) => !active.has(row.code)))
    await withdraw(db, row.code, stamp);
  for (const candidate of result.candidates.filter(
    (candidate) => candidate.sourceStatus === "active",
  ))
    await acceptCandidate(db, config, candidate, now, stamp);
  await db
    .prepare(
      "UPDATE community_json_source_state SET etag=?1,next_fetch_at=?2,last_success_at=?3,claim_token=NULL,claim_expires_at=NULL,updated_at=?3 WHERE source_id=?4 AND claim_token=?5",
    )
    .bind(result.etag, next, stamp, COMMUNITY_JSON_SOURCE, token)
    .run();
}

function observation(
  db: D1Database,
  candidate: CommunityCodeCandidate,
  stamp: string,
  baseline: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO community_json_code_observations(source_id,code,first_source_updated_at,first_source_seen_at,first_observed_at,baseline,source_active,withdrawn_at,operation_id)
    VALUES (?1,?2,?3,?4,?5,?6,1,NULL,NULL) ON CONFLICT(source_id,code) DO NOTHING`,
    )
    .bind(
      COMMUNITY_JSON_SOURCE,
      candidate.code,
      candidate.sourceUpdatedAt,
      candidate.sourceFirstSeenAt,
      stamp,
      baseline,
    );
}

async function acceptCandidate(
  db: D1Database,
  config: AppConfig,
  candidate: CommunityCodeCandidate,
  now: Date,
  stamp: string,
): Promise<void> {
  const existing = await db
    .prepare("SELECT 1 FROM community_json_code_observations WHERE source_id=?1 AND code=?2")
    .bind(COMMUNITY_JSON_SOURCE, candidate.code)
    .first();
  if (existing) return;
  // If the process stops after the operation transaction, the retry sees gift-code uniqueness;
  // it can then still persist provenance without creating a second operation.
  const operationId = await openCommunityDistribution(db, config, candidate.code, now);
  await observation(db, candidate, stamp, 0).run();
  if (operationId)
    await db
      .prepare(
        "UPDATE community_json_code_observations SET operation_id=?1 WHERE source_id=?2 AND code=?3",
      )
      .bind(operationId, COMMUNITY_JSON_SOURCE, candidate.code)
      .run();
}

async function withdraw(db: D1Database, code: string, stamp: string): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE community_json_code_observations SET source_active=0,withdrawn_at=?1 WHERE source_id=?2 AND code=?3 AND source_active=1",
      )
      .bind(stamp, COMMUNITY_JSON_SOURCE, code),
    db
      .prepare(
        "UPDATE gift_codes SET status='disabled' WHERE code=?1 AND source=?2 AND status='active'",
      )
      .bind(code, COMMUNITY_JSON_SOURCE),
    db
      .prepare(
        `UPDATE operation_items SET status='permanent_failure',reason_code='source_withdrawn',claim_token=NULL,claim_expires_at=NULL,updated_at=?1
      WHERE code=?2 AND status='pending' AND EXISTS(SELECT 1 FROM gift_codes WHERE code=?2 AND source=?3 AND status='disabled')`,
      )
      .bind(stamp, code, COMMUNITY_JSON_SOURCE),
    db
      .prepare(
        "UPDATE outbox_jobs SET status='dead',last_error='source_withdrawn',updated_at=?1 WHERE operation_id IN (SELECT operation_id FROM operation_items WHERE code=?2 AND reason_code='source_withdrawn') AND status='pending'",
      )
      .bind(stamp, code),
  ]);
}

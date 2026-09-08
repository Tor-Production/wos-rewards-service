import type { AppConfig } from "../config";
import type { RegistrationMessageEvent } from "../domain/discord-event";
import { MAX_REGISTRATION_SNAPSHOT_CODES } from "../limits";
import {
  contentHash,
  deliveryId,
  deterministicUuid,
  eventDeliveryGroup,
  nonceFor,
} from "./identity";
import type { ParseRegistrationResult } from "./registration-parser";
import { renderDisplayLabel } from "./sanitize";
import { validationReply } from "./validation-reply";

export type AcceptanceOutcome =
  | { kind: "accepted_invalid" }
  | { kind: "accepted_valid"; operationId: string }
  | { kind: "duplicate" }
  | { kind: "rejected"; reason: "snapshot_too_large" | "d1_failure" };

interface AcceptanceInput {
  db: D1Database;
  config: AppConfig;
  event: RegistrationMessageEvent;
  parsed: ParseRegistrationResult;
  now: Date;
  attemptRunId: string;
}

/**
 * SM-1: operation count, active-code membership, marker and outbox commit in one transaction.
 * SM-2: the existing nonnegative expected_count CHECK aborts an over-cap transaction, including
 * when an orphan operation already has this event's deterministic ID. No advisory preflight read.
 */
export async function acceptRegistrationEvent(input: AcceptanceInput): Promise<AcceptanceOutcome> {
  const { db, config, event, parsed, now, attemptRunId } = input;
  const timestamp = now.toISOString();
  const group = eventDeliveryGroup(event.event_id);
  const operationId = await deterministicUuid(`registration:${event.event_id}`);
  let statements: D1PreparedStatement[];
  if (!parsed.ok) {
    const id = deliveryId(group, 1);
    const content = validationReply(parsed.reason);
    const [hash, nonce] = await Promise.all([contentHash(content), nonceFor(id)]);
    statements = [
      db
        .prepare(
          `INSERT INTO processed_events
        (event_id, kind, status, outcome, operation_id, validation_reason,
         output_delivery_group, received_at, accepted_at, committed_at, finalized_at)
        VALUES (?1, 'registration', 'accepted_invalid', 'invalid', NULL, ?2, ?3, ?4, ?4, NULL, NULL)`,
        )
        .bind(event.event_id, parsed.reason, group, timestamp),
      db
        .prepare(
          `INSERT INTO discord_output_deliveries
        (delivery_id, delivery_group, event_id, operation_id, channel_id, output_type,
         chunk_index, chunk_total, content, content_hash, has_footer, nonce, status,
         claim_token, claim_expires_at, attempts, discord_message_id, sent_at, created_at, updated_at)
        VALUES (?1, ?2, ?3, NULL, ?4, 'validation_reply', 1, 1, ?5, ?6, 0, ?7, 'pending',
                NULL, NULL, 0, NULL, NULL, ?8, ?8)`,
        )
        .bind(id, group, event.event_id, event.channel_id, content, hash, nonce, timestamp),
    ];
  } else {
    const { playerId, state, displayName } = parsed;
    statements = [
      // Observe players.state before the upsert: T13 only runs for a real state change.
      db
        .prepare(
          `UPDATE redemptions SET status='pending', current_attempt_id=NULL,
        current_invocation_token=NULL, invocation_expires_at=NULL, retry_due_at=NULL,
        reason_code=NULL, terminal_at=NULL, attempts=0, attempt_generation=attempt_generation+1,
        reeval_count=reeval_count+1, updated_at=?1, budget_generation=budget_generation+1, provider_invocations=0, provider_invocation_limit=?5, current_terminal_generation=NULL
        WHERE player_id=?2 AND status='permanent_failure' AND reason_code='player_ineligible'
          AND reeval_count < ?3 AND (attempt_state IS NULL OR attempt_state <> ?4)
          AND EXISTS (SELECT 1 FROM players p WHERE p.player_id=?2 AND p.state <> ?4)`,
        )
        .bind(
          timestamp,
          playerId,
          config.redemptionMaxReeval,
          state,
          config.providerMaxInvocations,
        ),
      db
        .prepare(
          `INSERT INTO players
        (player_id, state, state_updated_at, display_name, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?3, ?3)
        ON CONFLICT (player_id) DO UPDATE SET
          state=excluded.state,
          state_updated_at=CASE WHEN players.state <> excluded.state THEN ?3 ELSE players.state_updated_at END,
          display_name=excluded.display_name, updated_at=?3`,
        )
        .bind(playerId, state, timestamp, displayName),
      // An over-cap negative count intentionally violates ck_operations_expected_count_nonneg.
      db
        .prepare(
          `INSERT INTO operations
        (operation_id, type, trigger_kind, trigger_ref, snapshot_at, expected_count,
         expansion_state, expansion_cursor, state, deadline_at, summary_state, created_at, updated_at, summary_context)
        SELECT ?1, 'registration_run', 'discord_event', ?2, ?3,
          CASE WHEN c.n <= ?4 THEN c.n ELSE -1 END,
          'expanded', NULL, 'pending', ?5, 'none', ?3, ?3, ?6
        FROM (SELECT COUNT(*) AS n FROM gift_codes WHERE status='active') c`,
        )
        .bind(
          operationId,
          event.event_id,
          timestamp,
          MAX_REGISTRATION_SNAPSHOT_CODES,
          new Date(now.getTime() + config.operationDeadlineSeconds * 1000).toISOString(),
          JSON.stringify({
            version: 1,
            channelId: event.channel_id,
            playerId,
            label: renderDisplayLabel(displayName, playerId),
            maxLength: config.discordMessageMaxLength,
            maxChunks: config.summaryMaxChunks,
          }),
        ),
      db
        .prepare(
          `INSERT INTO processed_events
        (event_id, kind, status, outcome, operation_id, validation_reason,
         output_delivery_group, received_at, accepted_at, committed_at, finalized_at)
        VALUES (?1, 'registration', 'work_committed', 'valid', ?2, NULL, ?3, ?4, ?4, ?4, NULL)`,
        )
        .bind(event.event_id, operationId, group, timestamp),
      db
        .prepare(
          `INSERT INTO operation_items
        (operation_id, item_key, player_id, code, job_id, status,
         display_label, claim_token, claim_expires_at, reason_code, attempts, updated_at)
        SELECT ?1, g.code, ?2, g.code, 'registration:' || ?1 || ':' || g.code,
          'pending', ?3, NULL, NULL, NULL, 0, ?4
        FROM gift_codes g WHERE g.status='active' ORDER BY g.code`,
        )
        .bind(operationId, playerId, renderDisplayLabel(displayName, playerId), timestamp),
      db
        .prepare(
          `INSERT INTO outbox_jobs
        (job_id, operation_id, item_key, type, attempt_id, payload_json,
         status, attempts, available_at, last_error, created_at, updated_at)
        SELECT i.job_id, i.operation_id, i.item_key, 'registration', ?1 || ':' || i.item_key,
          json_object('operation_id', i.operation_id, 'item_key', i.item_key, 'job_id', i.job_id,
            'player_id', i.player_id, 'code', i.code, 'attempt_id', ?1 || ':' || i.item_key),
          'pending', 0, ?2, NULL, ?2, ?2
        FROM operation_items i WHERE i.operation_id=?3`,
        )
        .bind(attemptRunId, timestamp, operationId),
    ];
  }

  try {
    await db.batch(statements);
    return parsed.ok ? { kind: "accepted_valid", operationId } : { kind: "accepted_invalid" };
  } catch {
    // Never inspect an error string. A durable marker is the only evidence of a duplicate.
    try {
      const marker = await db
        .prepare("SELECT 1 AS present FROM processed_events WHERE event_id=?1")
        .bind(event.event_id)
        .first();
      if (marker !== null) return { kind: "duplicate" };
      if (parsed.ok) {
        // Label only: acceptance already rolled back; either result has the same HTTP 503.
        const active = await db
          .prepare("SELECT COUNT(*) AS count FROM gift_codes WHERE status='active'")
          .first<{ count: number }>();
        if (active !== null && active.count > MAX_REGISTRATION_SNAPSHOT_CODES) {
          return { kind: "rejected", reason: "snapshot_too_large" };
        }
      }
    } catch {
      // Lookup outages fail closed too; neither exception details nor user content are logged.
    }
    return { kind: "rejected", reason: "d1_failure" };
  }
}

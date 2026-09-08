import { IDS_PER_UPDATE } from "../limits";
import { outboxBackoffSeconds } from "./backoff";
import type { OutboxRow } from "./packing";

export type OutboxMark =
  | { readonly kind: "enqueued"; readonly row: OutboxRow }
  | { readonly kind: "payload_invalid" | "payload_too_large"; readonly row: OutboxRow }
  | { readonly kind: "queue_send_failed"; readonly row: OutboxRow };

interface MarkGroup {
  readonly kind: OutboxMark["kind"];
  readonly attempts: number;
  readonly ids: string[];
}

export interface MarkingPlan {
  readonly statements: readonly D1PreparedStatement[];
  readonly outcomes: readonly ("enqueued" | "retried" | "dead")[];
}

/**
 * Closed grouping: success + two malformed-payload groups + at most M retry groups.
 * At most 90 ids plus four scalars per statement. A failed-send CAS also checks the
 * observed retry count, so a slow dispatcher cannot overwrite a newer retry/backoff.
 */
export function prepareOutboxMarks(
  db: D1Database,
  marks: readonly OutboxMark[],
  now: Date,
  maxAttempts: number,
): MarkingPlan {
  const groups = new Map<string, MarkGroup>();
  for (const mark of marks) {
    const attempts =
      mark.kind === "queue_send_failed" ? Math.min(mark.row.attempts + 1, maxAttempts) : 0;
    const key = `${mark.kind}:${attempts}`;
    let group = groups.get(key);
    if (!group) {
      group = { kind: mark.kind, attempts, ids: [] };
      groups.set(key, group);
    }
    if (mark.row.attempt_id === undefined) throw new Error("missing_outbox_generation");
    group.ids.push(JSON.stringify([mark.row.job_id, mark.row.attempt_id]));
  }

  const statements: D1PreparedStatement[] = [];
  const outcomes: ("enqueued" | "retried" | "dead")[] = [];
  const timestamp = now.toISOString();
  for (const group of groups.values()) {
    for (let offset = 0; offset < group.ids.length; offset += IDS_PER_UPDATE) {
      const ids = group.ids.slice(offset, offset + IDS_PER_UPDATE);
      let scalars: (string | number)[];
      let assignments: string;
      let guard = "";
      let outcome: "enqueued" | "retried" | "dead";
      if (group.kind === "enqueued") {
        assignments = "status='enqueued', last_error=NULL, updated_at=?1";
        scalars = [timestamp];
        outcome = "enqueued";
      } else if (group.kind !== "queue_send_failed") {
        assignments = "status='dead', last_error=?1, available_at=?2, updated_at=?2";
        scalars = [group.kind, timestamp];
        outcome = "dead";
      } else if (group.attempts >= maxAttempts) {
        // A lowered configured cap can encounter older pending rows above that cap.
        // Preserve their counter while terminalizing within this same bounded group.
        assignments =
          "status='dead', attempts=MAX(attempts, ?1), last_error='queue_send_failed', available_at=?2, updated_at=?2";
        scalars = [maxAttempts, timestamp];
        guard = " AND attempts >= ?1 - 1";
        outcome = "dead";
      } else {
        assignments = "attempts=?1, last_error='queue_send_failed', available_at=?2, updated_at=?3";
        scalars = [
          group.attempts,
          new Date(now.getTime() + outboxBackoffSeconds(group.attempts) * 1_000).toISOString(),
          timestamp,
        ];
        guard = " AND attempts = ?1 - 1";
        outcome = "retried";
      }
      const observed = ids.map((_, index) => `(?${scalars.length + index + 1})`).join(",");
      statements.push(
        db
          .prepare(
            `UPDATE outbox_jobs SET ${assignments} WHERE status='pending'${guard} AND EXISTS (SELECT 1 FROM (VALUES ${observed}) observed WHERE json_extract(observed.column1, '$[0]')=outbox_jobs.job_id AND json_extract(observed.column1, '$[1]')=outbox_jobs.attempt_id)`,
          )
          .bind(...scalars, ...ids),
      );
      outcomes.push(outcome);
    }
  }
  return { statements, outcomes };
}

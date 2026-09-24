/**
 * Bounded failure record for the scheduled handler. Keep this schema closed: it is an
 * operational classifier, not a carrier for errors, requests, configuration, or payloads.
 */
export const SCHEDULED_LANES = [
  "expansion",
  "outbox",
  "recovery",
  "summary",
  "delivery",
  "community",
] as const;

export type ScheduledLane = (typeof SCHEDULED_LANES)[number];
export type ScheduledLaneQueryBudget = 6 | 8 | 9 | 10 | 12;

export interface ScheduledLaneFailureLog {
  readonly event: "scheduled_lane_failed";
  readonly lane: ScheduledLane;
  readonly environment: "staging";
  readonly query_budget: ScheduledLaneQueryBudget;
}

/**
 * Emits only allowlisted primitive values. A failing log sink must never change scheduled
 * work, recovery, or retry behavior.
 */
export function logScheduledLaneFailure(
  lane: ScheduledLane,
  queryBudget: ScheduledLaneQueryBudget,
  environment: "staging",
): void {
  const record: ScheduledLaneFailureLog = {
    event: "scheduled_lane_failed",
    lane,
    environment,
    query_budget: queryBudget,
  };
  try {
    console.warn(record);
  } catch {
    // Logging is intentionally best effort; never let its sink affect scheduled work.
  }
}

/** One closed outcome per attempted community fetch; never accept response or error objects. */
export type CommunityFetchOutcome =
  | "ok"
  | "not_modified"
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
  | "json_invalid"
  | "schema_invalid"
  | "stale_snapshot";

export function logCommunityFetchOutcome(
  outcome: CommunityFetchOutcome,
  environment: "staging",
): void {
  const record = { event: "community_fetch_outcome" as const, environment, outcome };
  try {
    if (outcome === "ok" || outcome === "not_modified") console.info(record);
    else console.warn(record);
  } catch {
    // Diagnostics must not alter the request gate, retry classification, or scheduled lanes.
  }
}

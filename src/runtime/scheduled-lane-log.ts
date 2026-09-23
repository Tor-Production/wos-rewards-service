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

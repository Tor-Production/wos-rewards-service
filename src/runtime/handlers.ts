import { loadConfig } from "../config";
import { dispatchOutput, type DiscordTransport } from "../discord/delivery";
import { expandPage } from "../operations/distribution";
import { recover } from "../operations/recovery";
import { summaryPage } from "../operations/summary";
import { dispatchOutbox } from "../outbox/dispatcher";
import { MockWhiteoutProvider } from "../providers/mock-whiteout-provider";
import { consume, consumeDlq, type Delivery } from "../redemption/consumer";
import type { WhiteoutProvider } from "../domain/whiteout-provider";
import { budgetDatabase } from "./db";

export async function scheduledWork(
  env: Env,
  options: { now?: () => Date; transport?: DiscordTransport } = {},
): Promise<void> {
  const config = loadConfig(env);
  const clock = options.now ?? (() => new Date());
  const now = clock().toISOString();
  const db = budgetDatabase(env.STAGING_DB, 39);
  const lanes: [number, (db: D1Database) => Promise<unknown>][] = [
    [6, (db) => expandPage(db, now)],
    [
      10,
      async (db) => {
        await dispatchOutbox({
          db,
          config,
          now: new Date(now),
          queues: {
            registration: env.REGISTRATION_JOBS_QUEUE,
            distribution: env.CODE_FANOUT_JOBS_QUEUE,
          },
          source: { kind: "fair", limit: 90 },
        });
      },
    ],
    [8, (db) => recover(db, config, now)],
    [6, (db) => summaryPage(db, now)],
    [9, (db) => dispatchOutput(db, config, clock, options.transport)],
  ];
  for (const [limit, run] of lanes)
    try {
      await run(budgetDatabase(db, limit));
    } catch {
      // Durable claims/cursors recover next tick. Never log raw SQL, payloads, or exceptions.
      console.warn("scheduled_lane_failed", limit);
    }
}

export async function queueWork(
  batch: { queue: string; messages: readonly Delivery[] },
  env: Env,
  options: { now?: () => Date; provider?: WhiteoutProvider } = {},
): Promise<void> {
  const config = loadConfig(env);
  const now = options.now ?? (() => new Date());
  const provider = options.provider ?? new MockWhiteoutProvider();
  const dlq = batch.queue === "wos-rewards-redemption-dlq-staging";
  const route =
    batch.queue === "wos-rewards-registration-jobs-staging"
      ? "registration"
      : batch.queue === "wos-rewards-code-fanout-jobs-staging"
        ? "distribution"
        : null;
  const db = budgetDatabase(env.STAGING_DB, dlq ? 16 : 32);
  for (const [index, message] of batch.messages.entries()) {
    if (index >= 2) {
      message.retry({ delaySeconds: 60 });
      continue;
    }
    if (dlq) await consumeDlq(message, { db, now });
    else if (route) await consume(message, route, { db, config, now, provider });
    else message.ack();
  }
}

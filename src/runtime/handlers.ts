import { loadConfig } from "../config";
import {
  createDiscordRestTransport,
  dispatchOutput,
  type DiscordFetch,
  type DiscordTransport,
} from "../discord/delivery";
import { expandPage } from "../operations/distribution";
import { runCommunityJsonSource } from "../discovery/community-json-runtime";
import { recover } from "../operations/recovery";
import { summaryPage } from "../operations/summary";
import { dispatchOutbox } from "../outbox/dispatcher";
import { MockWhiteoutProvider } from "../providers/mock-whiteout-provider";
import { consume, consumeDlq, type Delivery } from "../redemption/consumer";
import type { WhiteoutProvider } from "../domain/whiteout-provider";
import { budgetDatabase } from "./db";
import {
  logScheduledLaneFailure,
  type ScheduledLane,
  type ScheduledLaneQueryBudget,
} from "./scheduled-lane-log";

interface ScheduledLaneDefinition {
  readonly lane: ScheduledLane;
  readonly limit: ScheduledLaneQueryBudget;
  readonly run: (db: D1Database) => Promise<unknown>;
}

export async function scheduledWork(
  env: Env,
  options: {
    now?: () => Date;
    transport?: DiscordTransport;
    fetcher?: DiscordFetch;
    communityFetcher?: typeof fetch;
  } = {},
): Promise<void> {
  const config = loadConfig(env);
  const clock = options.now ?? (() => new Date());
  const transport =
    options.transport ??
    (config.discordDeliveryEnabled && config.discordBotToken
      ? createDiscordRestTransport(config.discordBotToken, options.fetcher)
      : undefined);
  const now = clock().toISOString();
  const db = budgetDatabase(env.STAGING_DB, 39);
  const lanes: readonly ScheduledLaneDefinition[] = [
    { lane: "expansion", limit: 6, run: (db) => expandPage(db, now) },
    {
      lane: "outbox",
      limit: 10,
      run: async (db) => {
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
    },
    { lane: "recovery", limit: 8, run: (db) => recover(db, config, now) },
    { lane: "summary", limit: 6, run: (db) => summaryPage(db, now) },
    { lane: "delivery", limit: 9, run: (db) => dispatchOutput(db, config, clock, transport) },
  ];
  for (const { lane, limit, run } of lanes)
    try {
      await run(budgetDatabase(db, limit));
    } catch {
      // Durable claims/cursors recover next tick. Never log raw SQL, payloads, or exceptions.
      logScheduledLaneFailure(lane, limit, config.environment);
    }
  try {
    // This source has a separate bounded budget and cannot prevent the established lanes.
    await runCommunityJsonSource(
      budgetDatabase(env.STAGING_DB, 12),
      config,
      clock(),
      options.communityFetcher,
    );
  } catch {
    logScheduledLaneFailure("recovery", 8, config.environment);
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

import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { openDistribution } from "../src/operations/distribution";
import { scheduledWork, queueWork } from "../src/runtime/handlers";
import { MockWhiteoutProvider } from "../src/providers/mock-whiteout-provider";
import { countD1, RecordingQueue, testConfig } from "./support/fixtures";

const db = env.THROUGHPUT_DB;
beforeEach(async () => {
  for (const table of [
    "terminal_receipts",
    "terminal_observations",
    "operation_late_results",
    "summary_item_snapshot",
    "summary_chunk_layout",
    "discord_output_deliveries",
    "outbox_jobs",
    "operation_players_snapshot",
    "operation_items",
    "redemptions",
    "processed_events",
    "operations",
    "gift_codes",
    "players",
    "scheduler_progress",
    "dispatch_control",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

it.each([1, 2])(
  "%s maximum distributions meet their accounting deadline under fair healthy execution",
  async (count) => {
    const created = new Date("2026-09-08T00:00:00.001Z");
    let clock = created;
    const names = Array.from({ length: 2000 }, (_, i) => String(100000 + i));
    await db
      .prepare(
        `INSERT INTO players(player_id,state,display_name,created_at,updated_at)
    SELECT value,'0','Player '||value,?1,?1 FROM json_each(?2)`,
      )
      .bind(created.toISOString(), JSON.stringify(names))
      .run();
    const ids: string[] = [];
    for (let i = 0; i < count; i++)
      ids.push((await openDistribution(db, testConfig(), `SYNTHETIC-${i}`, created))!);
    const q = new RecordingQueue();
    const provider = new MockWhiteoutProvider();
    const calls = vi.spyOn(provider, "redeem");
    const warning = vi.spyOn(console, "warn");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unmatched external network prohibited"));
    const history: Record<string, number> = {};
    try {
      let consumed = 0;
      for (let tick = 1; tick <= (count === 1 ? 24 : 47); tick++) {
        clock = new Date(created.getTime() + tick * 60000);
        const measured = countD1(db);
        const runtimeEnv = {
          ...env,
          STAGING_DB: measured.db,
          REGISTRATION_JOBS_QUEUE: q as unknown as Env["REGISTRATION_JOBS_QUEUE"],
          CODE_FANOUT_JOBS_QUEUE: q as unknown as Env["CODE_FANOUT_JOBS_QUEUE"],
        };
        const sentBefore = q.bodies.length;
        await scheduledWork(runtimeEnv, { now: () => clock });
        expect(measured.stats.statements).toBeLessThanOrEqual(39);
        expect(measured.stats.maxBindings).toBeLessThanOrEqual(100);
        expect(q.bodies.length - sentBefore).toBeLessThanOrEqual(90);
        const jobs = q.bodies.slice(consumed);
        consumed = q.bodies.length;
        for (let offset = 0; offset < jobs.length; offset += 2) {
          // 90 calls/45 seconds: the explicit healthy mock service envelope.
          clock = new Date(created.getTime() + tick * 60000 + (offset + 2) * 500);
          const messages = jobs
            .slice(offset, offset + 2)
            .map((body) => ({ body, ack: vi.fn<() => void>(), retry: vi.fn<() => void>() }));
          const consumer = countD1(db);
          await queueWork(
            { queue: "wos-rewards-code-fanout-jobs-staging", messages },
            { ...env, STAGING_DB: consumer.db },
            { now: () => clock, provider },
          );
          expect(consumer.stats.statements).toBeLessThanOrEqual(32);
          for (const m of messages) {
            expect(m.ack).toHaveBeenCalledOnce();
            expect(m.retry).not.toHaveBeenCalled();
          }
        }
        const rows = (
          await db
            .prepare(
              "SELECT operation_id,summary_state,expansion_state,deadline_at FROM operations WHERE type='code_distribution_run'",
            )
            .all<{
              operation_id: string;
              summary_state: string;
              expansion_state: string;
              deadline_at: string;
            }>()
        ).results;
        for (const row of rows)
          if (row.summary_state !== "none" && !history[row.operation_id]) {
            history[row.operation_id] = clock.getTime() - created.getTime();
            expect(row.expansion_state).toBe("expanded");
            expect(clock.getTime()).toBeLessThan(Date.parse(row.deadline_at));
          }
        if (Object.keys(history).length === count) break;
      }
      expect(Object.keys(history).sort()).toEqual(ids.sort());
      for (const duration of Object.values(history))
        expect(duration).toBeLessThan((count === 1 ? 24 : 47) * 60000);
      console.info("healthy_mock_accounting", {
        operations: count,
        milliseconds: Object.values(history).sort((a, b) => a - b),
      });
      expect(calls).toHaveBeenCalledTimes(count * 2000);
      expect(
        await db
          .prepare("SELECT COUNT(*) n FROM operation_items WHERE status='success'")
          .first("n"),
      ).toBe(count * 2000);
      expect(warning).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      fetch.mockRestore();
    }
  },
  180000,
);

import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import type { RedemptionJobBody } from "../src/domain/queue-jobs";
import { dispatchOutput } from "../src/discord/delivery";
import { acceptRegistrationEvent } from "../src/ingest/acceptance";
import { parseRegistration } from "../src/ingest/registration-parser";
import { recover, redrive } from "../src/operations/recovery";
import { summaryPage } from "../src/operations/summary";
import { MockWhiteoutProvider } from "../src/providers/mock-whiteout-provider";
import { consume, type Delivery } from "../src/redemption/consumer";
import { makeEvent, seedCodes, testConfig } from "./support/fixtures";

const db = env.PHASE4_DB;
const config = testConfig();
let clock: Date;

beforeEach(async () => {
  clock = new Date("2026-09-08T00:00:00.000Z");
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
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

async function register(playerId = "100") {
  const event = makeEvent({
    content: `${playerId} 0 Review`,
    created_at: clock.toISOString(),
  });
  const result = await acceptRegistrationEvent({
    db,
    config,
    event,
    parsed: parseRegistration(event.content, "0"),
    now: clock,
    attemptRunId: crypto.randomUUID(),
  });
  if (result.kind !== "accepted_valid") throw new Error("fixture not accepted");
  const jobs = (
    await db
      .prepare("SELECT payload_json FROM outbox_jobs WHERE operation_id=?1 ORDER BY item_key")
      .bind(result.operationId)
      .all<{ payload_json: string }>()
  ).results.map((row) => JSON.parse(row.payload_json) as RedemptionJobBody);
  return { ...result, jobs };
}

function message(body: RedemptionJobBody): Delivery & {
  ack: ReturnType<typeof vi.fn<Delivery["ack"]>>;
  retry: ReturnType<typeof vi.fn<Delivery["retry"]>>;
} {
  return {
    body,
    ack: vi.fn<Delivery["ack"]>(),
    retry: vi.fn<Delivery["retry"]>(),
  };
}

it("F1: an outbox attempt superseded after validation cannot acquire a grant or mutate its item", async () => {
  await seedCodes(db, ["CODE"], clock);
  const fixture = await register();
  await consume(message(fixture.jobs[0]!), "registration", {
    db,
    config,
    provider: new MockWhiteoutProvider({ defaultOutcome: "rate_limited" }),
    now: () => clock,
  });
  await db.prepare("UPDATE outbox_jobs SET status='enqueued'").run();
  clock = new Date(clock.getTime() + 400_000);

  let intercepted = false;
  let stateAfterRedrive: unknown;
  const interleaved = new Proxy(db, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (!intercepted) {
            intercepted = true;
            await redrive(db, config, clock.toISOString());
            stateAfterRedrive = await db
              .prepare(
                `SELECT r.current_attempt_id,b.attempt_id AS outbox_attempt,r.provider_invocations,r.status,
                   i.status AS item_status,i.claim_token
                 FROM redemptions r
                 JOIN operation_items i ON i.player_id=r.player_id AND i.code=r.code
                 JOIN outbox_jobs b ON b.job_id=i.job_id`,
              )
              .first();
          }
          return target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const provider = new MockWhiteoutProvider({ defaultOutcome: "rate_limited" });
  const calls = vi.spyOn(provider, "redeem");
  const stale = message(fixture.jobs[0]!);

  await consume(stale, "registration", {
    db: interleaved,
    config,
    provider,
    now: () => clock,
  });

  expect(calls).not.toHaveBeenCalled();
  expect(stale.ack).toHaveBeenCalledOnce();
  expect(stale.retry).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        `SELECT r.current_attempt_id,b.attempt_id AS outbox_attempt,r.provider_invocations,r.status,
           i.status AS item_status,i.claim_token
         FROM redemptions r
         JOIN operation_items i ON i.player_id=r.player_id AND i.code=r.code
         JOIN outbox_jobs b ON b.job_id=i.job_id`,
      )
      .first(),
  ).toEqual(stateAfterRedrive);
});

it("F2: a committed terminal result atomically accounts for and freezes its initiating item", async () => {
  await seedCodes(db, ["CODE"], clock);
  const fixture = await register();
  await db
    .prepare("UPDATE operations SET deadline_at=?1")
    .bind(new Date(clock.getTime() + 1_000).toISOString())
    .run();
  let batches = 0;
  const crashAfterTerminal = new Proxy(db, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batches++;
          const result = await target.batch(statements);
          if (batches === 2) throw new Error("synthetic crash after terminal commit");
          return result;
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const provider = new MockWhiteoutProvider();
  const calls = vi.spyOn(provider, "redeem");

  await consume(message(fixture.jobs[0]!), "registration", {
    db: crashAfterTerminal,
    config,
    provider,
    now: () => clock,
  });
  expect(await db.prepare("SELECT status FROM redemptions").first("status")).toBe("success");

  clock = new Date(clock.getTime() + 2_000);
  await consume(message(fixture.jobs[0]!), "registration", {
    db,
    config,
    provider,
    now: () => clock,
  });
  await recover(db, config, clock.toISOString());
  await summaryPage(db, clock.toISOString());

  expect(calls).toHaveBeenCalledOnce();
  expect(
    await db
      .prepare("SELECT state,success_count,completed_count FROM operations WHERE operation_id=?1")
      .bind(fixture.operationId)
      .first(),
  ).toMatchObject({ state: "awaiting_summary", success_count: 1, completed_count: 1 });
  expect(await db.prepare("SELECT disposition FROM terminal_receipts").first("disposition")).toBe(
    "applied",
  );
});

it("F3: 128 older blocked groups cannot starve finalization of a newer sent group", async () => {
  const fixture = await register();
  for (let index = 0; index < 4; index++) await summaryPage(db, clock.toISOString());
  const old = new Date(clock.getTime() - 1_000).toISOString();
  const ids = JSON.stringify(
    Array.from({ length: 128 }, (_, index) => `blocked-${String(index).padStart(3, "0")}`),
  );
  await db.batch([
    db
      .prepare(
        `INSERT INTO operations(operation_id,type,trigger_kind,trigger_ref,snapshot_at,expected_count,expansion_state,deadline_at,state,summary_state,summary_chunk_total,summary_build_cursor,created_at,updated_at,summary_context)
      SELECT j.value,o.type,o.trigger_kind,o.trigger_ref,o.snapshot_at,0,'expanded',o.deadline_at,'awaiting_summary','built',1,1,?3,?3,o.summary_context
      FROM operations o,json_each(?2) j WHERE o.operation_id=?1`,
      )
      .bind(fixture.operationId, ids, old),
    db
      .prepare(
        `INSERT INTO discord_output_deliveries(delivery_id,delivery_group,operation_id,channel_id,output_type,chunk_index,chunk_total,content,content_hash,has_footer,nonce,status,attempts,blocked_at,created_at,updated_at,available_at)
      SELECT 'delivery:'||j.value,'group:'||j.value,j.value,d.channel_id,d.output_type,1,1,d.content,d.content_hash,1,j.value,'pending',1,?3,?3,?3,?3
      FROM discord_output_deliveries d,json_each(?2) j WHERE d.operation_id=?1`,
      )
      .bind(fixture.operationId, ids, old),
  ]);
  const transport = vi.fn(async () => Response.json({ id: "999" }));

  for (let index = 0; index < 3; index++) {
    await dispatchOutput(db, config, () => clock, transport);
  }

  expect(transport).toHaveBeenCalledOnce();
  expect(
    await db
      .prepare("SELECT status FROM discord_output_deliveries WHERE operation_id=?1")
      .bind(fixture.operationId)
      .first("status"),
  ).toBe("sent");
  expect(
    await db
      .prepare("SELECT summary_state FROM operations WHERE operation_id=?1")
      .bind(fixture.operationId)
      .first(),
  ).toEqual({ summary_state: "delivered" });
});

it("F4: a maximum accepted repeat registration reuses all terminal results before its deadline", async () => {
  const codes = Array.from(
    { length: 2_000 },
    (_, index) => `CODE-${String(index).padStart(4, "0")}`,
  );
  await seedCodes(db, codes, clock);
  const fixture = await register();
  await db.batch([
    db
      .prepare(
        `INSERT INTO redemptions(player_id,code,idempotency_key,status,attempt_state,terminal_at,updated_at,provider_invocations,current_terminal_generation,last_observation_at)
        SELECT '100',code,'redeem:v1:100:'||code,'success','0',?1,?1,1,1,?1 FROM gift_codes`,
      )
      .bind(clock.toISOString()),
    db.prepare(
      `INSERT INTO terminal_observations(player_id,code,budget_generation,status,attempt_state,cause,observed_at,mirror_complete)
        SELECT player_id,code,1,status,'0','provider',last_observation_at,1 FROM redemptions`,
    ),
    db.prepare("UPDATE outbox_jobs SET status='enqueued'"),
  ]);
  const provider = new MockWhiteoutProvider();
  const calls = vi.spyOn(provider, "redeem");
  await consume(message(fixture.jobs[0]!), "registration", {
    db,
    config,
    provider,
    now: () => clock,
  });

  const start = clock.getTime();
  for (let tick = 1; tick <= 61; tick++) {
    clock = new Date(start + tick * 60_000);
    await recover(db, config, clock.toISOString());
    await summaryPage(db, clock.toISOString());
  }

  expect(calls).not.toHaveBeenCalled();
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM operation_items WHERE status='success'")
      .first("count"),
  ).toBe(2_000);
  expect(
    await db
      .prepare("SELECT state FROM operations WHERE operation_id=?1")
      .bind(fixture.operationId)
      .first("state"),
  ).not.toBe("stale_closed");
}, 60_000);

import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyD1Migrations,
  createMessageBatch,
  createExecutionContext,
  getQueueResult,
} from "cloudflare:test";
import worker from "../src/index";
import { acceptRegistrationEvent } from "../src/ingest/acceptance";
import { parseRegistration } from "../src/ingest/registration-parser";
import { consume, consumeDlq, type Delivery } from "../src/redemption/consumer";
import {
  applyRecipients,
  mirrorObservation,
  recipients,
  reuseTerminal,
} from "../src/redemption/reconcile";
import { MockWhiteoutProvider } from "../src/providers/mock-whiteout-provider";
import { openDistribution, expandPage } from "../src/operations/distribution";
import { summaryPage, RUNTIME_FOOTER } from "../src/operations/summary";
import {
  openRepairRun,
  authorizeRepair,
  deadOutbox,
  redrive,
  recover,
} from "../src/operations/recovery";
import { createMessage, dispatchOutput } from "../src/discord/delivery";
import { dispatchOutbox } from "../src/outbox/dispatcher";
import {
  countD1,
  makeEvent,
  seedCodes,
  seedPlayer,
  testConfig,
  uniqueId,
  RecordingQueue,
} from "./support/fixtures";
import type { RedemptionJobBody } from "../src/domain/queue-jobs";
import type { RedeemResult } from "../src/domain/whiteout-provider";
import { scheduledWork, queueWork } from "../src/runtime/handlers";

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
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});
function message(body: unknown) {
  return { body, ack: vi.fn<Delivery["ack"]>(), retry: vi.fn<Delivery["retry"]>() };
}
async function register(pid = uniqueId(), state = "0", eventId = uniqueId()) {
  const event = makeEvent({
    event_id: eventId,
    content: `${pid} ${state} Name`,
    created_at: clock.toISOString(),
  });
  const result = await acceptRegistrationEvent({
    db,
    config,
    event,
    parsed: parseRegistration(event.content, state),
    now: clock,
    attemptRunId: crypto.randomUUID(),
  });
  expect(result.kind).toBe("accepted_valid");
  if (result.kind !== "accepted_valid") throw new Error("fixture");
  const rows = (
    await db
      .prepare("SELECT payload_json FROM outbox_jobs WHERE operation_id=?1 ORDER BY item_key")
      .bind(result.operationId)
      .all<{ payload_json: string }>()
  ).results;
  return {
    operationId: result.operationId,
    jobs: rows.map((row) => JSON.parse(row.payload_json) as RedemptionJobBody),
    pid,
  };
}
async function setup() {
  await seedCodes(db, ["CODE"], clock);
  return register();
}
async function run(
  body: RedemptionJobBody,
  provider = new MockWhiteoutProvider(),
  route: "registration" | "distribution" = "registration",
) {
  const m = message(body);
  await consume(m, route, { db, config, provider, now: () => clock });
  return m;
}
async function redemption(pid: string) {
  return db
    .prepare("SELECT * FROM redemptions WHERE player_id=?1 AND code='CODE'")
    .bind(pid)
    .first<Record<string, unknown>>();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("logical invocation authority and transitions", () => {
  it("two physical messages share exactly four grants and one terminal observation", async () => {
    const f = await setup();
    const provider = new MockWhiteoutProvider({ defaultOutcome: "rate_limited" });
    const calls = vi.spyOn(provider, "redeem");
    const physical = [
      { id: "physical-A", ...message(f.jobs[0]) },
      { id: "physical-B", ...message(f.jobs[0]) },
    ];
    for (let index = 0; index < 4; index++) {
      const m = physical[index % 2]!;
      await consume(m, "registration", { db, config, provider, now: () => clock });
      const r = await redemption(f.pid);
      expect(r?.provider_invocations).toBe(index + 1);
      if (index < 3) {
        expect(r?.status).toBe("retry_wait");
        expect(r?.current_invocation_token).toBeNull();
        clock = new Date(r!.retry_due_at as string);
      }
    }
    expect(calls).toHaveBeenCalledTimes(4);
    expect((await redemption(f.pid))?.status).toBe("retry_exhausted");
    for (let i = 0; i < 5; i++) {
      clock = new Date(clock.getTime() + 180000);
      await run(f.jobs[0]!, provider);
      await redrive(db, config, clock.toISOString());
    }
    expect(calls).toHaveBeenCalledTimes(4);
    expect(await db.prepare("SELECT COUNT(*) n FROM terminal_observations").first("n")).toBe(1);
    expect(await db.prepare("SELECT status FROM operation_items").first("status")).toBe(
      "retry_exhausted",
    );
  });
  it("simultaneous identical attempts have one provider invocation and no loser writes", async () => {
    const f = await setup();
    const latch = deferred<RedeemResult>();
    const started = deferred<void>();
    const provider = new MockWhiteoutProvider();
    vi.spyOn(provider, "redeem").mockImplementation(() => {
      started.resolve();
      return latch.promise;
    });
    const first = run(f.jobs[0]!, provider);
    await started.promise;
    const before = await redemption(f.pid);
    const loser = await run(f.jobs[0]!, provider);
    expect(loser.ack).toHaveBeenCalledOnce();
    expect(loser.retry).not.toHaveBeenCalled();
    expect(await redemption(f.pid)).toEqual(before);
    latch.resolve({ outcome: "success" });
    await first;
    expect(provider.redeem).toHaveBeenCalledOnce();
  });
  it("an early retry is T3 and fourth-call success is immutable", async () => {
    const f = await setup();
    const provider = new MockWhiteoutProvider({ defaultOutcome: "rate_limited" });
    const calls = vi.spyOn(provider, "redeem");
    await run(f.jobs[0]!, provider);
    const before = await redemption(f.pid);
    await run(f.jobs[0]!, provider);
    expect(await redemption(f.pid)).toEqual(before);
    for (let i = 0; i < 3; i++) {
      clock = new Date((await redemption(f.pid))!.retry_due_at as string);
      if (i === 2) calls.mockResolvedValue({ outcome: "success" });
      await run(f.jobs[0]!, provider);
    }
    expect(calls).toHaveBeenCalledTimes(4);
    expect((await redemption(f.pid))?.status).toBe("success");
    await register(f.pid, "2");
    expect((await redemption(f.pid))?.budget_generation).toBe(1);
  });
  it.each([false, true])(
    "DLQ honors retry_wait before due and stale newer attempts: stale=%s",
    async (stale) => {
      const f = await setup();
      await run(f.jobs[0]!, new MockWhiteoutProvider({ defaultOutcome: "rate_limited" }));
      if (stale)
        await db
          .prepare(
            "UPDATE redemptions SET current_attempt_id='new',invocation_expires_at='2000-01-01T00:00:00.000Z'",
          )
          .run();
      const before = await redemption(f.pid);
      const m = message(f.jobs[0]);
      await consumeDlq(m, { db, now: () => clock });
      expect(m.ack).toHaveBeenCalledOnce();
      expect((await redemption(f.pid))?.status).toBe(stale ? "retry_wait" : "retry_exhausted");
      if (stale) expect(await redemption(f.pid)).toEqual(before);
    },
  );
  it("DLQ cannot close a live invocation, and stale invocation results cannot win", async () => {
    const f = await setup();
    const latch = deferred<RedeemResult>();
    const started = deferred<void>();
    const provider = new MockWhiteoutProvider();
    vi.spyOn(provider, "redeem").mockImplementationOnce(() => {
      started.resolve();
      return latch.promise;
    });
    const old = run(f.jobs[0]!, provider);
    await started.promise;
    const before = await redemption(f.pid);
    await consumeDlq(message(f.jobs[0]), { db, now: () => clock });
    expect(await redemption(f.pid)).toEqual(before);
    clock = new Date(clock.getTime() + 121000);
    await run(f.jobs[0]!, provider);
    latch.resolve({ outcome: "permanent", reasonCode: "code_invalid" });
    await old;
    expect((await redemption(f.pid))?.status).toBe("success");
    expect((await redemption(f.pid))?.provider_invocations).toBe(2);
  });
  it.each([0, 3])("in-flight state changes honor the reevaluation cap %s", async (cap) => {
    const f = await setup();
    const provider = new MockWhiteoutProvider();
    vi.spyOn(provider, "redeem").mockImplementation(async () => {
      await db.prepare("UPDATE players SET state='7' WHERE player_id=?1").bind(f.pid).run();
      return { outcome: "permanent", reasonCode: "player_ineligible" };
    });
    await consume(message(f.jobs[0]), "registration", {
      db,
      config: { ...config, redemptionMaxReeval: cap },
      provider,
      now: () => clock,
    });
    const r = await redemption(f.pid);
    expect(r?.status).toBe(cap ? "pending" : "permanent_failure");
    expect(r?.reason_code).toBe(cap ? null : "state_reevaluation_limit");
    expect(r?.provider_invocations).toBe(cap ? 0 : 1);
  });
  it("re-drive rotates physical attempt but preserves charged grants; final crash closes", async () => {
    const f = await setup();
    await run(f.jobs[0]!, new MockWhiteoutProvider({ defaultOutcome: "rate_limited" }));
    await db.prepare("UPDATE outbox_jobs SET status='enqueued'").run();
    clock = new Date(clock.getTime() + 400000);
    await redrive(db, config, clock.toISOString());
    const r = await redemption(f.pid);
    expect(r?.provider_invocations).toBe(1);
    expect(r?.budget_generation).toBe(1);
    const aid = await db.prepare("SELECT attempt_id FROM outbox_jobs").first<string>("attempt_id");
    expect(aid).not.toBe(f.jobs[0]!.attempt_id);
    await db
      .prepare(
        "UPDATE redemptions SET provider_invocations=4,status='in_progress',current_attempt_id=?1,invocation_expires_at=?2,current_invocation_token='crashed'",
      )
      .bind(aid, new Date(clock.getTime() + 1000).toISOString())
      .run();
    await run({ ...f.jobs[0]!, attempt_id: aid! });
    expect((await redemption(f.pid))?.status).toBe("in_progress");
    clock = new Date(clock.getTime() + 2000);
    await run({ ...f.jobs[0]!, attempt_id: aid! });
    expect((await redemption(f.pid))?.status).toBe("retry_exhausted");
  });
  it("rejects malformed, wrong-route and superseded messages without provider calls", async () => {
    const f = await setup();
    const p = new MockWhiteoutProvider();
    const calls = vi.spyOn(p, "redeem");
    for (const body of [
      null,
      {},
      { ...f.jobs[0], extra: "x" },
      { ...f.jobs[0], attempt_id: "stale" },
      { ...f.jobs[0], player_id: "bad" },
    ])
      await consume(message(body), "registration", { db, config, provider: p, now: () => clock });
    await run(f.jobs[0]!, p, "distribution");
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("terminal reuse and frozen sources", () => {
  it("reuses success after a completed observation pass without a provider call", async () => {
    const f = await setup();
    const p = new MockWhiteoutProvider();
    const calls = vi.spyOn(p, "redeem");
    await run(f.jobs[0]!, p);
    await mirrorObservation(db, clock.toISOString());
    expect(
      await db
        .prepare("SELECT mirror_complete FROM terminal_observations")
        .first("mirror_complete"),
    ).toBe(1);
    const later = await register(f.pid);
    await run(later.jobs[0]!, p);
    await reuseTerminal(db, clock.toISOString());
    expect(
      await db
        .prepare("SELECT status FROM operation_items WHERE operation_id=?1")
        .bind(later.operationId)
        .first("status"),
    ).toBe("success");
    expect(calls).toHaveBeenCalledOnce();
  });
  it("finds an item behind the mirror cursor", async () => {
    const f = await setup();
    await run(f.jobs[0]!);
    await db
      .prepare("UPDATE terminal_observations SET mirror_cursor='zzzz',mirror_complete=0")
      .run();
    const later = await register(f.pid);
    await mirrorObservation(db, clock.toISOString());
    await reuseTerminal(db, clock.toISOString());
    expect(
      await db
        .prepare("SELECT status FROM operation_items WHERE operation_id=?1")
        .bind(later.operationId)
        .first("status"),
    ).toBe("success");
  });
  it("a reopen between selection and reconciliation invalidates the old observation", async () => {
    const f = await setup();
    await run(f.jobs[0]!, new MockWhiteoutProvider({ defaultOutcome: "player_ineligible" }));
    const later = await register(f.pid);
    const page = await recipients(db, "i.operation_id=?1", [later.operationId]);
    expect(page).toHaveLength(1);
    await register(f.pid, "7");
    await db.prepare("UPDATE players SET state='0' WHERE player_id=?1").bind(f.pid).run();
    await applyRecipients(db, clock.toISOString(), page);
    expect(
      await db
        .prepare("SELECT status FROM operation_items WHERE operation_id=?1")
        .bind(later.operationId)
        .first("status"),
    ).toBe("pending");
    expect((await redemption(f.pid))?.budget_generation).toBe(2);
  });
  it("a freeze between read and write creates one audit receipt, never an item change", async () => {
    const f = await setup();
    await run(f.jobs[0]!);
    const later = await register(f.pid);
    const page = await recipients(db, "i.operation_id=?1", [later.operationId]);
    await db
      .prepare("UPDATE operations SET summary_state='sealing',frozen_at=?1 WHERE operation_id=?2")
      .bind(clock.toISOString(), later.operationId)
      .run();
    await applyRecipients(db, clock.toISOString(), page);
    await applyRecipients(db, clock.toISOString(), page);
    expect(
      await db
        .prepare("SELECT status FROM operation_items WHERE operation_id=?1")
        .bind(later.operationId)
        .first("status"),
    ).toBe("pending");
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM operation_late_results WHERE operation_id=?1")
        .bind(later.operationId)
        .first("n"),
    ).toBe(1);
  });
});

describe("distribution, summaries, durable delivery and repair", () => {
  it("freezes stable membership and names and rolls back an over-cap snapshot", async () => {
    await seedPlayer(db, "1", "0", "Before", clock);
    const id = await openDistribution(db, config, "NEW", clock);
    await seedPlayer(db, "2", "0", "Later", clock);
    await db.prepare("UPDATE players SET display_name='After' WHERE player_id='1'").run();
    await expandPage(db, clock.toISOString());
    expect(
      await db
        .prepare("SELECT expected_count FROM operations WHERE operation_id=?1")
        .bind(id)
        .first("expected_count"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT display_label FROM operation_items WHERE operation_id=?1")
        .bind(id)
        .first("display_label"),
    ).toBe("Before");
    expect(await openDistribution(db, config, "NEW", clock)).toBeNull();
    await db
      .prepare(
        `INSERT INTO players(player_id,state,created_at,updated_at) SELECT CAST(value AS TEXT),'0',?1,?1 FROM json_each(?2)`,
      )
      .bind(clock.toISOString(), JSON.stringify(Array.from({ length: 2000 }, (_, i) => 100 + i)))
      .run();
    await expect(openDistribution(db, config, "OVER", clock)).rejects.toThrow(
      "distribution_not_accepted",
    );
    expect(await db.prepare("SELECT 1 FROM gift_codes WHERE code='OVER'").first()).toBeNull();
  });
  it("deadline seals unexpanded members as unfinished without reading new names", async () => {
    await seedPlayer(db, "1", "0", "Original", clock);
    await openDistribution(db, { ...config, operationDeadlineSeconds: 1 }, "NEW", clock);
    clock = new Date(clock.getTime() + 2000);
    await recover(db, config, clock.toISOString());
    await db.prepare("UPDATE players SET display_name='Changed'").run();
    await summaryPage(db, clock.toISOString());
    expect(
      await db.prepare("SELECT status,display_label FROM summary_item_snapshot").first(),
    ).toEqual({ status: "still_pending", display_label: "Original" });
    expect(await db.prepare("SELECT COUNT(*) n FROM outbox_jobs").first("n")).toBe(0);
  });
  it.each(["registration", "distribution"])(
    "zero-result %s emits one final-only footer",
    async (kind) => {
      if (kind === "registration") {
        const f = await register();
        await db
          .prepare("UPDATE operations SET summary_state='sealing' WHERE operation_id=?1")
          .bind(f.operationId)
          .run();
      } else {
        await openDistribution(db, config, "EMPTY", clock);
        await expandPage(db, clock.toISOString());
      }
      for (let i = 0; i < 3; i++) await summaryPage(db, clock.toISOString());
      const rows = (
        await db
          .prepare("SELECT * FROM discord_output_deliveries")
          .all<{ content: string; has_footer: number; chunk_total: number }>()
      ).results;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.content.split(RUNTIME_FOOTER)).toHaveLength(2);
      expect(rows[0]!.chunk_total).toBe(1);
      const sent: Request[] = [];
      await dispatchOutput(
        db,
        config,
        () => clock,
        async (req) => {
          sent.push(req);
          return Response.json({ id: "123" });
        },
      );
      expect(sent).toHaveLength(1);
      expect(await sent[0]!.json()).toMatchObject({
        allowed_mentions: { parse: [] },
        enforce_nonce: true,
      });
      expect(await db.prepare("SELECT summary_state FROM operations").first("summary_state")).toBe(
        "delivered",
      );
    },
  );
  it("validation replies are durable, disabled by default, and never carry the footer", async () => {
    const event = makeEvent({ content: "bad" });
    await acceptRegistrationEvent({
      db,
      config,
      event,
      parsed: parseRegistration(event.content, "0"),
      now: clock,
      attemptRunId: crypto.randomUUID(),
    });
    await dispatchOutput(db, config, () => clock);
    expect(
      await db.prepare("SELECT attempts FROM discord_output_deliveries").first("attempts"),
    ).toBe(0);
    await dispatchOutput(
      db,
      config,
      () => clock,
      async (req) => {
        expect(((await req.json()) as { content: string }).content).not.toContain(RUNTIME_FOOTER);
        return Response.json({ id: "42" });
      },
    );
    expect(await db.prepare("SELECT status FROM processed_events").first("status")).toBe(
      "finalized",
    );
  });
  it.each([429, 500, 401, 403, 404, 400])("classifies synthetic Discord %s", async (status) => {
    const result = await createMessage(
      async () => Response.json({ retry_after: 12.2 }, { status }),
      { channel_id: "1", content: "test", nonce: "123" },
      1,
    );
    expect(result.kind).toBe(status === 429 || status === 500 ? "retry" : "blocked");
    if (status === 429) expect(result.delay).toBe(13);
  });
  it("old outbox send/mark cannot overwrite a reopened attempt", async () => {
    const f = await setup();
    const entered = deferred<void>();
    const release = deferred<void>();
    const queue = {
      async sendBatch() {
        entered.resolve();
        await release.promise;
      },
    };
    const dispatch = dispatchOutbox({
      db,
      config,
      now: clock,
      queues: { registration: queue, distribution: queue },
      source: { kind: "scan", limit: 90 },
    });
    await entered.promise;
    await db
      .prepare(
        "UPDATE outbox_jobs SET attempt_id='new',payload_json=json_set(payload_json,'$.attempt_id','new')",
      )
      .run();
    release.resolve();
    await dispatch;
    expect(
      await db
        .prepare("SELECT status,attempt_id FROM outbox_jobs WHERE operation_id=?1")
        .bind(f.operationId)
        .first(),
    ).toEqual({ status: "pending", attempt_id: "new" });
  });
  it("frozen dead outbox creates a parked repair and only explicit repair grants work", async () => {
    const f = await setup();
    await db.prepare("UPDATE operations SET summary_state='sealing'").run();
    await db.prepare("UPDATE outbox_jobs SET status='dead'").run();
    await deadOutbox(db, clock.toISOString());
    const id = await db
      .prepare("SELECT operation_id FROM operations WHERE type='repair_run'")
      .first<string>("operation_id");
    expect(id).toBeTruthy();
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM outbox_jobs WHERE operation_id=?1")
        .bind(id)
        .first("n"),
    ).toBe(0);
    await authorizeRepair(db, config, id!, clock);
    expect(
      await db
        .prepare("SELECT COUNT(*) n FROM outbox_jobs WHERE operation_id=?1")
        .bind(id)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT summary_state FROM operations WHERE operation_id=?1")
        .bind(f.operationId)
        .first("summary_state"),
    ).toBe("sealing");
  });
  it("reapplying local migrations preserves budget and immutable observation data", async () => {
    const f = await setup();
    await run(f.jobs[0]!);
    const before = await redemption(f.pid);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect(await redemption(f.pid)).toEqual(before);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it("bounds combined handlers and never reaches global fetch", async () => {
    await setup();
    const counted = countD1(db);
    const q = new RecordingQueue();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unmatched network blocked"));
    try {
      await scheduledWork(
        {
          ...env,
          STAGING_DB: counted.db,
          REGISTRATION_JOBS_QUEUE: q as unknown as Env["REGISTRATION_JOBS_QUEUE"],
          CODE_FANOUT_JOBS_QUEUE: q as unknown as Env["CODE_FANOUT_JOBS_QUEUE"],
        },
        { now: () => clock },
      );
      expect(counted.stats.statements).toBeLessThanOrEqual(39);
      expect(counted.stats.maxBindings).toBeLessThanOrEqual(100);
      expect(q.calls.length).toBeLessThanOrEqual(8);
      const messages = q.calls
        .flat()
        .slice(0, 2)
        .map((body) => message(body));
      const consumer = countD1(db);
      await queueWork(
        { queue: "wos-rewards-registration-jobs-staging", messages },
        { ...env, STAGING_DB: consumer.db },
        { now: () => clock },
      );
      expect(consumer.stats.statements).toBeLessThanOrEqual(32);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});

/** Simulates a crash at a D1 transaction boundary without mocking SQL behavior. */
function failBatchOnce(database: D1Database, afterCommit = false): D1Database {
  let failed = false;
  return new Proxy(database, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (failed) return target.batch(statements);
          failed = true;
          if (afterCommit) await target.batch(statements);
          throw new Error("synthetic transaction interruption");
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it("Unicode summaries resume seal/layout/render atomically and overflow truthfully at 500 characters", async () => {
  const ids = Array.from({ length: 280 }, (_, i) => String(1000 + i));
  await db
    .prepare(
      "INSERT INTO players(player_id,state,display_name,created_at,updated_at) SELECT value,'0',?1,?2,?2 FROM json_each(?3)",
    )
    .bind("漢😀_*".repeat(12), clock.toISOString(), JSON.stringify(ids))
    .run();
  const id = await openDistribution(
    db,
    { ...config, discordMessageMaxLength: 500, summaryMaxChunks: 2 },
    "UNICODE",
    clock,
  );
  for (let i = 0; i < 3; i++) await expandPage(db, clock.toISOString());
  await db.prepare("UPDATE operation_items SET status='already_redeemed'").run();
  await summaryPage(db, clock.toISOString());
  await expect(summaryPage(failBatchOnce(db), clock.toISOString())).rejects.toThrow("synthetic");
  expect(await db.prepare("SELECT COUNT(*) n FROM summary_item_snapshot").first("n")).toBe(0);
  await expect(summaryPage(failBatchOnce(db, true), clock.toISOString())).rejects.toThrow(
    "synthetic",
  );
  expect(await db.prepare("SELECT COUNT(*) n FROM summary_item_snapshot").first("n")).toBe(128);
  await db.prepare("UPDATE players SET display_name='MUTATED'").run();
  for (let i = 0; i < 12; i++)
    await Promise.all([summaryPage(db, clock.toISOString()), summaryPage(db, clock.toISOString())]);
  const rows = (
    await db
      .prepare("SELECT * FROM discord_output_deliveries ORDER BY chunk_index")
      .all<{ content: string; has_footer: number; chunk_index: number; nonce: string }>()
  ).results;
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.content.length).toBeLessThanOrEqual(500);
    expect(row.content).not.toContain("MUTATED");
    expect(row.content).toContain("Applied to 280 players");
    expect(row.content).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  }
  expect(rows[0]!.has_footer).toBe(0);
  expect(rows[0]!.content).not.toContain(RUNTIME_FOOTER);
  expect(rows[1]!.content).toContain(RUNTIME_FOOTER);
  const listed = rows.reduce((n, row) => n + (row.content.match(/ — applied/g)?.length ?? 0), 0);
  expect(rows[1]!.content).toContain(`+${280 - listed} more not listed`);
  expect(
    await db
      .prepare("SELECT already_redeemed_count FROM operations WHERE operation_id=?1")
      .bind(id)
      .first("already_redeemed_count"),
  ).toBe(280);
  const before = JSON.stringify(rows);
  await summaryPage(db, clock.toISOString());
  expect(
    JSON.stringify(
      (await db.prepare("SELECT * FROM discord_output_deliveries ORDER BY chunk_index").all())
        .results,
    ),
  ).toBe(before);
});

it.each([61, 301])(
  "delivery crash repeats a stable nonce; synthetic suppression window at %s seconds",
  async (elapsed) => {
    const event = makeEvent({ content: "invalid" });
    await acceptRegistrationEvent({
      db,
      config,
      event,
      parsed: parseRegistration(event.content, "0"),
      now: clock,
      attemptRunId: crypto.randomUUID(),
    });
    const firstTime = clock.getTime();
    const sent: string[] = [];
    const created: string[] = [];
    const transport = async (req: Request) => {
      const body = (await req.json()) as { nonce: string };
      sent.push(body.nonce);
      if (!created.length || clock.getTime() - firstTime > 180000) created.push(body.nonce);
      return Response.json({ id: String(created.length) });
    };
    await expect(dispatchOutput(failBatchOnce(db), config, () => clock, transport)).rejects.toThrow(
      "synthetic",
    );
    expect(await db.prepare("SELECT status FROM discord_output_deliveries").first("status")).toBe(
      "claimed",
    );
    clock = new Date(firstTime + elapsed * 1000);
    await dispatchOutput(db, config, () => clock, transport);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(created).toHaveLength(elapsed === 61 ? 1 : 2);
    expect(await db.prepare("SELECT status FROM discord_output_deliveries").first("status")).toBe(
      "sent",
    );
  },
);

it("Discord cooldown blocks other groups and exhausted attempts require human attention", async () => {
  for (let i = 0; i < 2; i++) {
    const event = makeEvent({ content: "invalid" });
    await acceptRegistrationEvent({
      db,
      config,
      event,
      parsed: parseRegistration(event.content, "0"),
      now: clock,
      attemptRunId: crypto.randomUUID(),
    });
  }
  const transport = vi.fn(async () =>
    Response.json({ retry_after: 120.1, global: true }, { status: 429 }),
  );
  await dispatchOutput(db, { ...config, outputMaxAttempts: 1 }, () => clock, transport);
  await dispatchOutput(db, config, () => clock, transport);
  expect(transport).toHaveBeenCalledOnce();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) n FROM discord_output_deliveries WHERE blocked_at IS NOT NULL AND alerted_at IS NOT NULL",
      )
      .first("n"),
  ).toBe(1);
  clock = new Date(clock.getTime() + 122000);
  await dispatchOutput(db, config, () => clock, transport);
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each(["enqueued", "dead"])(
  "T15 state reevaluation after the last grant also recovers %s outbox work",
  async (outboxStatus) => {
    const f = await setup();
    await run(f.jobs[0]!, new MockWhiteoutProvider({ defaultOutcome: "player_ineligible" }));
    await db.prepare("UPDATE operation_items SET status='pending'").run();
    await db.prepare("UPDATE operations SET summary_state='none'").run();
    await db
      .prepare("UPDATE outbox_jobs SET status=?1,payload_json='invalid legacy payload'")
      .bind(outboxStatus)
      .run();
    await db.prepare("UPDATE redemptions SET provider_invocations=4").run();
    await db.prepare("UPDATE players SET state='9'").run();
    clock = new Date(clock.getTime() + 300000);
    await redrive(db, config, clock.toISOString());
    expect(await redemption(f.pid)).toMatchObject({
      status: "pending",
      provider_invocations: 0,
      budget_generation: 2,
      reeval_count: 1,
    });
  },
);

it("complete scheduled failure paths retain independent lane reservations", async () => {
  const f = await setup();
  const q = new RecordingQueue();
  vi.spyOn(q, "sendBatch").mockRejectedValue(new Error("synthetic send failure"));
  await db
    .prepare("UPDATE operations SET deadline_at=?1")
    .bind(new Date(clock.getTime() + 1000).toISOString())
    .run();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const measured = countD1(db);
    await scheduledWork(
      {
        ...env,
        STAGING_DB: failBatchOnce(measured.db),
        REGISTRATION_JOBS_QUEUE: q as unknown as Env["REGISTRATION_JOBS_QUEUE"],
      },
      { now: () => clock },
    );
    expect(measured.stats.statements).toBeLessThanOrEqual(39);
    expect(measured.stats.maxBindings).toBeLessThanOrEqual(100);
    expect(warning).toHaveBeenCalledWith("scheduled_lane_failed", 10);
    clock = new Date(clock.getTime() + 2000);
    await scheduledWork({ ...env, STAGING_DB: db }, { now: () => clock });
    expect(
      await db
        .prepare("SELECT state FROM operations WHERE operation_id=?1")
        .bind(f.operationId)
        .first("state"),
    ).toBe("stale_closed");
  } finally {
    warning.mockRestore();
  }
});

it("local Queue entry point carries an accepted registration through summary and synthetic delivery", async () => {
  clock = new Date();
  const f = await setup();
  // Exercise the real local producer binding, then supply its persisted body to the
  // Workers queue harness so ack/retry outcomes are observable deterministically.
  await env.REGISTRATION_JOBS_QUEUE.send(f.jobs[0]!);
  const batch = createMessageBatch("wos-rewards-registration-jobs-staging", [
    { id: "physical-local", timestamp: clock, body: f.jobs[0]!, attempts: 1 },
  ]);
  const ctx = createExecutionContext();
  await worker.queue(batch, { ...env, STAGING_DB: db });
  const result = await getQueueResult(batch, ctx);
  expect(result.retryBatch.retry).toBe(false);
  expect(result.retryMessages).toHaveLength(0);
  expect(result.explicitAcks).toContain("physical-local");
  expect((await redemption(f.pid))?.status).toBe("success");
  for (let i = 0; i < 4; i++) await summaryPage(db, clock.toISOString());
  const transport = vi.fn(async () => Response.json({ id: "999" }));
  await dispatchOutput(db, config, () => clock, transport);
  expect(transport).toHaveBeenCalledOnce();
  expect(
    await db
      .prepare("SELECT status FROM processed_events WHERE operation_id=?1")
      .bind(f.operationId)
      .first("status"),
  ).toBe("finalized");
});

it("a legacy missing lease can close a spent generation without receiving fresh grants", async () => {
  const f = await setup();
  await run(f.jobs[0]!, new MockWhiteoutProvider({ defaultOutcome: "rate_limited" }));
  await db
    .prepare(
      "UPDATE redemptions SET provider_invocations=4,invocation_expires_at=NULL,retry_due_at=NULL",
    )
    .run();
  await db.prepare("UPDATE outbox_jobs SET status='enqueued'").run();
  clock = new Date(clock.getTime() + 300000);
  await redrive(db, config, clock.toISOString());
  expect(await redemption(f.pid)).toMatchObject({
    status: "retry_exhausted",
    provider_invocations: 4,
    budget_generation: 1,
  });
});

it("registration and distribution contention shares one provider result and completes both items", async () => {
  await seedPlayer(db, "001", "0", "One", clock);
  const distribution = await openDistribution(db, config, "CODE", clock);
  await expandPage(db, clock.toISOString());
  const reg = await register("001");
  const body = JSON.parse(
    (await db
      .prepare("SELECT payload_json FROM outbox_jobs WHERE operation_id=?1")
      .bind(distribution)
      .first<string>("payload_json"))!,
  ) as RedemptionJobBody;
  const provider = new MockWhiteoutProvider();
  const latch = deferred<RedeemResult>();
  const entered = deferred<void>();
  vi.spyOn(provider, "redeem").mockImplementation(() => {
    entered.resolve();
    return latch.promise;
  });
  const first = run(body, provider, "distribution");
  await entered.promise;
  await run(reg.jobs[0]!, provider);
  latch.resolve({ outcome: "success" });
  await first;
  await reuseTerminal(db, clock.toISOString());
  expect(provider.redeem).toHaveBeenCalledOnce();
  expect(
    await db.prepare("SELECT COUNT(*) n FROM operation_items WHERE status='success'").first("n"),
  ).toBe(2);
});

it("byte-limited seal pages preserve all large-code items without oversized JSON mutation parameters", async () => {
  const codes = Array.from({ length: 40 }, (_, i) => `${i}-` + "漢".repeat(10000));
  await seedCodes(db, codes, clock);
  await register();
  await db
    .prepare("UPDATE operation_items SET status='permanent_failure',reason_code='code_invalid'")
    .run();
  await summaryPage(db, clock.toISOString());
  const measured = countD1(db);
  await summaryPage(measured.db, clock.toISOString());
  const firstPage = await db
    .prepare("SELECT COUNT(*) n FROM summary_item_snapshot")
    .first<number>("n");
  expect(firstPage).toBeGreaterThan(0);
  expect(firstPage).toBeLessThan(40);
  expect(await db.prepare("SELECT summary_state FROM operations").first("summary_state")).toBe(
    "sealing",
  );
  for (const stmt of measured.stats.prepared)
    for (const bind of stmt.bindings)
      if (typeof bind === "string")
        expect(new TextEncoder().encode(bind).length).toBeLessThan(262144);
  for (let i = 0; i < 12; i++) await summaryPage(db, clock.toISOString());
  expect(await db.prepare("SELECT COUNT(*) n FROM summary_item_snapshot").first("n")).toBe(40);
  expect(
    await db
      .prepare("SELECT MAX(length(sort_key)) n FROM summary_item_snapshot")
      .first<number>("n"),
  ).toBeLessThan(110);
  expect(await db.prepare("SELECT summary_state FROM operations").first("summary_state")).toBe(
    "built",
  );
});

it("only explicit T14 authorization replenishes an exhausted pair, once per repair request", async () => {
  const f = await setup();
  const provider = new MockWhiteoutProvider({ defaultOutcome: "rate_limited" });
  for (let i = 0; i < 4; i++) {
    await run(f.jobs[0]!, provider);
    const r = await redemption(f.pid);
    if (r?.retry_due_at) clock = new Date(r.retry_due_at as string);
  }
  const original = await db
    .prepare("SELECT * FROM operations WHERE operation_id=?1")
    .bind(f.operationId)
    .first();
  const id = await openRepairRun(db, config, "operator-request", f.pid, "CODE", clock);
  expect(id).toBeTruthy();
  for (let i = 0; i < 4; i++) await recover(db, config, clock.toISOString());
  expect((await redemption(f.pid))?.budget_generation).toBe(1);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM outbox_jobs WHERE operation_id=?1")
      .bind(id)
      .first("n"),
  ).toBe(0);
  await authorizeRepair(db, config, id!, clock);
  await authorizeRepair(db, config, id!, clock);
  expect(await redemption(f.pid)).toMatchObject({
    status: "pending",
    budget_generation: 2,
    provider_invocations: 0,
  });
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM outbox_jobs WHERE operation_id=?1")
      .bind(id)
      .first("n"),
  ).toBe(1);
  expect(
    await db.prepare("SELECT * FROM operations WHERE operation_id=?1").bind(f.operationId).first(),
  ).toEqual(original);
});

import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { acceptRegistrationEvent } from "../src/ingest/acceptance";
import { parseRegistration } from "../src/ingest/registration-parser";
import { consume, consumeDlq, type Delivery } from "../src/redemption/consumer";
import { reuseTerminal } from "../src/redemption/reconcile";
import {
  authorizeRepair,
  deadOutbox,
  openRepairRun,
  recover,
  redrive,
} from "../src/operations/recovery";
import { expandPage, openDistribution } from "../src/operations/distribution";
import { summaryPage, RUNTIME_FOOTER } from "../src/operations/summary";
import { MockWhiteoutProvider, isReplaySafeMock } from "../src/providers/mock-whiteout-provider";
import { countD1, makeEvent, seedCodes, testConfig, uniqueId } from "./support/fixtures";
import type { RedemptionJobBody } from "../src/domain/queue-jobs";
import type { RedeemResult, WhiteoutProvider } from "../src/domain/whiteout-provider";

const db = env.PHASE4_DB;
const config = testConfig();
let clock: Date;
beforeEach(async () => {
  clock = new Date("2026-09-18T00:00:00.000Z");
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
async function register(pid = uniqueId(), state = "0") {
  const event = makeEvent({
    content: `${pid} ${state} Synthetic`,
    created_at: clock.toISOString(),
  });
  const result = await acceptRegistrationEvent({
    db,
    config,
    event,
    parsed: parseRegistration(event.content, "0"),
    acceptanceClass: "normal",
    now: clock,
    attemptRunId: crypto.randomUUID(),
  });
  if (result.kind !== "accepted_valid") throw new Error("fixture registration");
  const rows = (
    await db
      .prepare("SELECT payload_json FROM outbox_jobs WHERE operation_id=?1 ORDER BY item_key")
      .bind(result.operationId)
      .all<{ payload_json: string }>()
  ).results;
  return {
    pid,
    operationId: result.operationId,
    jobs: rows.map((r) => JSON.parse(r.payload_json) as RedemptionJobBody),
  };
}
async function setup() {
  await seedCodes(db, ["SYNTHETIC"], clock);
  return register();
}
async function row(pid: string) {
  return db
    .prepare("SELECT * FROM redemptions WHERE player_id=?1 AND code='SYNTHETIC'")
    .bind(pid)
    .first<Record<string, unknown>>();
}
async function run(
  job: RedemptionJobBody,
  provider: WhiteoutProvider,
  database = db,
  timeout = config.providerTimeoutSeconds,
) {
  const m = message(job);
  const counted = countD1(database);
  await consume(m, job.job_id.startsWith("registration:") ? "registration" : "distribution", {
    db: counted.db,
    config: { ...config, providerTimeoutSeconds: timeout },
    provider,
    now: () => clock,
  });
  expect(counted.stats.statements).toBeLessThanOrEqual(16);
  expect(counted.stats.maxBindings).toBeLessThanOrEqual(100);
  return m;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Fault injection wraps the actual local D1 transaction; no claim/result SQL is mocked.
function faultBatch(at: number, afterCommit = false) {
  let batches = 0;
  return new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          batches++;
          if (batches === at && !afterCommit) throw new Error("synthetic persistence loss");
          const result = await target.batch(statements);
          if (batches === at) throw new Error("synthetic process loss after commit");
          return result;
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it.each(["explicit", "exception", "timeout"])(
  "holds %s uncertainty before ack; restart and all reopen routes cannot replay",
  async (kind) => {
    const f = await setup();
    const late = deferred<RedeemResult>();
    const provider = {
      redeem: vi.fn(async (): Promise<RedeemResult> => {
        // Synthetic application occurred; its response may be lost.
        if (kind === "exception") throw new Error("synthetic lost response");
        if (kind === "timeout") return late.promise;
        return { outcome: "uncertain", reasonCode: "outcome_uncertain" };
      }),
    };
    const m = await run(f.jobs[0]!, provider, db, 0.001);
    expect(m.ack).toHaveBeenCalledOnce();
    expect(m.retry).not.toHaveBeenCalled();
    const held = await row(f.pid);
    expect(held).toMatchObject({
      status: "permanent_failure",
      reason_code: "outcome_uncertain",
      provider_receipt: null,
      provider_invocations: 1,
      budget_generation: 1,
      dispatch_hold_generation: 1,
    });
    expect(held?.dispatch_hold_token).toEqual(expect.any(String));
    late.resolve({ outcome: "success", providerReceipt: "synthetic-late" });
    await Promise.resolve();
    clock = new Date(clock.getTime() + 400_000);
    for (let n = 0; n < 3; n++) {
      await run(f.jobs[0]!, provider);
      await redrive(db, config, clock.toISOString());
      await consumeDlq(message(f.jobs[0]), { db, now: () => clock });
    }
    await db.prepare("UPDATE outbox_jobs SET status='dead'").run();
    await deadOutbox(db, clock.toISOString());
    expect(
      await openRepairRun(db, config, "synthetic-repair", f.pid, "SYNTHETIC", clock),
    ).toBeNull();
    const again = await register(f.pid, "99");
    await run(again.jobs[0]!, provider);
    await authorizeRepair(db, config, again.operationId, clock, true);
    expect(await row(f.pid)).toEqual(held);
    expect(provider.redeem).toHaveBeenCalledOnce();
    // Unrelated pairs remain runnable even with mock configuration and an injected provider.
    const other = await register();
    await run(other.jobs[0]!, { redeem: async () => ({ outcome: "success" }) });
    expect((await row(other.pid))?.status).toBe("success");
  },
);

it.each(["grant-commit", "result-before", "result-after"])(
  "recovers %s persistence/process loss conservatively",
  async (phase) => {
    const f = await setup();
    const provider = {
      redeem: vi.fn(async (): Promise<RedeemResult> => ({
        outcome: "success",
        providerReceipt: "synthetic-receipt",
      })),
    };
    const m = await run(
      f.jobs[0]!,
      provider,
      faultBatch(phase === "grant-commit" ? 1 : 2, phase !== "result-before"),
    );
    expect(m.retry).toHaveBeenCalledOnce();
    expect(m.ack).not.toHaveBeenCalled();
    expect(provider.redeem).toHaveBeenCalledTimes(phase === "grant-commit" ? 0 : 1);
    const restart = { redeem: vi.fn(async (): Promise<RedeemResult> => ({ outcome: "success" })) };
    await run(f.jobs[0]!, restart);
    clock = new Date(clock.getTime() + 400_000);
    await run(f.jobs[0]!, restart);
    await redrive(db, config, clock.toISOString());
    await consumeDlq(message(f.jobs[0]), { db, now: () => clock });
    expect(restart.redeem).not.toHaveBeenCalled();
    expect((await row(f.pid))?.reason_code).toBe(
      phase === "result-after" ? null : "outcome_uncertain",
    );
    expect((await row(f.pid))?.provider_receipt).toBe(
      phase === "result-after" ? "synthetic-receipt" : null,
    );
  },
);

it.each(["redelivery", "sweeper", "dlq"])(
  "%s resolves an expired possible dispatch into a hold and fences its late result",
  async (route) => {
    const f = await setup();
    const result = deferred<RedeemResult>();
    const started = deferred<void>();
    const provider = {
      redeem: vi.fn(() => {
        started.resolve();
        return result.promise;
      }),
    };
    const pending = run(f.jobs[0]!, provider);
    await started.promise;
    const grant = await row(f.pid);
    expect(grant?.dispatch_hold_token).toBe(grant?.current_invocation_token);
    const otherOp = await register(f.pid);
    await run(otherOp.jobs[0]!, provider);
    await run(f.jobs[0]!, provider);
    expect(provider.redeem).toHaveBeenCalledOnce();
    clock = new Date(clock.getTime() + 400_000);
    if (route === "redelivery") await run(f.jobs[0]!, provider);
    if (route === "sweeper") {
      const counted = countD1(db);
      await redrive(counted.db, config, clock.toISOString());
      expect(counted.stats.statements).toBeLessThanOrEqual(6);
      expect([f.operationId, otherOp.operationId]).toContain(
        await db
          .prepare("SELECT cursor FROM scheduler_progress WHERE lane='redrive'")
          .first("cursor"),
      );
    }
    if (route === "dlq") await consumeDlq(message(f.jobs[0]), { db, now: () => clock });
    const held = await row(f.pid);
    expect(held?.reason_code).toBe("outcome_uncertain");
    result.resolve({ outcome: "success", providerReceipt: "synthetic-too-late" });
    await pending;
    expect(await row(f.pid)).toEqual(held);
    expect(provider.redeem).toHaveBeenCalledOnce();
  },
);

it("an exact conclusive result may settle after lease expiry before local uncertainty finalization", async () => {
  const f = await setup();
  await run(f.jobs[0]!, {
    redeem: async () => {
      clock = new Date(clock.getTime() + 400_000);
      return { outcome: "success", providerReceipt: "synthetic-current" };
    },
  });
  expect(await row(f.pid)).toMatchObject({
    status: "success",
    dispatch_hold_token: null,
    provider_receipt: "synthetic-current",
  });
});

it("a newer generation fences the old result even if attempt and token were retained", async () => {
  const f = await setup();
  await run(f.jobs[0]!, {
    redeem: async () => {
      // Simulate a future authorized reconciliation's generation change, not a runtime API.
      await db.prepare("UPDATE redemptions SET budget_generation=budget_generation+1").run();
      return { outcome: "success" };
    },
  });
  expect(await row(f.pid)).toMatchObject({
    status: "in_progress",
    provider_receipt: null,
    budget_generation: 2,
    dispatch_hold_generation: 1,
  });
});

it("reports uncertainty separately, reuses it across distribution, and preserves frozen evidence", async () => {
  const registered = await register();
  const op = await openDistribution(db, config, "SYNTHETIC", clock);
  await expandPage(db, clock.toISOString());
  const job = JSON.parse(
    (await db
      .prepare("SELECT payload_json FROM outbox_jobs WHERE operation_id=?1")
      .bind(op)
      .first<string>("payload_json"))!,
  ) as RedemptionJobBody;
  const provider = {
    redeem: vi.fn(async (): Promise<RedeemResult> => ({
      outcome: "uncertain",
      reasonCode: "outcome_uncertain",
    })),
  };
  await run(job, provider);
  expect(await openDistribution(db, config, "SYNTHETIC", clock)).toBeNull();
  const repeat = await register(registered.pid, "9");
  await run(repeat.jobs[0]!, provider);
  await reuseTerminal(db, clock.toISOString());
  for (let n = 0; n < 30; n++) await summaryPage(db, clock.toISOString());
  const operation = await db
    .prepare("SELECT * FROM operations WHERE operation_id=?1")
    .bind(op)
    .first();
  expect(operation).toMatchObject({
    uncertain_count: 1,
    success_count: 0,
    already_redeemed_count: 0,
    permanent_failure_count: 0,
    retry_exhausted_count: 0,
    completed_count: 1,
  });
  const outputs = (
    await db
      .prepare("SELECT content,has_footer FROM discord_output_deliveries WHERE operation_id=?1")
      .bind(op)
      .all<{ content: string; has_footer: number }>()
  ).results;
  expect(outputs.length).toBeGreaterThan(0);
  expect(outputs[0]!.content).toContain("0 failed; 1 need verification; 0 unfinished");
  expect(outputs[0]!.content).toContain("verification needed");
  expect(outputs.filter((o) => o.has_footer).length).toBe(1);
  expect(
    outputs
      .map((o) => o.content)
      .join("")
      .split(RUNTIME_FOOTER).length,
  ).toBe(2);
  expect(outputs.every((o) => o.content.length <= config.discordMessageMaxLength)).toBe(true);
  expect(provider.redeem).toHaveBeenCalledOnce();
});

it("a crash discovered after deadline produces an audit and leaves the frozen unfinished summary intact", async () => {
  const f = await setup();
  await run(f.jobs[0]!, { redeem: async () => ({ outcome: "success" }) }, faultBatch(2));
  clock = new Date(clock.getTime() + (config.operationDeadlineSeconds + 1) * 1000);
  await recover(db, config, clock.toISOString());
  const frozen = await db.prepare("SELECT * FROM operation_items").first();
  await redrive(db, config, clock.toISOString());
  await reuseTerminal(db, clock.toISOString());
  expect(await db.prepare("SELECT * FROM operation_items").first()).toEqual(frozen);
  expect(
    await db.prepare("SELECT reason_code FROM operation_late_results").first("reason_code"),
  ).toBe("outcome_uncertain");
  for (let n = 0; n < 8; n++) await summaryPage(db, clock.toISOString());
  expect(await db.prepare("SELECT status FROM summary_item_snapshot").first("status")).toBe(
    "still_pending",
  );
  const snapshot = await db.prepare("SELECT * FROM summary_item_snapshot").first();
  await run(f.jobs[0]!, new MockWhiteoutProvider());
  expect(await db.prepare("SELECT * FROM summary_item_snapshot").first()).toEqual(snapshot);
});

it("only the unmodified network-free mock permits crash replay; explicit safe retry results retain their budget", async () => {
  expect(isReplaySafeMock(new MockWhiteoutProvider())).toBe(true);
  const overridden = new MockWhiteoutProvider();
  vi.spyOn(overridden, "redeem");
  expect(isReplaySafeMock(overridden)).toBe(false);
  class Derived extends MockWhiteoutProvider {}
  expect(isReplaySafeMock(new Derived())).toBe(false);
  const f = await setup();
  await run(f.jobs[0]!, new MockWhiteoutProvider(), faultBatch(1, true));
  expect((await row(f.pid))?.dispatch_hold_token).toBeNull();
  clock = new Date(clock.getTime() + 400_000);
  await run(f.jobs[0]!, new MockWhiteoutProvider());
  expect(await row(f.pid)).toMatchObject({ status: "success", provider_invocations: 2 });
  const retry = await register();
  const provider = {
    redeem: vi.fn(async (): Promise<RedeemResult> => ({
      outcome: "retryable",
      reasonCode: "provider_rate_limited",
    })),
  };
  for (let n = 0; n < config.providerMaxInvocations; n++) {
    await run(retry.jobs[0]!, provider);
    const r = await row(retry.pid);
    expect(r?.dispatch_hold_token).toBeNull();
    if (r?.retry_due_at) clock = new Date(r.retry_due_at as string);
  }
  expect(await row(retry.pid)).toMatchObject({
    status: "retry_exhausted",
    provider_invocations: config.providerMaxInvocations,
  });
});

it("a parked repair cannot reset a hold acquired by a later state reevaluation", async () => {
  const f = await setup();
  await run(f.jobs[0]!, new MockWhiteoutProvider({ defaultOutcome: "player_ineligible" }));
  const repair = await openRepairRun(
    db,
    config,
    "parked-before-uncertainty",
    f.pid,
    "SYNTHETIC",
    clock,
  );
  expect(repair).not.toBeNull();
  const next = await register(f.pid, "1");
  const provider = {
    redeem: vi.fn(async (): Promise<RedeemResult> => ({
      outcome: "uncertain",
      reasonCode: "outcome_uncertain",
    })),
  };
  await run(next.jobs[0]!, provider);
  const held = await row(f.pid);
  await authorizeRepair(db, config, repair!, clock, true);
  expect(await row(f.pid)).toEqual(held);
  expect(
    await db
      .prepare("SELECT repair_authorized_at FROM operations WHERE operation_id=?1")
      .bind(repair)
      .first("repair_authorized_at"),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM outbox_jobs WHERE operation_id=?1")
      .bind(repair)
      .first("n"),
  ).toBe(0);
});

it("failed uncertain-result persistence keeps dispatch evidence and requires no further call", async () => {
  const f = await setup();
  const provider = {
    redeem: vi.fn(async (): Promise<RedeemResult> => ({
      outcome: "uncertain",
      reasonCode: "outcome_uncertain",
    })),
  };
  const m = await run(f.jobs[0]!, provider, faultBatch(2));
  expect(m.retry).toHaveBeenCalledOnce();
  expect(await row(f.pid)).toMatchObject({
    status: "in_progress",
    provider_invocations: 1,
    dispatch_hold_generation: 1,
  });
  clock = new Date(clock.getTime() + 400_000);
  await redrive(db, config, clock.toISOString());
  await run(f.jobs[0]!, provider);
  expect(provider.redeem).toHaveBeenCalledOnce();
  expect((await row(f.pid))?.reason_code).toBe("outcome_uncertain");
});

it("a hold acquired after dead-outbox selection prevents a false failure audit and repair creation", async () => {
  const f = await setup();
  const active = await register(f.pid);
  await db
    .prepare(
      "UPDATE operations SET summary_state='sealing',state='stale_closed',frozen_at=?2 WHERE operation_id=?1",
    )
    .bind(f.operationId, clock.toISOString())
    .run();
  await db
    .prepare("UPDATE outbox_jobs SET status='dead' WHERE operation_id=?1")
    .bind(f.operationId)
    .run();
  let intercepted = false;
  const interleaved = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!intercepted) {
            intercepted = true;
            await run(active.jobs[0]!, {
              redeem: async () => ({ outcome: "uncertain", reasonCode: "outcome_uncertain" }),
            });
          }
          return target.batch(statements);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await deadOutbox(interleaved, clock.toISOString());
  expect(intercepted).toBe(true);
  expect(
    await db.prepare("SELECT COUNT(*) n FROM operations WHERE type='repair_run'").first("n"),
  ).toBe(0);
  expect(
    await db
      .prepare("SELECT COUNT(*) n FROM operation_late_results WHERE reason_code='outbox_dead'")
      .first("n"),
  ).toBe(0);
  expect((await row(f.pid))?.reason_code).toBe("outcome_uncertain");
});

it("invokes the exact mock implementation checked before the durable grant", async () => {
  const f = await setup();
  const provider = new MockWhiteoutProvider();
  const replacement = vi.fn(async (): Promise<RedeemResult> => ({
    outcome: "uncertain",
    reasonCode: "outcome_uncertain",
  }));
  const interleaved = new Proxy(db, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const result = await target.batch(statements);
          provider.redeem = replacement;
          return result;
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await run(f.jobs[0]!, provider, interleaved);
  expect(replacement).not.toHaveBeenCalled();
  expect((await row(f.pid))?.status).toBe("success");
});

it.each(["pending", "retry_wait"])(
  "recovers legacy charged %s work retained by migration without replay",
  async (status) => {
    const f = await setup();
    await run(f.jobs[0]!, { redeem: async () => ({ outcome: "success" }) }, faultBatch(1, true));
    // The additive upgrade retains these physical states and records a hold; no legacy
    // outcome or safe-retry provenance is invented. Exercise their real recovery path.
    await db
      .prepare(
        "UPDATE redemptions SET status=?1,current_invocation_token=NULL,dispatch_hold_token='legacy-unattributed'",
      )
      .bind(status)
      .run();
    clock = new Date(clock.getTime() + 400_000);
    await redrive(db, config, clock.toISOString());
    const provider = { redeem: vi.fn(async (): Promise<RedeemResult> => ({ outcome: "success" })) };
    await run(f.jobs[0]!, provider);
    expect(provider.redeem).not.toHaveBeenCalled();
    expect(await row(f.pid)).toMatchObject({
      status: "permanent_failure",
      reason_code: "outcome_uncertain",
      provider_invocations: 1,
    });
  },
);

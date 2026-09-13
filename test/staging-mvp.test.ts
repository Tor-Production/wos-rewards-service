import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { ManualCodeCommandEvent } from "../src/manual-code/types";
import { queueWork, scheduledWork } from "../src/runtime/handlers";
import type { Delivery } from "../src/redemption/consumer";
import { ingestRequest, makeEvent, RecordingQueue, uniqueId } from "./support/fixtures";

describe("local staging MVP vertical slice", () => {
  it("registers one human, runs one manual mock distribution, and emits safe Discord output", async () => {
    const clock = new Date();
    const playerId = uniqueId();
    const registration = makeEvent({
      content: `${playerId} 7 MVP Player`,
      created_at: clock.toISOString(),
    });
    const registered = await worker.fetch(
      ingestRequest(registration),
      env,
      createExecutionContext(),
    );
    expect(await registered.json()).toEqual({ status: "accepted" });
    expect(
      await env.STAGING_DB.prepare("SELECT state,display_name FROM players WHERE player_id=?1")
        .bind(playerId)
        .first(),
    ).toEqual({ state: "7", display_name: "MVP Player" });

    const adminId = uniqueId();
    const command: ManualCodeCommandEvent = {
      event_id: uniqueId(),
      guild_id: env.DISCORD_GUILD_ID,
      channel_id: env.DISCORD_MVP_ADMIN_CHANNEL_ID,
      author_id: adminId,
      author_is_bot: false,
      author_is_system: false,
      webhook_id: null,
      application_id: null,
      code: `STAGE09_${uniqueId()}`,
      created_at: clock.toISOString(),
    };
    const runtimeEnv = {
      ...env,
      DISCORD_MVP_ADMIN_USER_ALLOWLIST: adminId,
    } as unknown as Env;
    const opened = await worker.fetch(
      new Request("https://synthetic.invalid/manual-code", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.INGESTION_SHARED_SECRET}`,
        },
        body: JSON.stringify(command),
      }),
      runtimeEnv,
      createExecutionContext(),
    );
    expect(await opened.json()).toEqual({ status: "accepted" });
    const operationId = await env.STAGING_DB.prepare(
      "SELECT operation_id FROM manual_code_commands WHERE event_id=?1",
    )
      .bind(command.event_id)
      .first<string>("operation_id");
    expect(operationId).toBeTruthy();

    const queue = new RecordingQueue();
    const queuedEnv = {
      ...runtimeEnv,
      REGISTRATION_JOBS_QUEUE: queue as unknown as Env["REGISTRATION_JOBS_QUEUE"],
      CODE_FANOUT_JOBS_QUEUE: queue as unknown as Env["CODE_FANOUT_JOBS_QUEUE"],
    };
    await scheduledWork(queuedEnv, {
      now: () => clock,
      transport: async () => Response.json({ id: "1" }),
    });
    const body = queue.bodies.find((candidate) => candidate.operation_id === operationId);
    expect(body).toBeTruthy();
    const delivery: Delivery = {
      body: body!,
      ack: vi.fn<Delivery["ack"]>(),
      retry: vi.fn<Delivery["retry"]>(),
    };
    await queueWork(
      { queue: "wos-rewards-code-fanout-jobs-staging", messages: [delivery] },
      runtimeEnv,
      { now: () => clock },
    );
    expect(delivery.ack).toHaveBeenCalledOnce();

    const output: Array<Record<string, unknown>> = [];
    const transport = async (request: Request): Promise<Response> => {
      output.push((await request.json()) as Record<string, unknown>);
      return Response.json({ id: String(900000000000000000n + BigInt(output.length)) });
    };
    for (let pass = 0; pass < 20; pass++)
      await scheduledWork(queuedEnv, { now: () => clock, transport });

    expect(
      await env.STAGING_DB.prepare("SELECT status FROM redemptions WHERE player_id=?1 AND code=?2")
        .bind(playerId, command.code)
        .first("status"),
    ).toBe("success");
    expect(
      await env.STAGING_DB.prepare("SELECT summary_state FROM operations WHERE operation_id=?1")
        .bind(operationId)
        .first("summary_state"),
    ).toBe("delivered");
    const renderedCode = command.code.replaceAll("_", "\\_");
    const summary = output.find((entry) => String(entry.content).includes(`Code ${renderedCode}`));
    expect(summary).toMatchObject({
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
    });
    expect(String(summary?.content)).toContain("Applied to 1 players");
  });
});

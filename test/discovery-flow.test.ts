import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { queueWork, scheduledWork } from "../src/runtime/handlers";
import type { Delivery } from "../src/redemption/consumer";
import { RecordingQueue, seedPlayer } from "./support/fixtures";
import { discoveryEnv, followEvent, followId, sendDiscovery } from "./support/discovery";
import { parseFollowContent } from "../shared/discord-follow";

it("runs offline Follow -> D1 -> outbox -> Queue -> mock -> sanitized admin summary with one footer", async () => {
  const now = new Date();
  const player = followId();
  await seedPlayer(env.STAGING_DB, player, "7", "@everyone <@123> Frost");
  const event = followEvent({ created_at: now.toISOString() });
  const code = parseFollowContent(event.content)!.code;
  expect(await (await sendDiscovery(event)).json()).toEqual({ status: "accepted" });
  expect(await (await sendDiscovery(event)).json()).toEqual({ status: "duplicate" });
  const operationId = await env.STAGING_DB.prepare(
    "SELECT operation_id FROM discovered_code_events WHERE event_id=?1",
  )
    .bind(event.event_id)
    .first<string>("operation_id");
  const queue = new RecordingQueue();
  const runtime = discoveryEnv({ REGISTRATION_JOBS_QUEUE: queue, CODE_FANOUT_JOBS_QUEUE: queue });
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const transport = async (request: Request) => {
    sent.push({ url: request.url, body: (await request.json()) as Record<string, unknown> });
    return Response.json({ id: String(900000000000000000n + BigInt(sent.length)) });
  };
  await scheduledWork(runtime, { now: () => now, transport });
  expect(queue.bodies).toHaveLength(1);
  const delivery: Delivery = {
    body: queue.bodies[0]!,
    ack: vi.fn<Delivery["ack"]>(),
    retry: vi.fn<Delivery["retry"]>(),
  };
  await queueWork(
    { queue: "wos-rewards-code-fanout-jobs-staging", messages: [delivery] },
    runtime,
    { now: () => now },
  );
  expect(delivery.ack).toHaveBeenCalledOnce();
  for (let i = 0; i < 20; i++) await scheduledWork(runtime, { now: () => now, transport });
  expect(
    await env.STAGING_DB.prepare("SELECT status FROM redemptions WHERE player_id=?1 AND code=?2")
      .bind(player, code)
      .first("status"),
  ).toBe("success");
  expect(
    await env.STAGING_DB.prepare("SELECT summary_state FROM operations WHERE operation_id=?1")
      .bind(operationId)
      .first("summary_state"),
  ).toBe("delivered");
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toContain(`/channels/${env.DISCORD_MVP_ADMIN_CHANNEL_ID}/messages`);
  expect(sent[0]!.body).toMatchObject({ enforce_nonce: true, allowed_mentions: { parse: [] } });
  const text = String(sent[0]!.body.content);
  expect(text).toContain("Applied to 1 players");
  expect(text.split("ℹ️ To add yourself to automatic reward distribution")).toHaveLength(2);
  expect(text).not.toContain("<@123>");
  expect(text).not.toContain("February 29");
});

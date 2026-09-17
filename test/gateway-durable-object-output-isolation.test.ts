import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { dispatchOutput } from "../src/discord/delivery";
import { testConfig, uniqueId } from "./support/fixtures";
import {
  SPIKE_SENDER,
  LocalClock,
  LocalSocketFactory,
  configureAndReady,
  dispatch,
  inObject,
  localStub,
  message,
} from "./support/local-gateway";

describe("local Gateway output isolation", () => {
  it("delivers only a coexisting normal validation reply while immutable spike evidence stays suppressed", async () => {
    const stub = localStub(`output-isolation-${uniqueId()}`);
    const clock = new LocalClock();
    const factory = new LocalSocketFactory();
    const socket = await configureAndReady(stub, clock, factory);
    const spikeEventId = uniqueId();
    const validEventId = uniqueId();
    const invalidEventId = uniqueId();
    const playerId = uniqueId();
    const spike = message(spikeEventId, `SPIKE-LOCAL-${uniqueId()}`, {
      author: { id: SPIKE_SENDER, bot: true, system: false },
    });

    await inObject(stub, async () => {
      await socket.callbacks.text(dispatch("MESSAGE_CREATE", 17, spike));
      await socket.callbacks.text(dispatch("MESSAGE_CREATE", 18, spike));
      await socket.callbacks.text(
        dispatch("MESSAGE_CREATE", 19, message(validEventId, `${playerId} 42 Human Player`)),
      );
      await socket.callbacks.text(
        dispatch("MESSAGE_CREATE", 20, message(invalidEventId, "not-a-player-id")),
      );
    });

    expect((await inObject(stub, (instance) => instance.inspectForLocalTest())).checkpoint).toBe(
      20,
    );
    expect(
      await env.STAGING_DB.prepare("SELECT state,display_name FROM players WHERE player_id=?1")
        .bind(playerId)
        .first(),
    ).toEqual({ state: "42", display_name: "Human Player" });

    const messageId = uniqueId();
    const transport = vi.fn(async (request: Request) => {
      const body: unknown = await request.clone().json();
      expect(body).toMatchObject({
        content: expect.stringContaining("PLAYER_ID must contain digits only."),
        allowed_mentions: { parse: [] },
      });
      return new Response(JSON.stringify({ id: messageId }));
    });
    await dispatchOutput(env.STAGING_DB, testConfig(), () => new Date(clock.now), transport);

    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      await env.STAGING_DB.prepare(
        `SELECT e.acceptance_class,e.status,e.outcome,d.status AS output_status,
                d.dispatch_eligible,d.permanent_dispatch_block,d.attempts,d.discord_message_id
         FROM processed_events e JOIN discord_output_deliveries d ON d.event_id=e.event_id
         WHERE e.event_id=?1`,
      )
        .bind(invalidEventId)
        .first(),
    ).toEqual({
      acceptance_class: "normal",
      status: "finalized",
      outcome: "invalid",
      output_status: "sent",
      dispatch_eligible: 1,
      permanent_dispatch_block: 0,
      attempts: 1,
      discord_message_id: messageId,
    });
    expect(
      await env.STAGING_DB.prepare(
        `SELECT e.acceptance_class,e.status,e.outcome,d.status AS output_status,
                d.dispatch_eligible,d.permanent_dispatch_block,d.attempts,d.discord_message_id
         FROM processed_events e JOIN discord_output_deliveries d ON d.event_id=e.event_id
         WHERE e.event_id=?1`,
      )
        .bind(spikeEventId)
        .first(),
    ).toEqual({
      acceptance_class: "staging_spike",
      status: "finalized",
      outcome: "invalid",
      output_status: "superseded",
      dispatch_eligible: 0,
      permanent_dispatch_block: 1,
      attempts: 0,
      discord_message_id: null,
    });
  });
});

import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  DiscordEventSource,
  IngestAcknowledgement,
  RegistrationMessageEvent,
} from "../src/domain/discord-event";
import { ingestRequest, makeEvent } from "./support/fixtures";

class TestEventSource implements DiscordEventSource {
  async forward(event: RegistrationMessageEvent): Promise<IngestAcknowledgement> {
    const response = await exports.default.fetch(ingestRequest(event));
    const result = await response.json<{ status: IngestAcknowledgement }>();
    return result.status;
  }
}

describe("ADR-neutral event source contract", () => {
  it("forwards raw invalid content through the wire contract and returns its acknowledgement", async () => {
    const event = makeEvent({
      content: "raw invalid business syntax",
    }) satisfies RegistrationMessageEvent;
    const source: DiscordEventSource = new TestEventSource();
    expect(await source.forward(event)).toBe("accepted");
    expect(await source.forward(event)).toBe("duplicate");
    // @ts-expect-error The forwarding method is required, not an empty marker interface.
    const missing: DiscordEventSource = {};
    expect(missing).toEqual({});
    const keys: Record<keyof RegistrationMessageEvent, true> = {
      event_id: true,
      guild_id: true,
      channel_id: true,
      author_id: true,
      author_is_bot: true,
      author_is_system: true,
      webhook_id: true,
      application_id: true,
      content: true,
      created_at: true,
    };
    expect(Object.keys(event).sort()).toEqual(Object.keys(keys).sort());
  });
});

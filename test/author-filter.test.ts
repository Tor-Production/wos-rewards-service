import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  classifyAcceptedAuthor,
  shouldAcceptAuthor,
  type AcceptanceClass,
} from "../src/ingest/author-filter";
import type { RegistrationMessageEvent } from "../src/domain/discord-event";
import { countD1, ingestRequest, makeEvent, testConfig, uniqueId } from "./support/fixtures";

describe("author and channel filter", () => {
  const author = uniqueId();
  const webhook = uniqueId();
  const cases: [string, Partial<RegistrationMessageEvent>, string[], AcceptanceClass | null][] = [
    ["user", {}, [], "normal"],
    ["listed human identifier", {}, [author], "normal"],
    ["bot", { author_is_bot: true }, [], null],
    ["system", { author_is_system: true }, [], null],
    ["webhook", { webhook_id: webhook }, [], null],
    ["own author", { author_id: env.DISCORD_APPLICATION_ID }, [], null],
    ["own app", { application_id: env.DISCORD_APPLICATION_ID }, [], null],
    ["listed bot", { author_is_bot: true }, [author], "staging_spike"],
    ["listed webhook", { webhook_id: webhook }, [webhook], "staging_spike"],
    [
      "webhook cannot match only its author id",
      { author_is_bot: true, webhook_id: webhook },
      [author],
      null,
    ],
    ["listed system", { author_is_system: true }, [author], null],
    ["listed system bot", { author_is_system: true, author_is_bot: true }, [author], null],
    ["listed system webhook", { author_is_system: true, webhook_id: webhook }, [webhook], null],
    [
      "listed own author",
      { author_id: env.DISCORD_APPLICATION_ID },
      [env.DISCORD_APPLICATION_ID],
      null,
    ],
    ["unlisted bot", { author_is_bot: true }, [webhook], null],
    ["wrong guild", { guild_id: uniqueId() }, [], null],
    ["wrong channel", { channel_id: uniqueId() }, [], null],
  ];
  it.each(cases)("%s", async (_label, overrides, allowlist, acceptanceClass) => {
    const event = makeEvent({ author_id: author, ...overrides });
    const config = testConfig({ spikeSenderAllowlist: allowlist });
    expect(classifyAcceptedAuthor(event, config, true)).toBe(acceptanceClass);
    expect(shouldAcceptAuthor(event, config, true)).toBe(acceptanceClass !== null);
    expect(classifyAcceptedAuthor(event, config, false)).toBeNull();
    if (acceptanceClass === null && !allowlist.includes(env.DISCORD_APPLICATION_ID)) {
      const counted = countD1(env.STAGING_DB);
      const response = await worker.fetch(
        ingestRequest(event),
        {
          ...env,
          STAGING_DB: counted.db,
          SPIKE_SENDER_ALLOWLIST: allowlist.join(","),
        } as unknown as Env,
        createExecutionContext(),
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ status: "ignored" });
      expect(counted.stats.statements).toBe(0);
    }
  });
  it("keeps the exception disabled for a future production-shaped config", () => {
    const config = {
      ...testConfig({ spikeSenderAllowlist: [author] }),
      environment: "production",
    } as unknown as ReturnType<typeof testConfig>;
    expect(
      classifyAcceptedAuthor(makeEvent({ author_id: author, author_is_bot: true }), config, true),
    ).toBeNull();
    expect(classifyAcceptedAuthor(makeEvent({ author_id: author }), config, true)).toBe("normal");
  });
});

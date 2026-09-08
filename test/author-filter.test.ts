import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { shouldAcceptAuthor } from "../src/ingest/author-filter";
import type { RegistrationMessageEvent } from "../src/domain/discord-event";
import { countD1, ingestRequest, makeEvent, testConfig, uniqueId } from "./support/fixtures";

describe("author and channel filter", () => {
  const author = uniqueId();
  const webhook = uniqueId();
  const cases: [string, Partial<RegistrationMessageEvent>, string[], boolean][] = [
    ["user", {}, [], true],
    ["bot", { author_is_bot: true }, [], false],
    ["system", { author_is_system: true }, [], false],
    ["webhook", { webhook_id: webhook }, [], false],
    ["own author", { author_id: env.DISCORD_APPLICATION_ID }, [], false],
    ["own app", { application_id: env.DISCORD_APPLICATION_ID }, [], false],
    ["listed bot", { author_is_bot: true }, [author], true],
    ["listed webhook", { webhook_id: webhook }, [webhook], true],
    ["listed system", { author_is_system: true }, [author], false],
    ["listed system bot", { author_is_system: true, author_is_bot: true }, [author], false],
    ["listed system webhook", { author_is_system: true, webhook_id: webhook }, [webhook], false],
    [
      "listed own author",
      { author_id: env.DISCORD_APPLICATION_ID },
      [env.DISCORD_APPLICATION_ID],
      false,
    ],
    ["unlisted bot", { author_is_bot: true }, [webhook], false],
    ["wrong guild", { guild_id: uniqueId() }, [], false],
    ["wrong channel", { channel_id: uniqueId() }, [], false],
  ];
  it.each(cases)("%s", async (_label, overrides, allowlist, accepted) => {
    const event = makeEvent({ author_id: author, ...overrides });
    expect(shouldAcceptAuthor(event, testConfig({ spikeSenderAllowlist: allowlist }))).toBe(
      accepted,
    );
    if (!accepted && !allowlist.includes(env.DISCORD_APPLICATION_ID)) {
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
    expect(shouldAcceptAuthor(makeEvent({ author_id: author, author_is_bot: true }), config)).toBe(
      false,
    );
  });
});

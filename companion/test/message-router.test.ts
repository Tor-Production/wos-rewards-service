import { describe, expect, it } from "vitest";

import { parseManualCodeCommand, routeMessage } from "../src/message-router.js";
import { CONFIG, message } from "./fixtures.js";

describe("Discord message routing", () => {
  it("forwards a human registration with content unchanged", () => {
    const content = "  1234567890 007 Frost  Wolf 😀\n";
    expect(routeMessage(message({ content }), CONFIG)).toEqual({
      kind: "registration",
      path: "/ingest",
      payload: {
        event_id: "623456789012345678",
        guild_id: CONFIG.discordGuildId,
        channel_id: CONFIG.discordRegistrationChannelId,
        author_id: "723456789012345678",
        author_is_bot: false,
        author_is_system: false,
        webhook_id: null,
        application_id: null,
        content,
        created_at: "2026-09-13T12:00:00.000Z",
      },
    });
  });

  it.each([
    { guildId: "823456789012345678" },
    { channelId: "923456789012345678" },
    { authorIsBot: true },
    { authorIsSystem: true },
    { messageIsSystem: true },
    { webhookId: "823456789012345678" },
    { applicationId: CONFIG.discordApplicationId },
  ])("ignores wrong-scope and non-human registration messages (%#)", (override) => {
    expect(routeMessage(message(override), CONFIG)).toBeNull();
  });

  it("routes only an allow-listed human admin and normalizes the command", () => {
    const routed = routeMessage(
      message({
        channelId: CONFIG.discordMvpAdminChannelId,
        authorId: CONFIG.discordMvpAdminUserAllowlist[0]!,
        content: "  !wos-code   Stage_09-Code  ",
      }),
      CONFIG,
    );
    expect(routed).toMatchObject({
      kind: "manual_code",
      path: "/manual-code",
      payload: { code: "Stage_09-Code", channel_id: CONFIG.discordMvpAdminChannelId },
    });
  });

  it("ignores unauthorized admins and malformed commands", () => {
    expect(
      routeMessage(
        message({ channelId: CONFIG.discordMvpAdminChannelId, content: "!wos-code VALID" }),
        CONFIG,
      ),
    ).toBeNull();
    for (const content of [
      "!WOS-code CODE",
      "!wos-code",
      "!wos-code contains spaces",
      "!wos-code bad!",
      `!wos-code ${"A".repeat(65)}`,
    ])
      expect(
        routeMessage(
          message({
            channelId: CONFIG.discordMvpAdminChannelId,
            authorId: CONFIG.discordMvpAdminUserAllowlist[0]!,
            content,
          }),
          CONFIG,
        ),
      ).toBeNull();
  });

  it("defines one bounded command syntax", () => {
    expect(parseManualCodeCommand("!wos-code A_b-9")).toBe("A_b-9");
    expect(parseManualCodeCommand("!wos-code A B")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { matchesSelectedFollowCopy } from "../src/task20-preflight-validation.js";

const source = {
  guildId: "100000000000000001",
  channelId: "100000000000000002",
  webhookId: "100000000000000003",
  sourceGuildId: "100000000000000001",
  sourceChannelId: "100000000000000004",
};
const destination = "100000000000000005";
const original = "100000000000000006";
const copy = {
  id: destination,
  channel_id: source.channelId,
  webhook_id: source.webhookId,
  type: 0,
  flags: 2,
  message_reference: {
    type: 0,
    guild_id: source.sourceGuildId,
    channel_id: source.sourceChannelId,
    message_id: original,
  },
};

describe("Task 20 selected Follow copy preflight", () => {
  it("accepts the one exact selected copy", () => {
    expect(matchesSelectedFollowCopy(copy, source, destination, original)).toBe(true);
  });

  it.each([
    { ...copy, webhook_id: "100000000000000007" },
    { ...copy, channel_id: "100000000000000007" },
    { ...copy, flags: 0 },
    { ...copy, message_reference: { ...copy.message_reference, message_id: "100000000000000007" } },
  ])("rejects a wrong field", (message) => {
    expect(matchesSelectedFollowCopy(message, source, destination, original)).toBe(false);
  });
});

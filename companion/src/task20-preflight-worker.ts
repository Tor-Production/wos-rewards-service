import { parentPort } from "node:worker_threads";

import WebSocket from "ws";

import { loadFollowSource } from "../../shared/discord-follow.js";
import { loadCompanionConfig } from "./config.js";
import { runPreflightSession } from "./task20-preflight-runner.js";

try {
  const config = loadCompanionConfig(process.env);
  const issues: string[] = [];
  const source = loadFollowSource({ ...process.env, CODE_DISCOVERY_ENABLED: "true" }, issues);
  if (issues.length > 0 || !source) throw new Error("configuration");
  const passed = await runPreflightSession(
    {
      token: config.discordBotToken,
      applicationId: config.discordApplicationId,
      source,
      destinationMessageId: process.env.TASK20_DESTINATION_MESSAGE_ID ?? "",
      sourceMessageId: process.env.TASK20_SOURCE_MESSAGE_ID ?? "",
    },
    {
      request: fetch,
      connect: (url) =>
        new WebSocket(url, {
          handshakeTimeout: 8_000,
          perMessageDeflate: false,
          maxPayload: 1_048_576,
        }),
    },
  );
  parentPort?.postMessage(passed ? "ready" : "failed");
} catch {
  // Never forward exception text, API responses, identifiers or credentials.
  parentPort?.postMessage("failed");
}

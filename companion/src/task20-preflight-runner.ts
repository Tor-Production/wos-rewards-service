import { GatewayIntentBits } from "discord.js";
import WebSocket from "ws";

import { isFollowSnowflake, type FollowSourceConfig } from "../../shared/discord-follow.js";
import { matchesSelectedFollowCopy } from "./task20-preflight-validation.js";

export interface PreflightInput {
  readonly token: string;
  readonly applicationId: string;
  readonly source: FollowSourceConfig;
  readonly destinationMessageId: string;
  readonly sourceMessageId: string;
}

export type GatewaySocket = Pick<WebSocket, "on" | "removeListener" | "send" | "terminate">;

export interface PreflightTransport {
  readonly request: typeof fetch;
  readonly connect: (url: string) => GatewaySocket;
}

/** One gateway-information GET, one WebSocket connection, one selected-message GET. */
export async function runPreflightSession(
  input: PreflightInput,
  transport: PreflightTransport,
): Promise<boolean> {
  if (!isFollowSnowflake(input.destinationMessageId) || !isFollowSnowflake(input.sourceMessageId))
    return false;
  let socket: GatewaySocket | undefined;
  try {
    const gatewayResponse = await transport.request("https://discord.com/api/v10/gateway/bot", {
      headers: { Authorization: `Bot ${input.token}` },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!gatewayResponse.ok) return false;
    const gateway: unknown = await gatewayResponse.json();
    const url = gatewayUrl(gateway);
    if (!url) return false;

    socket = transport.connect(url);
    const applicationId = await awaitOneReady(socket, input.token);
    if (applicationId !== input.applicationId) return false;
    const response = await transport.request(
      `https://discord.com/api/v10/channels/${input.source.channelId}/messages/${input.destinationMessageId}`,
      {
        headers: { Authorization: `Bot ${input.token}` },
        signal: AbortSignal.timeout(8_000),
        redirect: "error",
      },
    );
    if (!response.ok) return false;
    const message: unknown = await response.json();
    return matchesSelectedFollowCopy(
      message,
      input.source,
      input.destinationMessageId,
      input.sourceMessageId,
    );
  } catch {
    return false;
  } finally {
    socket?.terminate();
  }
}

function gatewayUrl(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("url" in value)) return null;
  const raw = value.url;
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "wss:" || url.hostname !== "gateway.discord.gg") return null;
    url.search = "?v=10&encoding=json";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function awaitOneReady(socket: GatewaySocket, token: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let identified = false;
    let sequence: number | null = null;
    let heartbeat: NodeJS.Timeout | undefined;
    const finish = (applicationId: string | null) => {
      clearInterval(heartbeat);
      socket.removeListener("message", onMessage);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      if (applicationId) resolve(applicationId);
      else reject(new Error("gateway failed"));
    };
    const onError = () => finish(null);
    const onClose = () => finish(null);
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const payload: unknown = JSON.parse(data.toString());
        if (typeof payload !== "object" || payload === null || !("op" in payload)) {
          finish(null);
          return;
        }
        const p = payload as { op: unknown; t?: unknown; s?: unknown; d?: unknown };
        if (typeof p.s === "number" && Number.isInteger(p.s)) sequence = p.s;
        if (p.op === 10 && !identified) {
          const hello = p.d as { heartbeat_interval?: unknown } | null;
          const interval = hello?.heartbeat_interval;
          if (typeof interval !== "number" || !Number.isInteger(interval) || interval < 1_000) {
            finish(null);
            return;
          }
          identified = true;
          socket.send(
            JSON.stringify({
              op: 2,
              d: {
                token,
                intents:
                  GatewayIntentBits.Guilds |
                  GatewayIntentBits.GuildMessages |
                  GatewayIntentBits.MessageContent,
                properties: {
                  os: process.platform,
                  browser: "task20-preflight",
                  device: "task20-preflight",
                },
              },
            }),
          );
          heartbeat = setInterval(
            () => socket.send(JSON.stringify({ op: 1, d: sequence })),
            interval,
          );
        } else if (p.op === 1) {
          socket.send(JSON.stringify({ op: 1, d: sequence }));
        } else if (p.op === 11) {
          // Heartbeat acknowledgement; no additional request.
        } else if (p.op === 0 && p.t === "READY" && identified) {
          const ready = p.d as { application?: { id?: unknown } } | null;
          finish(typeof ready?.application?.id === "string" ? ready.application.id : null);
        } else {
          // Reconnect, invalid session and every unexpected event fail closed.
          finish(null);
        }
      } catch {
        finish(null);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

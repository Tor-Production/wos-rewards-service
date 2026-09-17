import type { AppConfig } from "../config";
import { contentHash } from "../ingest/identity";

export type DiscordTransport = (request: Request) => Promise<Response>;
export type DiscordFetch = (request: Request) => Promise<Response>;
interface Output {
  delivery_id: string;
  delivery_group: string;
  operation_id: string | null;
  event_id: string | null;
  channel_id: string;
  content: string;
  content_hash: string;
  nonce: string;
  attempts: number;
}
export interface SendResult {
  kind: "sent" | "retry" | "blocked";
  messageId?: string;
  delay: number;
  reason: string | null;
}

/** Adds the bot credential at the final network boundary and never exposes it to diagnostics. */
export function createDiscordRestTransport(
  botToken: string,
  fetcher: DiscordFetch = (request) => fetch(request),
): DiscordTransport {
  return async (request) => {
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bot ${botToken}`);
    return fetcher(new Request(request, { headers }));
  };
}
function seconds(value: unknown): number | null {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)))
    return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
export async function createMessage(
  transport: DiscordTransport,
  row: Pick<Output, "channel_id" | "content" | "nonce">,
  timeoutSeconds: number,
): Promise<SendResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = new Request(`https://discord.com/api/v10/channels/${row.channel_id}/messages`, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: row.content,
        nonce: row.nonce,
        enforce_nonce: true,
        allowed_mentions: { parse: [] },
      }),
    });
    return await Promise.race([
      (async (): Promise<SendResult> => {
        const response = await transport(request);
        const reader = response.body?.getReader();
        let size = 0;
        let text = "";
        const decoder = new TextDecoder();
        if (reader)
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > 16_384) {
                await reader.cancel();
                throw new Error("response_size");
              }
              text += decoder.decode(next.value, { stream: true });
            }
          } finally {
            reader.releaseLock();
          }
        let body: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
        } catch {
          /* classified below */
        }
        const delay = Math.ceil(
          Math.max(
            seconds(response.headers.get("retry-after")) ?? 0,
            seconds(body.retry_after) ?? 0,
            response.headers.get("x-ratelimit-remaining") === "0"
              ? (seconds(response.headers.get("x-ratelimit-reset-after")) ?? 0)
              : 0,
          ),
        );
        if (delay > 8_640_000) return { kind: "blocked", delay: 0, reason: "invalid_rate_limit" };
        if (response.status === 429)
          return { kind: "retry", delay: Math.max(1, delay), reason: "discord_rate_limited" };
        if (response.status >= 500)
          return { kind: "retry", delay: Math.max(60, delay), reason: "discord_unavailable" };
        if (
          response.ok &&
          typeof body.id === "string" &&
          /^\d{1,20}$/.test(body.id) &&
          (body.channel_id === undefined || body.channel_id === row.channel_id)
        )
          return { kind: "sent", messageId: body.id, delay, reason: null };
        if (response.ok) return { kind: "retry", delay: 60, reason: "discord_ambiguous_response" };
        return {
          kind: "blocked",
          delay: 0,
          reason:
            response.status === 401
              ? "discord_auth_failed"
              : response.status === 403
                ? "discord_forbidden"
                : response.status === 404
                  ? "discord_channel_missing"
                  : "discord_bad_request",
        };
      })(),
      new Promise<SendResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ kind: "retry", delay: 60, reason: "discord_timeout" });
        }, timeoutSeconds * 1000);
      }),
    ]);
  } catch {
    return { kind: "retry", delay: 60, reason: "discord_network_failed" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function dispatchOutput(
  db: D1Database,
  config: AppConfig,
  now: () => Date,
  transport?: DiscordTransport,
): Promise<void> {
  if (!transport) return; // Default runtime never reads a bot token and never consumes attempts.
  const stamp = now().toISOString();
  const token = crypto.randomUUID();
  const expiry = new Date(Date.parse(stamp) + config.outputLeaseSeconds * 1000).toISOString();
  const claim = await db
    .prepare(
      `INSERT INTO dispatch_control(scope,claim_token,claim_expires_at) VALUES ('discord',?1,?2)
    ON CONFLICT(scope) DO UPDATE SET claim_token=?1,claim_expires_at=?2 WHERE dispatch_control.blocked_at IS NULL
    AND (dispatch_control.available_at IS NULL OR dispatch_control.available_at<=?3)
    AND (dispatch_control.claim_token IS NULL OR dispatch_control.claim_expires_at<?3)`,
    )
    .bind(token, expiry, stamp)
    .run();
  if (!claim.meta.changes) return;
  const row = await db
    .prepare(
      `SELECT d.* FROM discord_output_deliveries d LEFT JOIN operations o ON o.operation_id=d.operation_id
    WHERE d.status IN ('pending','claimed') AND d.blocked_at IS NULL
    AND d.dispatch_eligible=1 AND d.permanent_dispatch_block=0
    AND d.suppression_reason IS NULL AND d.suppressed_at IS NULL
    AND COALESCE(d.available_at,d.created_at)<=?1
    AND (d.status='pending' OR d.claim_expires_at<?1)
    AND (d.operation_id IS NULL OR o.summary_state IN ('built','delivering'))
    AND NOT EXISTS(SELECT 1 FROM discord_output_deliveries prior WHERE prior.delivery_group=d.delivery_group AND prior.chunk_index<d.chunk_index AND prior.status<>'sent')
    ORDER BY d.created_at,d.delivery_group,d.chunk_index LIMIT 1`,
    )
    .bind(stamp)
    .first<Output>();
  if (!row) {
    // Recover a crash after the last sent mark, before the operation/event completion mark.
    await db.batch([
      finalizeOperations(db, stamp),
      finalizeEvents(db, stamp),
      release(db, token, stamp, null),
    ]);
    return;
  }
  const claimed = await db
    .prepare(
      `UPDATE discord_output_deliveries SET status='claimed',claim_token=?1,claim_expires_at=?2,attempts=attempts+1,updated_at=?3
    WHERE delivery_id=?4 AND blocked_at IS NULL
    AND dispatch_eligible=1 AND permanent_dispatch_block=0
    AND suppression_reason IS NULL AND suppressed_at IS NULL
    AND attempts<?5 AND (status='pending' OR (status='claimed' AND claim_expires_at<?3))`,
    )
    .bind(token, expiry, stamp, row.delivery_id, config.outputMaxAttempts)
    .run();
  if (claimed.meta.changes && row.operation_id)
    await db
      .prepare(
        "UPDATE operations SET summary_state='delivering',updated_at=?2 WHERE operation_id=?1 AND summary_state='built'",
      )
      .bind(row.operation_id, stamp)
      .run();
  let result: SendResult;
  if (!claimed.meta.changes)
    result = { kind: "blocked", delay: 0, reason: "output_attempts_exhausted" };
  else if ((await contentHash(row.content)) !== row.content_hash)
    result = { kind: "blocked", delay: 0, reason: "output_content_mismatch" };
  else result = await createMessage(transport, row, config.outputTimeoutSeconds);
  const finished = now().toISOString();
  const delay = Math.max(
    result.delay,
    result.kind === "retry" ? Math.min(60 * 2 ** row.attempts, 3600) : 0,
  );
  const available = new Date(Date.parse(finished) + delay * 1000).toISOString();
  const blocked =
    result.kind === "blocked" ||
    (result.kind === "retry" && row.attempts + 1 >= config.outputMaxAttempts);
  await db.batch([
    db
      .prepare(
        `UPDATE discord_output_deliveries SET status=?1,discord_message_id=?2,sent_at=?3,
      available_at=?4,last_error=?5,blocked_at=?6,alerted_at=?6,claim_token=NULL,claim_expires_at=NULL,updated_at=?7
      WHERE delivery_id=?8 AND (claim_token=?9 OR (?10=0 AND status IN ('pending','claimed') AND attempts>=?11 AND (claim_token IS NULL OR claim_expires_at<?7)))`,
      )
      .bind(
        result.kind === "sent" ? "sent" : "pending",
        result.messageId ?? null,
        result.kind === "sent" ? finished : null,
        available,
        result.reason,
        blocked ? finished : null,
        finished,
        row.delivery_id,
        token,
        claimed.meta.changes,
        config.outputMaxAttempts,
      ),
    finalizeOperations(db, finished),
    finalizeEvents(db, finished),
    release(db, token, available, result.reason === "discord_auth_failed" ? finished : null),
  ]);
}
function release(
  db: D1Database,
  token: string,
  available: string,
  blocked: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE dispatch_control SET claim_token=NULL,claim_expires_at=NULL,available_at=?1,blocked_at=?2 WHERE scope='discord' AND claim_token=?3",
    )
    .bind(available, blocked, token);
}
function finalizeOperations(db: D1Database, now: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE operations AS o SET summary_state='delivered',state=CASE WHEN state='stale_closed' THEN state ELSE 'summarized' END,updated_at=?1
    WHERE operation_id IN (SELECT candidate.operation_id FROM operations candidate
      WHERE candidate.summary_state IN ('built','delivering')
      AND candidate.summary_build_cursor=candidate.summary_chunk_total
      AND candidate.summary_chunk_total=(SELECT COUNT(*) FROM discord_output_deliveries d
        WHERE d.operation_id=candidate.operation_id AND d.status='sent')
      ORDER BY candidate.updated_at LIMIT 128)
    AND o.summary_state IN ('built','delivering')
    AND o.summary_build_cursor=o.summary_chunk_total
    AND o.summary_chunk_total=(SELECT COUNT(*) FROM discord_output_deliveries d
      WHERE d.operation_id=o.operation_id AND d.status='sent')`,
    )
    .bind(now);
}
function finalizeEvents(db: D1Database, now: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE processed_events SET status='finalized',finalized_at=?1 WHERE event_id IN (
    SELECT e.event_id FROM processed_events e WHERE e.status<>'finalized' AND ((e.operation_id IS NOT NULL AND EXISTS(SELECT 1 FROM operations o WHERE o.operation_id=e.operation_id AND o.summary_state='delivered'))
    OR (e.status='accepted_invalid' AND EXISTS(SELECT 1 FROM discord_output_deliveries d WHERE d.event_id=e.event_id AND d.status='sent'))) ORDER BY e.accepted_at LIMIT 128)`,
    )
    .bind(now);
}

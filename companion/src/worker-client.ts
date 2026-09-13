import type { CompanionConfig } from "./config.js";
import type { RoutedMessage } from "./message-router.js";

export type ForwardStatus = "accepted" | "duplicate" | "ignored" | "unauthorized" | "unavailable";

type Fetcher = (request: Request) => Promise<Response>;

export interface ForwardOptions {
  readonly fetcher?: Fetcher;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
  readonly attempts?: number;
}

export async function forwardToWorker(
  config: CompanionConfig,
  routed: RoutedMessage,
  options: ForwardOptions = {},
): Promise<ForwardStatus> {
  const fetcher = options.fetcher ?? ((request: Request) => fetch(request));
  const delay =
    options.delay ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await sendOnce(config, routed, fetcher, timeoutMs);
    if (response.kind === "complete") return response.status;
    if (attempt + 1 < attempts) await delay(Math.min(250 * 2 ** attempt, 1_000));
  }
  return "unavailable";
}

async function sendOnce(
  config: CompanionConfig,
  routed: RoutedMessage,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<{ kind: "complete"; status: ForwardStatus } | { kind: "retry" }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(
      new Request(new URL(routed.path, config.workerBaseUrl), {
        method: "POST",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${config.ingestionSharedSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(routed.payload),
      }),
    );
    if (response.status === 429 || response.status >= 500) return { kind: "retry" };
    if (response.status === 401 || response.status === 403)
      return { kind: "complete", status: "unauthorized" };
    const status = await readStatus(response);
    return {
      kind: "complete",
      status: status ?? (response.ok ? "ignored" : "unavailable"),
    };
  } catch {
    return { kind: "retry" };
  } finally {
    clearTimeout(timeout);
  }
}

async function readStatus(response: Response): Promise<ForwardStatus | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4_096) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const candidate = record.status ?? record.error;
    return ["accepted", "duplicate", "ignored", "unauthorized", "unavailable"].includes(
      String(candidate),
    )
      ? (candidate as ForwardStatus)
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

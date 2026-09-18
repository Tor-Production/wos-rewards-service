import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import type {
  PlayerRef,
  RedeemResult,
  WhiteoutProvider,
} from "../../src/domain/whiteout-provider.js";

export const ENDPOINT = "https://wos-giftcode-api.centurygame.com/api/gift_code";
export const REFERENCE = "task12-20260918-one-pair";
export const DEADLINE_MS = 30_000;
export interface Authorization {
  reference: typeof REFERENCE;
  playerId: string;
  state: string;
  code: string;
  consent: true;
  unredeemed: true;
  reserved: true;
  startsAt: string;
  cutoff: string;
  expiry: string;
  harnessDigest: string;
  checksPassed: true;
}
export interface WireRequest {
  url: typeof ENDPOINT;
  method: "POST";
  redirect: "error";
  body: string;
  signal: AbortSignal;
}
export interface WireResponse {
  status: number;
  body: unknown;
}
export interface Observation {
  reference: typeof REFERENCE;
  at: string;
  requests: number;
  markerConsumed: boolean;
  stopReason: string;
  httpStatus?: number;
  response?: { code?: number; err_code?: number; msg?: string };
}
export class ExperimentStop extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
export function consumeMarker(path: string, at: string): void {
  // An existing, empty, or partially written file permanently consumes this test's budget.
  const fd = openSync(path, "wx");
  try {
    writeFileSync(fd, JSON.stringify({ reference: REFERENCE, at, budgetConsumed: true }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
const messages = new Set([
  "SUCCESS",
  "RECEIVED",
  "SAME TYPE EXCHANGE",
  "TIME ERROR",
  "CDK NOT FOUND",
  "USER INFO ERROR",
  "TOO FREQUENT",
  "SIGN ERROR",
  "NOT LOGIN",
  "TIMEOUT RETRY",
  "USED",
  "STOVE_LV ERROR",
  "RECHARGE_MONEY ERROR",
  "RECHARGE_MONEY_VIP ERROR",
  "role not exist",
]);
export function classify(response: WireResponse): {
  fields: NonNullable<Observation["response"]>;
  result: RedeemResult | string;
} {
  const fields: NonNullable<Observation["response"]> = {};
  const b = response.body;
  if (typeof b !== "object" || b === null || Array.isArray(b))
    return { fields, result: "unexpected_schema" };
  const row = b as Record<string, unknown>;
  if (Number.isSafeInteger(row.code)) fields.code = row.code as number;
  if (Number.isSafeInteger(row.err_code)) fields.err_code = row.err_code as number;
  const msg = typeof row.msg === "string" ? row.msg.replace(/\.+$/, "") : "";
  if (messages.has(msg)) fields.msg = msg;
  if (response.status >= 300 && response.status < 400) return { fields, result: "redirect" };
  if (response.status === 429) return { fields, result: "rate_limit" };
  if (response.status === 401 || response.status === 403)
    return { fields, result: "auth_or_challenge" };
  if (response.status !== 200) return { fields, result: "http_unresolved" };
  if (/captcha|challenge/i.test(msg) || Object.keys(row).some((k) => /captcha|challenge/i.test(k)))
    return { fields, result: "challenge" };
  if (fields.code === 0 && msg === "SUCCESS" && fields.err_code === 20000)
    return { fields, result: { outcome: "success" } };
  if (fields.code !== 1) return { fields, result: "unknown_response" };
  if (msg === "RECEIVED" && fields.err_code === 40008)
    return { fields, result: { outcome: "already_redeemed" } };
  if (msg === "TIME ERROR" && fields.err_code === 40007)
    return { fields, result: { outcome: "permanent", reasonCode: "code_expired" } };
  if (msg === "CDK NOT FOUND" && fields.err_code === 40014)
    return { fields, result: { outcome: "permanent", reasonCode: "code_invalid" } };
  if (msg === "USER INFO ERROR" && fields.err_code === 40020)
    return { fields, result: "state_rejected" };
  if (msg === "SAME TYPE EXCHANGE" && fields.err_code === 40011)
    return { fields, result: "same_type_unresolved" };
  if (msg === "TOO FREQUENT" && fields.err_code === 40019) return { fields, result: "rate_limit" };
  if (/sign error/i.test(msg) || msg === "NOT LOGIN") return { fields, result: "auth_failed" };
  return { fields, result: "unknown_response" };
}
export interface Dependencies {
  now: () => number;
  enabled: () => boolean;
  consume: (at: string) => void;
  sign: (canonical: string) => string;
  transport: (request: WireRequest) => Promise<WireResponse>;
}
export class ExperimentalWhiteoutProvider implements WhiteoutProvider {
  readonly observation: Observation = {
    reference: REFERENCE,
    at: "",
    requests: 0,
    markerConsumed: false,
    stopReason: "not_dispatched",
  };
  private used = false;
  private readonly authorization: Readonly<Authorization>;
  constructor(
    authorization: Authorization,
    private readonly digest: string,
    private readonly deps: Dependencies,
    private readonly live = false,
  ) {
    this.authorization = Object.freeze({ ...authorization });
  }
  private guard(player: PlayerRef, code: string, id: string): void {
    const a = this.authorization;
    const now = this.deps.now();
    const start = Date.parse(a.startsAt),
      cutoff = Date.parse(a.cutoff);
    const expiry = a.expiry === "unknown" ? Infinity : Date.parse(a.expiry);
    if (
      !this.live ||
      !this.deps.enabled() ||
      this.used ||
      a.reference !== REFERENCE ||
      id !== REFERENCE ||
      a.consent !== true ||
      a.unredeemed !== true ||
      a.reserved !== true ||
      a.checksPassed !== true ||
      !/^[a-f0-9]{64}$/.test(this.digest) ||
      a.harnessDigest !== this.digest ||
      !/^\d{1,20}$/.test(a.playerId) ||
      !/^\d{1,10}$/.test(a.state) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(a.code) ||
      player.playerId !== a.playerId ||
      player.state !== a.state ||
      code !== a.code ||
      !Number.isFinite(now) ||
      !Number.isFinite(start) ||
      !Number.isFinite(cutoff) ||
      Number.isNaN(expiry) ||
      now < start ||
      now + DEADLINE_MS > Math.min(cutoff, expiry)
    )
      throw new ExperimentStop("guard_rejected");
  }
  async redeem(player: PlayerRef, code: string, id: string): Promise<RedeemResult> {
    this.guard(player, code, id);
    const fields = {
      cdk: code,
      fid: player.playerId,
      kid: player.state,
      time: String(Math.floor(this.deps.now() / 1000)),
    };
    const canonical = Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const signature = this.deps.sign(canonical);
    if (!/^[a-f0-9]{32}$/.test(signature)) throw new ExperimentStop("invalid_signer");
    this.guard(player, code, id);
    this.used = true;
    const o = this.observation;
    o.at = new Date(this.deps.now()).toISOString();
    try {
      this.deps.consume(o.at);
      o.markerConsumed = true;
    } catch {
      throw new ExperimentStop("attempt_unavailable");
    }
    // Recheck clock and disable latch after the synchronous durable write, immediately before dispatch.
    if (
      !this.deps.enabled() ||
      this.deps.now() + DEADLINE_MS >
        Math.min(
          Date.parse(this.authorization.cutoff),
          this.authorization.expiry === "unknown"
            ? Infinity
            : Date.parse(this.authorization.expiry),
        )
    ) {
      o.stopReason = "window_or_disable_after_claim";
      throw new ExperimentStop(o.stopReason);
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      o.requests = 1;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ExperimentStop("timeout_unresolved"));
        }, DEADLINE_MS);
      });
      const response = await Promise.race([
        this.deps.transport({
          url: ENDPOINT,
          method: "POST",
          redirect: "error",
          body: new URLSearchParams({ sign: signature, ...fields }).toString(),
          signal: controller.signal,
        }),
        timeout,
      ]);
      o.httpStatus = response.status;
      const classified = classify(response);
      o.response = classified.fields;
      if (typeof classified.result === "string") throw new ExperimentStop(classified.result);
      o.stopReason = classified.result.outcome;
      return classified.result;
    } catch (error) {
      o.stopReason = error instanceof ExperimentStop ? error.reason : "transport_unresolved";
      throw new ExperimentStop(o.stopReason);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
}

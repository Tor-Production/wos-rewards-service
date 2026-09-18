import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  consumeMarker,
  assertReplayAuthorization,
  ExperimentalWhiteoutProvider,
  REFERENCE,
  REPLAY_REFERENCE,
  type Authorization,
} from "./probe.js";
import { onePost } from "./transport.js";

const ROOT = "C:/Users/morta/AppData/Local/wos-rewards-service/task12-20260918";
export const SOURCE =
  "https://raw.githubusercontent.com/justncodes/wos-giftcode/4356d49368ecda16f4a0f0028de75a296da9dc9b/redeem_codes.py";
const files = [
  "probe.ts",
  "transport.ts",
  "driver.ts",
  "probe.test.ts",
  "tsconfig.json",
  "vitest.config.ts",
];
function digest(): string {
  const hash = createHash("sha256");
  for (const name of files)
    hash.update(name + "\0").update(readFileSync(resolve("experiments/task12", name)));
  return hash.digest("hex");
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--digest") {
    console.log(digest());
    return;
  }
  if (args.length !== 1 || (args[0] !== "--live" && args[0] !== "--live-replay")) {
    console.log(
      "Offline default: no request. Explicit --live and a recorded authorization are required.",
    );
    return;
  }
  const replay = args[0] === "--live-replay";
  const reference = replay ? REPLAY_REFERENCE : REFERENCE;
  const root = replay ? `${ROOT}-replay-check` : ROOT;
  const marker = `${root}/attempt.json`,
    disabled = `${root}/disabled.json`;
  // No path/run-id override; all invocations and worktrees share the same permanent budget.
  if (existsSync(marker) || existsSync(disabled)) {
    console.log("Task 12 is already consumed or disabled; no request.");
    return;
  }
  mkdirSync(root, { recursive: true });
  let provider: ExperimentalWhiteoutProvider | undefined;
  let sourceDigest: string | undefined;
  let harnessDigest: string | undefined;
  try {
    const a = JSON.parse(readFileSync(`${root}/authorization.json`, "utf8")) as Authorization;
    if (replay) {
      const original = JSON.parse(
        readFileSync(`${ROOT}/authorization.json`, "utf8"),
      ) as Authorization;
      const priorMarker = JSON.parse(readFileSync(`${ROOT}/attempt.json`, "utf8")) as {
        reference?: string;
        budgetConsumed?: boolean;
      };
      const priorDisabled = JSON.parse(readFileSync(`${ROOT}/disabled.json`, "utf8")) as {
        reference?: string;
        disabled?: boolean;
      };
      assertReplayAuthorization(
        a,
        original,
        priorMarker.reference === REFERENCE && priorMarker.budgetConsumed === true,
        priorDisabled.reference === REFERENCE && priorDisabled.disabled === true,
      );
    }
    harnessDigest = digest();
    // All guards run with an inert signer/transport before the public-source read.
    const deps = {
      now: Date.now,
      enabled: () => !existsSync(disabled),
      consume: (at: string) => consumeMarker(marker, at, reference),
      sign: (_: string): string => {
        throw new Error("preflight_only");
      },
      transport: onePost,
    };
    const preflight = new ExperimentalWhiteoutProvider(a, harnessDigest, deps, true, reference);
    try {
      await preflight.redeem({ playerId: a.playerId, state: a.state }, a.code, reference);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "preflight_only")
        throw new Error("guard_rejected");
    }
    const response = await fetch(SOURCE, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("source_unavailable");
    const source = await response.text();
    sourceDigest = createHash("sha256").update(source).digest("hex");
    const match = /^WOS_ENCRYPT_KEY = "([^"\r\n]+)"$/m.exec(source);
    if (!match?.[1]) throw new Error("signer_unavailable");
    const material = match[1];
    provider = new ExperimentalWhiteoutProvider(
      a,
      harnessDigest,
      {
        ...deps,
        sign: (canonical) =>
          createHash("md5")
            .update(canonical + material)
            .digest("hex"),
      },
      true,
      reference,
    );
    await provider.redeem({ playerId: a.playerId, state: a.state }, a.code, reference);
  } catch {
    /* Never print arbitrary exceptions, response bodies, source, or signed data. */
  } finally {
    // Latch first: even evidence-disk failure must not leave the invocation enabled.
    writeFileSync(disabled, JSON.stringify({ reference, disabled: true }));
    // Only the winning claimant may write attempted-request evidence; a losing process cannot overwrite it.
    const o = provider?.observation;
    if (o?.markerConsumed || !existsSync(marker)) {
      const evidence = {
        reference,
        finishedAt: new Date().toISOString(),
        source: SOURCE,
        sourceDigest,
        harnessDigest,
        observation: o ?? { requests: 0, stopReason: "pre_dispatch_abort" },
        humanConfirmation: replay
          ? "prior gift receipt reported by user; duplicate classification check only"
          : "pending",
        disabled: true,
      };
      writeFileSync(`${root}/evidence.json`, JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify(evidence));
    }
  }
}
await main();

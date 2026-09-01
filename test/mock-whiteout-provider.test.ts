import { describe, expect, it, vi } from "vitest";

import type { PlayerRef } from "../src/domain/whiteout-provider";
import { MockWhiteoutProvider } from "../src/providers/mock-whiteout-provider";
import type { MockOutcome } from "../src/providers/mock-whiteout-provider";

const PLAYER: PlayerRef = { playerId: "1234567890", state: "1621" };
const OTHER_PLAYER: PlayerRef = { playerId: "9876543210", state: "1621" };

function keyFor(playerId: string, code: string): string {
  // The shape of the stable per-(player, code) key from the global redemptions record.
  return `redeem:v1:${playerId}:${code}`;
}

describe("fixture selection is deterministic", () => {
  const cases: ReadonlyArray<readonly [MockOutcome, unknown]> = [
    ["success", { outcome: "success", providerReceipt: "mock-receipt:redeem:v1:1234567890:CODE" }],
    [
      "already_redeemed",
      { outcome: "already_redeemed", providerReceipt: "mock-receipt:redeem:v1:1234567890:CODE" },
    ],
    ["rate_limited", { outcome: "retryable", reasonCode: "provider_rate_limited" }],
    ["provider_unavailable", { outcome: "retryable", reasonCode: "provider_unavailable" }],
    ["code_invalid", { outcome: "permanent", reasonCode: "code_invalid" }],
    ["code_expired", { outcome: "permanent", reasonCode: "code_expired" }],
    // A disabled code classifies as code_invalid (redemption-state-machine.md section 17).
    ["code_disabled", { outcome: "permanent", reasonCode: "code_invalid" }],
    ["player_ineligible", { outcome: "permanent", reasonCode: "player_ineligible" }],
  ];

  for (const [outcome, expected] of cases) {
    it(`resolves the ${outcome} fixture`, async () => {
      const provider = new MockWhiteoutProvider({ fixtures: [{ code: "CODE", outcome }] });

      const result = await provider.redeem(PLAYER, "CODE", keyFor(PLAYER.playerId, "CODE"));

      expect(result).toStrictEqual(expected);
    });
  }

  it("falls back to the default outcome when no fixture matches", async () => {
    const provider = new MockWhiteoutProvider({
      defaultOutcome: "code_expired",
      fixtures: [{ code: "OTHER", outcome: "success" }],
    });

    const result = await provider.redeem(PLAYER, "CODE", keyFor(PLAYER.playerId, "CODE"));

    expect(result).toStrictEqual({ outcome: "permanent", reasonCode: "code_expired" });
  });

  it("defaults to success when no options are supplied", async () => {
    const provider = new MockWhiteoutProvider();

    const result = await provider.redeem(PLAYER, "CODE", keyFor(PLAYER.playerId, "CODE"));

    expect(result.outcome).toBe("success");
  });

  it("matches on player, on code, and on both", async () => {
    const provider = new MockWhiteoutProvider({
      fixtures: [
        { playerId: OTHER_PLAYER.playerId, code: "CODE", outcome: "player_ineligible" },
        { playerId: OTHER_PLAYER.playerId, outcome: "code_expired" },
        { code: "CODE", outcome: "code_invalid" },
      ],
    });

    expect(await provider.redeem(OTHER_PLAYER, "CODE", "k1")).toStrictEqual({
      outcome: "permanent",
      reasonCode: "player_ineligible",
    });
    expect(await provider.redeem(OTHER_PLAYER, "ELSE", "k2")).toStrictEqual({
      outcome: "permanent",
      reasonCode: "code_expired",
    });
    expect(await provider.redeem(PLAYER, "CODE", "k3")).toStrictEqual({
      outcome: "permanent",
      reasonCode: "code_invalid",
    });
  });

  it("applies the first matching fixture", async () => {
    const provider = new MockWhiteoutProvider({
      fixtures: [
        { code: "CODE", outcome: "code_expired" },
        { code: "CODE", outcome: "code_invalid" },
      ],
    });

    const result = await provider.redeem(PLAYER, "CODE", "k1");

    expect(result).toStrictEqual({ outcome: "permanent", reasonCode: "code_expired" });
  });

  it("rejects a fixture that would shadow the default outcome", () => {
    expect(() => new MockWhiteoutProvider({ fixtures: [{ outcome: "success" }] })).toThrow(
      TypeError,
    );
  });

  it("produces identical results across separately constructed providers", async () => {
    const options = { fixtures: [{ code: "CODE", outcome: "rate_limited" as const }] };
    const key = keyFor(PLAYER.playerId, "CODE");

    const first = await new MockWhiteoutProvider(options).redeem(PLAYER, "CODE", key);
    const second = await new MockWhiteoutProvider(options).redeem(PLAYER, "CODE", key);

    expect(first).toStrictEqual(second);
  });
});

describe("idempotency, observed only through redeem()", () => {
  it("does not apply the same successful redemption twice", async () => {
    const provider = new MockWhiteoutProvider({ defaultOutcome: "success" });
    const key = keyFor(PLAYER.playerId, "CODE");

    const first = await provider.redeem(PLAYER, "CODE", key);
    const second = await provider.redeem(PLAYER, "CODE", key);
    const third = await provider.redeem(PLAYER, "CODE", key);

    expect(first).toStrictEqual({ outcome: "success", providerReceipt: `mock-receipt:${key}` });
    // Success-equivalent terminal outcome; nothing was applied a second or third time.
    expect(second).toStrictEqual({
      outcome: "already_redeemed",
      providerReceipt: `mock-receipt:${key}`,
    });
    expect(third).toStrictEqual(second);
  });

  it("preserves the deterministic receipt on the repeat", async () => {
    const provider = new MockWhiteoutProvider({ defaultOutcome: "success" });
    const key = keyFor(PLAYER.playerId, "CODE");

    const first = await provider.redeem(PLAYER, "CODE", key);
    const second = await provider.redeem(PLAYER, "CODE", key);

    expect(first.outcome).toBe("success");
    expect(second.outcome).toBe("already_redeemed");
    const firstReceipt = first.outcome === "success" ? first.providerReceipt : undefined;
    const secondReceipt =
      second.outcome === "already_redeemed" ? second.providerReceipt : undefined;
    expect(secondReceipt).toBe(firstReceipt);
    expect(secondReceipt).toBe(`mock-receipt:${key}`);
  });

  it("keeps independent idempotency keys independent", async () => {
    const provider = new MockWhiteoutProvider({
      defaultOutcome: "success",
      fixtures: [{ playerId: OTHER_PLAYER.playerId, outcome: "player_ineligible" }],
    });
    const keyA = keyFor(PLAYER.playerId, "CODE");
    const keyB = keyFor(PLAYER.playerId, "OTHER");
    const keyC = keyFor(OTHER_PLAYER.playerId, "CODE");

    await provider.redeem(PLAYER, "CODE", keyA);

    // A different key for a different (player, code) is untouched by the applied key.
    expect(await provider.redeem(PLAYER, "OTHER", keyB)).toStrictEqual({
      outcome: "success",
      providerReceipt: `mock-receipt:${keyB}`,
    });
    expect(await provider.redeem(OTHER_PLAYER, "CODE", keyC)).toStrictEqual({
      outcome: "permanent",
      reasonCode: "player_ineligible",
    });
    // And the first key is still terminal.
    expect((await provider.redeem(PLAYER, "CODE", keyA)).outcome).toBe("already_redeemed");
  });

  it("does not convert a retryable outcome into already_redeemed", async () => {
    const provider = new MockWhiteoutProvider({ defaultOutcome: "rate_limited" });
    const key = keyFor(PLAYER.playerId, "CODE");

    const first = await provider.redeem(PLAYER, "CODE", key);
    const second = await provider.redeem(PLAYER, "CODE", key);

    expect(first).toStrictEqual({ outcome: "retryable", reasonCode: "provider_rate_limited" });
    expect(second).toStrictEqual(first);
  });

  it("does not convert a permanent outcome into already_redeemed", async () => {
    const provider = new MockWhiteoutProvider({ defaultOutcome: "player_ineligible" });
    const key = keyFor(PLAYER.playerId, "CODE");

    const first = await provider.redeem(PLAYER, "CODE", key);
    const second = await provider.redeem(PLAYER, "CODE", key);

    expect(first).toStrictEqual({ outcome: "permanent", reasonCode: "player_ineligible" });
    expect(second).toStrictEqual(first);
  });

  it("treats an already_redeemed fixture as applied", async () => {
    const provider = new MockWhiteoutProvider({ defaultOutcome: "already_redeemed" });
    const key = keyFor(PLAYER.playerId, "CODE");

    const first = await provider.redeem(PLAYER, "CODE", key);
    const second = await provider.redeem(PLAYER, "CODE", key);

    expect(first).toStrictEqual({
      outcome: "already_redeemed",
      providerReceipt: `mock-receipt:${key}`,
    });
    expect(second).toStrictEqual(first);
  });
});

describe("the mock needs no network and no secret", () => {
  it("never calls fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      // Constructed with no environment, no credential, and no configuration beyond fixtures.
      const provider = new MockWhiteoutProvider({
        fixtures: [
          { code: "A", outcome: "success" },
          { code: "B", outcome: "rate_limited" },
          { code: "C", outcome: "code_invalid" },
        ],
      });

      await provider.redeem(PLAYER, "A", keyFor(PLAYER.playerId, "A"));
      await provider.redeem(PLAYER, "B", keyFor(PLAYER.playerId, "B"));
      await provider.redeem(PLAYER, "C", keyFor(PLAYER.playerId, "C"));

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses the supplied state as given and never derives player details", async () => {
    // Two players differing only by state resolve through the same code fixture: the mock does
    // not look up, infer, or enrich anything about the player.
    const provider = new MockWhiteoutProvider({ fixtures: [{ code: "CODE", outcome: "success" }] });

    const a = await provider.redeem({ playerId: "111", state: "1621" }, "CODE", "ka");
    const b = await provider.redeem({ playerId: "111", state: "0002" }, "CODE", "kb");

    expect(a).toStrictEqual({ outcome: "success", providerReceipt: "mock-receipt:ka" });
    expect(b).toStrictEqual({ outcome: "success", providerReceipt: "mock-receipt:kb" });
  });
});

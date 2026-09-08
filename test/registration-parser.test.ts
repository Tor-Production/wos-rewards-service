import { describe, expect, it } from "vitest";
import { parseRegistration } from "../src/ingest/registration-parser";

describe("registration parsing", () => {
  it.each([
    ["12345", "007", null],
    ["12345 Frost Wolf", "007", "Frost Wolf"],
    ["12345 245", "245", null],
    ["12345 245 Frost Wolf", "245", "Frost Wolf"],
    [" \t12345  000245  Frost\n Wolf \t", "000245", "Frost Wolf"],
    ["12345 -12 Frost", "007", "-12 Frost"],
    ["12345 2a Frost", "007", "2a Frost"],
    ["12345 \u200b\u202e", "007", null],
  ])("parses %s", (content, state, displayName) => {
    expect(parseRegistration(content, "007")).toEqual({
      ok: true,
      playerId: "12345",
      state,
      displayName,
    });
  });

  it.each([
    ["", "empty_message"],
    [" \t\n\u3000", "empty_message"],
    ["abc", "player_id_not_numeric"],
    ["12a45", "player_id_not_numeric"],
    ["１２３", "player_id_not_numeric"],
    ["+123", "player_id_not_numeric"],
    ["1".repeat(40), "player_id_too_long"],
    ["12345 " + "1".repeat(20), "state_too_long"],
  ])("rejects invalid registration %s", (content, reason) => {
    expect(parseRegistration(content, "007")).toEqual({ ok: false, reason });
  });

  it.each(["0000123", "123456789012345678901234567890", "1".repeat(32)])(
    "preserves identifier %s exactly",
    (playerId) => {
      expect(parseRegistration(`${playerId} ${"0".repeat(16)}`, "1")).toEqual({
        ok: true,
        playerId,
        state: "0".repeat(16),
        displayName: null,
      });
    },
  );

  it("uses the supplied default rather than a built-in state", () => {
    expect(parseRegistration("12345 Name", "0009")).toMatchObject({ state: "0009" });
    expect(parseRegistration("12345", "0010")).toMatchObject({ state: "0010" });
  });
});

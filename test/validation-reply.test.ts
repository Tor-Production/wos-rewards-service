import { describe, expect, it } from "vitest";
import type { RegistrationValidationReason } from "../src/ingest/registration-parser";
import { validationReply } from "../src/ingest/validation-reply";

const BODY =
  "I could not read that registration. Send one of:\n\nPLAYER_ID\nPLAYER_ID NAME\nPLAYER_ID STATE\nPLAYER_ID STATE NAME\n\nPLAYER_ID must be digits only and is required.\nSTATE, when given, must be digits only; otherwise the configured default state is used.\nNAME is optional and may contain spaces.";
const CASES: [RegistrationValidationReason, string][] = [
  ["empty_message", "That message had no registration details."],
  ["player_id_not_numeric", "PLAYER_ID must contain digits only."],
  ["player_id_too_long", "PLAYER_ID is longer than 32 digits."],
  ["state_too_long", "STATE is longer than 16 digits."],
];

describe("validation reply bytes", () => {
  it.each(CASES)("renders the exact %s variant", (reason, line) => {
    const reply = validationReply(reason);
    expect(reply).toBe(`${BODY}\n\n${line}`);
    expect(new TextEncoder().encode(reply).byteLength).toBeLessThanOrEqual(500);
    expect(reply).not.toMatch(/[\r@#<>`*~|]/u);
    expect(reply.endsWith("\n")).toBe(false);
    // PLAYER_ID underscores are part of the approved exact text.
    expect(reply.replaceAll("PLAYER_ID", "")).not.toContain("_");
    expect(reply).not.toContain("automatic reward distribution");
  });
  it("has a distinct deterministic body for every reason", () => {
    expect(new Set(CASES.map(([reason]) => validationReply(reason))).size).toBe(CASES.length);
  });
});

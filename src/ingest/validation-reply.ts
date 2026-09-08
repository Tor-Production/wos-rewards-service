import type { RegistrationValidationReason } from "./registration-parser";

const SHARED_BODY = [
  "I could not read that registration. Send one of:",
  "",
  "PLAYER_ID",
  "PLAYER_ID NAME",
  "PLAYER_ID STATE",
  "PLAYER_ID STATE NAME",
  "",
  "PLAYER_ID must be digits only and is required.",
  "STATE, when given, must be digits only; otherwise the configured default state is used.",
  "NAME is optional and may contain spaces.",
].join("\n");

const REASON_LINES: Record<RegistrationValidationReason, string> = {
  empty_message: "That message had no registration details.",
  player_id_not_numeric: "PLAYER_ID must contain digits only.",
  player_id_too_long: "PLAYER_ID is longer than 32 digits.",
  state_too_long: "STATE is longer than 16 digits.",
};

/** Deterministic, LF-only text: no user-controlled value or runtime-summary footer. */
export function validationReply(reason: RegistrationValidationReason): string {
  return `${SHARED_BODY}\n\n${REASON_LINES[reason]}`;
}

import { PLAYER_ID_MAX_DIGITS, STATE_MAX_DIGITS } from "../limits";
import { normalizeDisplayName } from "./sanitize";

export type RegistrationValidationReason =
  "empty_message" | "player_id_not_numeric" | "player_id_too_long" | "state_too_long";

export type ParseRegistrationResult =
  | { ok: true; playerId: string; state: string; displayName: string | null }
  | { ok: false; reason: RegistrationValidationReason };

/** IDs remain digit strings, including leading zeros and values beyond Number's safe range. */
export function parseRegistration(content: string, defaultState: string): ParseRegistrationResult {
  const trimmed = content.trim();
  if (trimmed === "") return { ok: false, reason: "empty_message" };
  const [playerId = "", second, ...remaining] = trimmed.split(/\s+/u);
  if (!/^\d+$/u.test(playerId)) return { ok: false, reason: "player_id_not_numeric" };
  if (playerId.length > PLAYER_ID_MAX_DIGITS) return { ok: false, reason: "player_id_too_long" };
  const explicitState = second !== undefined && /^\d+$/u.test(second);
  if (explicitState && second.length > STATE_MAX_DIGITS)
    return { ok: false, reason: "state_too_long" };
  return {
    ok: true,
    playerId,
    state: explicitState ? second : defaultState,
    displayName: normalizeDisplayName(
      (explicitState ? remaining : second === undefined ? [] : [second, ...remaining]).join(" "),
    ),
  };
}

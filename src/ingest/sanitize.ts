import { DISPLAY_LABEL_MAX_CODE_POINTS, DISPLAY_NAME_MAX_CODE_POINTS } from "../limits";

/** Store visible characters, removing only control/format characters and normalizing spacing. */
export function normalizeDisplayName(value: string): string | null {
  const normalized = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized).slice(0, DISPLAY_NAME_MAX_CODE_POINTS).join("") || null;
}

/** Rendering defense in depth. Future Discord delivery must also disable allowed_mentions. */
export function escapeDiscordMarkup(value: string): string {
  return value.replace(/[\\`*_~|@<]|^[>#]/gu, "\\$&");
}

/** The resulting label is captured once in operation_items, never rebuilt from mutable players. */
export function renderDisplayLabel(displayName: string | null, playerId: string): string {
  if (displayName === null) return `ID ${playerId}`;
  let label = Array.from(escapeDiscordMarkup(displayName))
    .slice(0, DISPLAY_LABEL_MAX_CODE_POINTS)
    .join("");
  // A cut can separate an escape from its character. Keep complete escaped backslash pairs.
  const trailingBackslashes = label.match(/\\+$/u)?.[0].length ?? 0;
  if (trailingBackslashes % 2 === 1) label = label.slice(0, -1);
  return label || `ID ${playerId}`;
}

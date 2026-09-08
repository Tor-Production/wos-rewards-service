const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const DISCORD_EPOCH = Date.UTC(2015, 0, 1);

/** Validate calendar components before applying the offset; Date.parse alone is lenient. */
export function isValidCreatedAt(value: unknown, now: Date): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zone = match[8]!;
  const offsetHours = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinutes = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  )
    return false;
  const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day
  )
    return false;
  const offsetMs = (offsetHours * 60 + offsetMinutes) * 60_000 * (zone[0] === "-" ? -1 : 1);
  // Integer nanoseconds preserve strict bounds for the accepted nine fractional digits.
  const instant =
    BigInt(local.getTime() - offsetMs) * 1_000_000n + BigInt((match[7] ?? "0").padEnd(9, "0"));
  return (
    instant >= BigInt(DISCORD_EPOCH) * 1_000_000n &&
    instant <= BigInt(now.getTime() + 86_400_000) * 1_000_000n
  );
}

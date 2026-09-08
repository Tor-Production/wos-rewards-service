import { describe, expect, it } from "vitest";
import { isValidCreatedAt } from "../src/ingest/timestamp";
import { FIXTURE_NOW } from "./support/fixtures";

describe("RFC 3339 created_at", () => {
  it("preserves nanosecond precision at both window boundaries", () => {
    expect(isValidCreatedAt("2014-12-31T23:59:59.999999999Z", FIXTURE_NOW)).toBe(false);
    expect(isValidCreatedAt("2026-09-08T12:00:00.000000001Z", FIXTURE_NOW)).toBe(false);
  });
  it.each([
    "2026-09-07T00:00:00Z",
    "2026-09-07T00:00:00.123Z",
    "2026-09-07T00:00:00.123456789+02:00",
    "2026-09-07T00:00:00-05:30",
    "2024-02-29T00:00:00Z",
    "2015-01-01T01:00:00+01:00",
    new Date(FIXTURE_NOW.getTime() + 23 * 3_600_000).toISOString(),
    new Date(FIXTURE_NOW.getTime() + 24 * 3_600_000).toISOString(),
  ])("accepts %s", (value) => expect(isValidCreatedAt(value, FIXTURE_NOW)).toBe(true));
  it.each([
    "2026-09-07T00:00:00",
    "2026-09-07 00:00:00Z",
    "2026-09-07t00:00:00z",
    "2026-02-31T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-09-07T24:00:00Z",
    "2026-09-07T00:60:00Z",
    "2026-09-07T00:00:60Z",
    "2026-09-07T00:00:00+24:00",
    "2026-09-07T00:00:00+00:60",
    "2026-09-07T00:00:00.1234567890Z",
    "not-a-date",
    "1700000000",
    "2014-12-31T23:59:59Z",
    "2015-01-01T00:00:00+00:01",
    new Date(FIXTURE_NOW.getTime() + 25 * 3_600_000).toISOString(),
    null,
    42,
  ])("rejects %s", (value) => expect(isValidCreatedAt(value, FIXTURE_NOW)).toBe(false));
});

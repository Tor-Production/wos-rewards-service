import { describe, expect, it } from "vitest";
import {
  base62,
  contentHash,
  deliveryId,
  deterministicUuid,
  eventDeliveryGroup,
  newAttemptRunId,
  nonceFor,
} from "../src/ingest/identity";

describe("acceptance identities", () => {
  it("uses byte-exact SHA-256 and UUIDv8 with known test vectors", async () => {
    expect(await contentHash("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await deterministicUuid("abc")).toBe("ba7816bf-8f01-8fea-8141-40de5dae2223");
    expect(await deterministicUuid("abc")).toBe(await deterministicUuid("abc"));
    expect(await deterministicUuid("abc")).not.toBe(await deterministicUuid("abcd"));
    expect(await contentHash("abc\n")).not.toBe(await contentHash("abc"));
  });
  it("uses fixed delivery templates and deterministic Discord-sized nonces", async () => {
    expect(eventDeliveryGroup("000123")).toBe("evt:000123");
    const id = deliveryId(eventDeliveryGroup("000123"), 1);
    expect(id).toBe("out:evt:000123:1");
    expect(await nonceFor(id)).toMatch(/^[0-9A-Za-z]{1,25}$/u);
    expect(await nonceFor(id)).toBe(await nonceFor(id));
    expect(await nonceFor(id)).not.toBe(await nonceFor(deliveryId("evt:000123", 2)));
  });
  it.each([
    [[], "0"],
    [[0], "0"],
    [[61], "z"],
    [[62], "10"],
    [[255], "47"],
    [[1, 0], "48"],
  ])("encodes big-endian bytes %j", (bytes, result) => {
    expect(base62(new Uint8Array(bytes as number[]))).toBe(result);
  });
  it("mints fresh run IDs while deterministic IDs stay stable", () => {
    const first = newAttemptRunId();
    expect(first).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u);
    expect(newAttemptRunId()).not.toBe(first);
  });
});

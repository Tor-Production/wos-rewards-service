const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** UUIDv8: the first 128 SHA-256 bits, with RFC UUID version and variant bits set. */
export async function deterministicUuid(value: string): Promise<string> {
  const bytes = (await sha256(value)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const encoded = hex(bytes);
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
}

export function eventDeliveryGroup(eventId: string): string {
  return `evt:${eventId}`;
}

export function deliveryId(group: string, chunkIndex: number): string {
  return `out:${group}:${chunkIndex}`;
}

/** Big-endian bytes encoded with the fixed 0-9, A-Z, a-z alphabet. */
export function base62(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  if (value === 0n) return "0";
  let encoded = "";
  while (value > 0n) {
    encoded = BASE62_ALPHABET[Number(value % 62n)]! + encoded;
    value /= 62n;
  }
  return encoded;
}

export async function nonceFor(id: string): Promise<string> {
  return base62(await sha256(id)).slice(0, 25);
}

export async function contentHash(content: string): Promise<string> {
  return hex(await sha256(content));
}

/** A fresh invocation identity; unlike operation/job IDs this is intentionally nondeterministic. */
export function newAttemptRunId(): string {
  return crypto.randomUUID();
}

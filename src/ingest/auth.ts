/** Digest normalization gives timingSafeEqual fixed, equal-length buffers. Never log inputs. */
export async function verifyIngestionAuth(request: Request, secret: string): Promise<boolean> {
  const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match?.[1]) return false;
  const encoder = new TextEncoder();
  const supplied = await crypto.subtle.digest("SHA-256", encoder.encode(match[1]));
  const expected = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.timingSafeEqual(supplied, expected);
}

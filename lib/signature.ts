import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Assinatura compatível com o legacy-bridge:
 *   x-bridge-signature = "sha256=" + hex(HMAC-SHA256(secret, "{timestamp}.{rawBody}"))
 * calculada sobre os bytes brutos do corpo.
 */

export type SignatureStatus = "valid" | "invalid" | "missing" | "not_configured";

export const SIGNATURE_HEADER = "x-bridge-signature";
export const TIMESTAMP_HEADER = "x-bridge-timestamp";
export const TOLERANCE_SECONDS = 300;

export function computeSignature(secret: string, timestamp: string, rawBody: Uint8Array): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.`, "utf8");
  hmac.update(rawBody);
  return `sha256=${hmac.digest("hex")}`;
}

export function verifySignature(params: {
  secret: string | null;
  signature: string | null;
  timestamp: string | null;
  rawBody: Uint8Array;
  nowSeconds?: number;
}): SignatureStatus {
  const { secret, signature, timestamp, rawBody } = params;
  if (!secret) return "not_configured";
  if (!signature || !timestamp) return "missing";

  const expected = Buffer.from(computeSignature(secret, timestamp, rawBody), "utf8");
  const received = Buffer.from(signature, "utf8");
  // Tamanhos diferentes contam como inválido (timingSafeEqual exige o mesmo tamanho).
  const matches = expected.length === received.length && timingSafeEqual(expected, received);

  if (!/^\d{1,12}$/.test(timestamp)) return "invalid";
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) return "invalid";

  return matches ? "valid" : "invalid";
}

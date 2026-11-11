import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { serverEnv } from "@/lib/env";

/**
 * AES-256-GCM para os segredos dos endpoints.
 * Formato guardado: base64(iv).base64(tag).base64(ciphertext)
 */

const IV_BYTES = 12;

function key(): Buffer {
  return Buffer.from(serverEnv.ENCRYPTION_KEY, "base64");
}

export function encryptSecret(plaintext: string, encryptionKey: Buffer = key()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(payload: string, encryptionKey: Buffer = key()): string {
  const parts = payload.split(".");
  if (parts.length !== 3) {
    throw new Error("Segredo cifrado em formato inválido.");
  }
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Segredo novo para um endpoint: 32 bytes aleatórios em hex. */
export function generateEndpointSecret(): string {
  return randomBytes(32).toString("hex");
}

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** 12 caracteres [a-z0-9], sem viés de módulo. */
export function generateEndpointSlug(length = 12): string {
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 252 = 36 * 7: descarta bytes que causariam viés.
      if (byte < 252) out += SLUG_ALPHABET[byte % 36];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Token de convite: 32 bytes aleatórios em base64url. */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

import { createHash, randomBytes } from "node:crypto";

/**
 * Chaves de API da organização. A chave em texto só existe no momento da criação:
 * o banco guarda o prefixo (para identificar na UI) e o sha256.
 */

const KEY_PREFIX = "hbk_";
const KEY_RE = /^hbk_[A-Za-z0-9_-]{43}$/; // 32 bytes em base64url = 43 caracteres
const BEARER_RE = /^Bearer (hbk_[A-Za-z0-9_-]{43})$/;

/** Quantos caracteres da chave ficam visíveis (coluna api_keys.prefix). */
export const API_KEY_PREFIX_LENGTH = 12;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, API_KEY_PREFIX_LENGTH), hash: hashApiKey(key) };
}

export function isApiKeyFormat(value: string): boolean {
  return KEY_RE.test(value);
}

/** Extrai a chave de `Authorization: Bearer hbk_...`. Qualquer outro formato → null. */
export function parseBearer(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  return BEARER_RE.exec(authorizationHeader)?.[1] ?? null;
}

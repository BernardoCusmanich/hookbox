import { isIP } from "node:net";
import { REDACTED } from "@/lib/ingest-constants";

export { REDACTED };

/** Funções puras usadas pela ingestão em /in/[slug]. */

export const MAX_BODY_BYTES = 256 * 1024;

/** Valores gravados como "[redacted]". */
export const REDACTED_HEADERS = new Set(["authorization", "cookie", "proxy-authorization", "x-api-key"]);

/**
 * Cabeçalhos injetados pela infraestrutura da Vercel (x-vercel-*), como o token OIDC
 * do projeto. Não vieram do provedor do webhook e não devem ser gravados nem reenviados.
 */
function isInfrastructureHeader(name: string): boolean {
  return name.startsWith("x-vercel-");
}

export function sanitizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, rawName) => {
    const name = rawName.toLowerCase();
    if (isInfrastructureHeader(name)) return;
    out[name] = REDACTED_HEADERS.has(name) ? REDACTED : value;
  });
  return out;
}

export function decodeBody(bytes: Uint8Array): { body: string; encoding: "utf8" | "base64" } {
  if (bytes.byteLength === 0) return { body: "", encoding: "utf8" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    // O Postgres não aceita \u0000 em colunas text.
    if (!text.includes("\u0000")) return { body: text, encoding: "utf8" };
  } catch {
    // não é UTF-8 válido
  }
  return { body: Buffer.from(bytes).toString("base64"), encoding: "base64" };
}

export function encodeBody(body: string | null, encoding: string): Buffer {
  if (!body) return Buffer.alloc(0);
  return encoding === "base64" ? Buffer.from(body, "base64") : Buffer.from(body, "utf8");
}

/** Primeiro valor de x-forwarded-for (a Vercel sobrescreve esse cabeçalho com o IP real). */
export function clientIp(headers: Headers): string | null {
  const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (first && isIP(first)) return first;
  const real = headers.get("x-real-ip")?.trim();
  return real && isIP(real) ? real : null;
}

/**
 * Query string em JSON. Parâmetros `x-vercel-*` (como o `x-vercel-protection-bypass`, usado para
 * passar pela proteção das previews) são descartados, pela mesma regra dos headers.
 */
export function queryToJson(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    if (isInfrastructureHeader(key.toLowerCase())) continue;
    const values = params.getAll(key);
    out[key] = values.length === 1 ? values[0] : values;
  }
  return out;
}

/**
 * Resultado combinado dos limites (por slug e por IP). Devolve os segundos para o
 * header Retry-After, ou null se a requisição pode passar.
 */
export function retryAfterSeconds(
  results: { success: boolean; reset: number }[],
  now = Date.now(),
): number | null {
  const blocked = results.filter((r) => !r.success);
  if (blocked.length === 0) return null;
  const reset = Math.max(...blocked.map((r) => r.reset));
  return Math.max(1, Math.ceil((reset - now) / 1000));
}

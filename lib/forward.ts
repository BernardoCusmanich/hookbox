import { Agent, fetch as undiciFetch } from "undici";
import { REDACTED_HEADERS, encodeBody } from "@/lib/ingest";
import { isIP } from "node:net";
import { isBlockedAddress, safeLookup } from "@/lib/ssrf";

/** Reenvio de uma requisição gravada para a forward_url do endpoint. */

export const FORWARD_TIMEOUT_MS = 10_000;

const DROPPED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  // hop-by-hop que o undici recusa
  "keep-alive",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
  "expect",
]);

export function buildForwardHeaders(
  stored: Record<string, unknown>,
  requestId: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(stored)) {
    const key = name.toLowerCase();
    if (DROPPED_HEADERS.has(key) || REDACTED_HEADERS.has(key)) continue;
    if (typeof value !== "string") continue;
    out[key] = value;
  }
  out["x-hookbox-request-id"] = requestId;
  return out;
}

export type DeliveryOutcome =
  | { kind: "success"; statusCode: number }
  | { kind: "permanent"; statusCode: number | null; error: string }
  | { kind: "retry"; statusCode: number | null; error: string };

export function classifyStatus(status: number): DeliveryOutcome {
  if (status >= 200 && status < 300) return { kind: "success", statusCode: status };
  if (status >= 300 && status < 400) {
    return { kind: "permanent", statusCode: status, error: `Redirecionamento (${status}) não é seguido.` };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: "retry", statusCode: status, error: `Destino respondeu ${status}.` };
  }
  return { kind: "permanent", statusCode: status, error: `Destino respondeu ${status}.` };
}

let agent: Agent | undefined;

function dispatcher(): Agent {
  // O lookup confere o IP no momento da conexão (protege contra DNS rebinding).
  agent ??= new Agent({ connect: { lookup: safeLookup, timeout: FORWARD_TIMEOUT_MS } });
  return agent;
}

export async function sendForward(params: {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  bodyEncoding: string;
  /** Só para testes: troca o dispatcher (que bloqueia IPs internos) e o timeout. */
  testOverrides?: { dispatcher: Agent; timeoutMs: number };
}): Promise<DeliveryOutcome & { durationMs: number }> {
  const method = params.method.toUpperCase();
  const timeoutMs = params.testOverrides?.timeoutMs ?? FORWARD_TIMEOUT_MS;
  const hasBody = method !== "GET" && method !== "HEAD";
  const started = performance.now();

  // IP literal não passa pelo lookup do socket: confere aqui.
  const host = params.url.hostname.replace(/^\[|\]$/g, "");
  if (!params.testOverrides && isIP(host) && isBlockedAddress(host)) {
    return { kind: "permanent", statusCode: null, error: "Destino é um endereço bloqueado.", durationMs: 0 };
  }

  try {
    const response = await undiciFetch(params.url, {
      method,
      headers: params.headers,
      body: hasBody ? encodeBody(params.body, params.bodyEncoding) : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher: params.testOverrides?.dispatcher ?? dispatcher(),
    });
    await response.body?.cancel().catch(() => {});
    return { ...classifyStatus(response.status), durationMs: Math.round(performance.now() - started) };
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const blocked = (err as { cause?: { code?: string } })?.cause?.code === "EBLOCKED";
    return { kind: blocked ? "permanent" : "retry", statusCode: null, error: describeFetchError(err), durationMs };
  }
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `Timeout de ${FORWARD_TIMEOUT_MS / 1000} s.`;
    }
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === "EBLOCKED") return "Destino resolveu para um endereço bloqueado.";
    const detail = cause?.code ?? cause?.message ?? err.message;
    return `Erro de rede: ${detail}`.slice(0, 500);
  }
  return "Erro de rede.";
}

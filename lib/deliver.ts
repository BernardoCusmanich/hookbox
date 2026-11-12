import { z } from "zod";
import { buildForwardHeaders, type sendForward } from "@/lib/forward";
import { ForwardUrlError } from "@/lib/ssrf";

/**
 * Lógica do /api/deliver (worker do QStash), sem dependências de servidor
 * (Supabase, Upstash, env) para poder ser testada com fakes em memória.
 */

export type LoadedRequest = {
  id: string;
  org_id: string;
  method: string;
  headers: unknown;
  body: string | null;
  body_encoding: string;
  endpoints: { forward_url: string | null; forward_enabled: boolean } | null;
  organizations: { is_demo: boolean } | null;
};

export type DeliveryRow = {
  request_id: string;
  org_id: string;
  attempt: number;
  status_code: number | null;
  error: string | null;
  duration_ms: number | null;
};

export type DeliveryDeps = {
  verifySignature(signature: string, rawBody: string): Promise<boolean>;
  loadRequest(requestId: string): Promise<{ data: LoadedRequest | null; error: { code?: string } | null }>;
  recordDelivery(row: DeliveryRow): Promise<void>;
  validateForwardUrl(url: string): Promise<URL>;
  sendForward: typeof sendForward;
};

export type DeliveryResult = { status: number; body: Record<string, unknown> };

const payloadSchema = z.object({ requestId: z.uuid() });

function done(message: string): DeliveryResult {
  return { status: 200, body: { ok: true, message } };
}

export async function handleDelivery(
  input: { rawBody: string; signature: string | null; retried: string | null },
  deps: DeliveryDeps,
): Promise<DeliveryResult> {
  const { rawBody, signature } = input;

  // Assinatura do QStash.
  if (!signature) return { status: 401, body: { ok: false } };
  try {
    const valid = await deps.verifySignature(signature, rawBody);
    if (!valid) return { status: 401, body: { ok: false } };
  } catch {
    return { status: 401, body: { ok: false } };
  }

  let requestId: string;
  try {
    requestId = payloadSchema.parse(JSON.parse(rawBody)).requestId;
  } catch {
    // Mensagem malformada: não adianta tentar de novo.
    return done("payload inválido");
  }

  const { data: req, error } = await deps.loadRequest(requestId);
  if (error) {
    console.error("[deliver] falha ao carregar requisição", error.code);
    return { status: 500, body: { ok: false } };
  }
  const endpoint = req?.endpoints;

  const attempt = (Number.parseInt(input.retried ?? "0", 10) || 0) + 1;

  async function record(
    loaded: LoadedRequest,
    statusCode: number | null,
    errorMessage: string | null,
    durationMs: number | null,
  ) {
    await deps.recordDelivery({
      request_id: loaded.id,
      org_id: loaded.org_id,
      attempt,
      status_code: statusCode,
      error: errorMessage ? errorMessage.slice(0, 500) : null,
      duration_ms: durationMs,
    });
  }

  // Na demo pública não há encaminhamento real: registra a tentativa e encerra.
  if (req?.organizations?.is_demo) {
    await record(req, null, "Encaminhamento desativado na demo.", null);
    return done("encaminhamento desativado na demo");
  }

  if (!req || !endpoint || !endpoint.forward_enabled || !endpoint.forward_url) {
    return done("encaminhamento desligado ou endpoint removido");
  }

  // Revalida a URL (SSRF) antes de cada envio.
  let url: URL;
  try {
    url = await deps.validateForwardUrl(endpoint.forward_url);
  } catch (err) {
    const message = err instanceof ForwardUrlError ? err.message : "URL de encaminhamento inválida.";
    await record(req, null, message, null);
    return done("url recusada");
  }

  const outcome = await deps.sendForward({
    url,
    method: req.method,
    headers: buildForwardHeaders((req.headers ?? {}) as Record<string, unknown>, req.id),
    body: req.body,
    bodyEncoding: req.body_encoding,
  });

  await record(req, outcome.statusCode, outcome.kind === "success" ? null : outcome.error, outcome.durationMs);

  if (outcome.kind === "retry") {
    return { status: 500, body: { ok: false, retry: true } };
  }
  return done(outcome.kind);
}

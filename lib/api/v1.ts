import { hashApiKey, parseBearer } from "@/lib/api-keys";
import { retryAfterSeconds } from "@/lib/ingest";

/**
 * Lógica da API pública /api/v1, sem dependências de servidor (Supabase, Upstash, env)
 * para poder ser testada com fakes em memória. As rotas só ligam as deps reais.
 *
 * Segurança: toda dep que lê dados recebe o orgId da chave e DEVE filtrar por ele
 * (a implementação real usa a service role, que ignora o RLS).
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export type EndpointItem = {
  id: string;
  name: string;
  slug: string;
  forward_enabled: boolean;
  forward_url: string | null;
  transform_template: string | null;
  created_at: string;
};

export type RequestSummary = {
  id: string;
  method: string;
  path: string;
  query: unknown;
  content_type: string | null;
  size_bytes: number;
  signature_status: string;
  received_at: string;
};

export type RequestDetail = RequestSummary & {
  endpoint_id: string;
  headers: unknown;
  body: string | null;
  body_encoding: string;
  ip: string | null;
  deliveries: {
    attempt: number;
    status_code: number | null;
    error: string | null;
    duration_ms: number | null;
    created_at: string;
  }[];
};

export type ApiDeps = {
  /** Chave pelo sha256. null se não existe. */
  findKey(hash: string): Promise<{ id: string; org_id: string } | null>;
  /** Atualiza last_used_at. Erros são ignorados. */
  touchKey(id: string): Promise<void>;
  /** 60 req/min por chave. Pode lançar (Redis fora do ar): a API segue (fail-open). */
  limit(keyId: string): Promise<{ success: boolean; reset: number }>;
  appUrl: string;
  listEndpoints(orgId: string): Promise<EndpointItem[]>;
  /** null se o endpoint não é da organização. `before` já validado (ISO 8601). */
  listRequests(
    orgId: string,
    endpointId: string,
    opts: { limit: number; before: string | null },
  ): Promise<RequestSummary[] | null>;
  /** null se a requisição não é da organização. */
  getRequest(orgId: string, requestId: string): Promise<RequestDetail | null>;
  /** Config de encaminhamento do endpoint da requisição. null se a requisição não é da organização. */
  getRequestForwarding(
    orgId: string,
    requestId: string,
  ): Promise<{ forward_enabled: boolean; forward_url: string | null } | null>;
  enqueueDelivery(requestId: string): Promise<void>;
};

export type ApiResponse = { status: number; body: unknown; headers?: Record<string, string> };

export function apiError(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): ApiResponse {
  return { status, body: { error: { code, message } }, ...(headers ? { headers } : {}) };
}

const unauthorized = () =>
  apiError(401, "unauthorized", "Chave de API ausente ou inválida.", { "WWW-Authenticate": "Bearer" });
const notFound = () => apiError(404, "not_found", "Recurso não encontrado.");
const internalError = () => apiError(500, "internal_error", "Erro interno. Tente de novo.");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Autentica pela chave, aplica o rate limit e executa `run` com o orgId da chave.
 * O last_used_at é atualizado em paralelo, sem atrasar nem derrubar a resposta.
 */
async function withAuth(
  authorization: string | null,
  deps: ApiDeps,
  run: (orgId: string) => Promise<ApiResponse>,
): Promise<ApiResponse> {
  try {
    const key = parseBearer(authorization);
    if (!key) return unauthorized();

    const record = await deps.findKey(hashApiKey(key));
    if (!record) return unauthorized();

    try {
      const result = await deps.limit(record.id);
      if (!result.success) {
        return apiError(429, "rate_limited", "Limite de 60 requisições por minuto excedido. Tente de novo em instantes.", {
          "Retry-After": String(retryAfterSeconds([result]) ?? 1),
        });
      }
    } catch {
      // Redis fora do ar: deixa passar (fail-open), como na ingestão.
      console.warn("[api] rate limit indisponível");
    }

    const touch = Promise.resolve()
      .then(() => deps.touchKey(record.id))
      .catch(() => undefined);
    const response = await run(record.org_id);
    await touch;
    return response;
  } catch (err) {
    console.error("[api] erro inesperado", err instanceof Error ? err.name : "");
    return internalError();
  }
}

export function handleListEndpoints(input: { authorization: string | null }, deps: ApiDeps): Promise<ApiResponse> {
  return withAuth(input.authorization, deps, async (orgId) => {
    const endpoints = await deps.listEndpoints(orgId);
    return {
      status: 200,
      body: {
        data: endpoints.map((e) => ({
          id: e.id,
          name: e.name,
          slug: e.slug,
          ingest_url: `${deps.appUrl}/in/${e.slug}`,
          forward_enabled: e.forward_enabled,
          forward_url: e.forward_url,
          transform_enabled: e.transform_template !== null && e.transform_template.trim() !== "",
          created_at: e.created_at,
        })),
      },
    };
  });
}

function summarize(r: RequestSummary) {
  return {
    id: r.id,
    method: r.method,
    path: r.path,
    query: r.query,
    content_type: r.content_type,
    size_bytes: r.size_bytes,
    signature_status: r.signature_status,
    received_at: r.received_at,
  };
}

/** Timestamps vêm do Postgres como "+00:00"; o cursor usa "Z" (não precisa de encode na URL). */
function toCursor(receivedAt: string): string {
  return receivedAt.replace(/\+00:00$/, "Z");
}

function parseLimit(raw: string | null): number | null {
  if (raw === null) return DEFAULT_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_LIMIT ? n : null;
}

function parseBefore(raw: string): string | null {
  // Um "+" sem encode na URL chega como espaço: "…T10:00:00 03:00" → "…T10:00:00+03:00".
  const value = raw.replace(/ (\d{2}:\d{2})$/, "+$1");
  return ISO_RE.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function handleListRequests(
  input: { authorization: string | null; endpointId: string; searchParams: URLSearchParams },
  deps: ApiDeps,
): Promise<ApiResponse> {
  return withAuth(input.authorization, deps, async (orgId) => {
    if (!UUID_RE.test(input.endpointId)) return notFound();

    const limit = parseLimit(input.searchParams.get("limit"));
    if (limit === null) {
      return apiError(400, "invalid_parameter", `O parâmetro limit deve ser um inteiro entre 1 e ${MAX_LIMIT}.`);
    }
    const rawBefore = input.searchParams.get("before");
    let before: string | null = null;
    if (rawBefore !== null) {
      before = parseBefore(rawBefore);
      if (before === null) {
        return apiError(400, "invalid_parameter", "O parâmetro before deve ser um timestamp ISO 8601 válido.");
      }
    }

    const requests = await deps.listRequests(orgId, input.endpointId, { limit, before });
    if (!requests) return notFound();

    const last = requests[requests.length - 1];
    return {
      status: 200,
      body: {
        data: requests.map(summarize),
        next_cursor: requests.length >= limit && last ? toCursor(last.received_at) : null,
      },
    };
  });
}

export function handleGetRequest(
  input: { authorization: string | null; requestId: string },
  deps: ApiDeps,
): Promise<ApiResponse> {
  return withAuth(input.authorization, deps, async (orgId) => {
    if (!UUID_RE.test(input.requestId)) return notFound();
    const request = await deps.getRequest(orgId, input.requestId);
    if (!request) return notFound();
    return {
      status: 200,
      body: {
        data: {
          ...summarize(request),
          endpoint_id: request.endpoint_id,
          headers: request.headers,
          body: request.body,
          body_encoding: request.body_encoding,
          ip: request.ip,
          deliveries: request.deliveries.map((d) => ({
            attempt: d.attempt,
            status_code: d.status_code,
            error: d.error,
            duration_ms: d.duration_ms,
            created_at: d.created_at,
          })),
        },
      },
    };
  });
}

export function handleResend(
  input: { authorization: string | null; requestId: string },
  deps: ApiDeps,
): Promise<ApiResponse> {
  return withAuth(input.authorization, deps, async (orgId) => {
    if (!UUID_RE.test(input.requestId)) return notFound();
    const forwarding = await deps.getRequestForwarding(orgId, input.requestId);
    if (!forwarding) return notFound();
    if (!forwarding.forward_enabled || !forwarding.forward_url) {
      return apiError(409, "forwarding_disabled", "Ative o encaminhamento do endpoint para reenviar.");
    }
    try {
      await deps.enqueueDelivery(input.requestId);
    } catch {
      console.error("[api] falha ao publicar no QStash", input.requestId);
      return apiError(502, "queue_error", "Não foi possível enfileirar o reenvio. Tente de novo.");
    }
    return { status: 202, body: { data: { queued: true } } };
  });
}

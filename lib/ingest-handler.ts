import { MAX_BODY_BYTES, clientIp, decodeBody, queryToJson, retryAfterSeconds, sanitizeHeaders } from "@/lib/ingest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature, type SignatureStatus } from "@/lib/signature";

/**
 * Lógica do /in/[slug], sem dependências de servidor (Supabase, Upstash, env)
 * para poder ser testada com fakes em memória.
 */

const SLUG_RE = /^[a-z0-9]{12}$/;

export type IngestEndpoint = {
  id: string;
  org_id: string;
  secret_ciphertext: string | null;
  forward_enabled: boolean;
};

export type IngestRow = {
  endpoint_id: string;
  org_id: string;
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: string;
  body_encoding: "utf8" | "base64";
  content_type: string | null;
  size_bytes: number;
  ip: string | null;
  signature_status: SignatureStatus;
};

export type IngestDeps = {
  limit(slug: string, ip: string | null): Promise<{ success: boolean; reset: number }[]>;
  findEndpoint(slug: string): Promise<{ data: IngestEndpoint | null; error: { code?: string } | null }>;
  decryptSecret(ciphertext: string): string;
  insertRequest(row: IngestRow): Promise<{ data: { id: string } | null; error: { code?: string } | null }>;
  enqueueDelivery(requestId: string): Promise<void>;
};

export type IngestResult = { status: number; body: unknown; headers?: Record<string, string> };

export async function handleIngest(
  input: { method: string; slug: string; url: string; headers: Headers; readBody(): Promise<Uint8Array> },
  deps: IngestDeps,
): Promise<IngestResult> {
  const { method, slug, headers } = input;
  const ip = clientIp(headers);

  // 1. Rate limit: 60/min por slug e 120/min por IP.
  try {
    const results = await deps.limit(slug, ip);
    const retryAfter = retryAfterSeconds(results);
    if (retryAfter !== null) {
      return { status: 429, body: { ok: false, error: "rate_limited" }, headers: { "Retry-After": String(retryAfter) } };
    }
  } catch {
    // Redis fora do ar: deixa passar (fail-open) para não perder webhooks.
    console.error("[in] rate limit indisponível");
  }

  // 2. Endpoint.
  if (!SLUG_RE.test(slug)) return { status: 404, body: { ok: false, error: "not_found" } };
  const { data: endpoint, error: endpointError } = await deps.findEndpoint(slug);
  if (endpointError) {
    console.error("[in] falha ao buscar endpoint", endpointError.code);
    return { status: 500, body: { ok: false, error: "internal_error" } };
  }
  if (!endpoint) return { status: 404, body: { ok: false, error: "not_found" } };

  // 3. Corpo bruto, no máximo 256 KB.
  const declared = Number(headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false, error: "payload_too_large" } };
  }
  const raw = await input.readBody();
  if (raw.byteLength > MAX_BODY_BYTES) {
    return { status: 413, body: { ok: false, error: "payload_too_large" } };
  }

  // 4. UTF-8 ou base64.
  const { body, encoding } = decodeBody(raw);

  // 7. Assinatura (informativa).
  let signatureStatus: SignatureStatus = "not_configured";
  if (endpoint.secret_ciphertext) {
    let secret: string | null = null;
    try {
      secret = deps.decryptSecret(endpoint.secret_ciphertext);
    } catch {
      console.error("[in] não foi possível decifrar o segredo do endpoint");
    }
    signatureStatus = secret
      ? verifySignature({
          secret,
          signature: headers.get(SIGNATURE_HEADER),
          timestamp: headers.get(TIMESTAMP_HEADER),
          rawBody: raw,
        })
      : "invalid";
  }

  const url = new URL(input.url);
  const { data: inserted, error: insertError } = await deps.insertRequest({
    endpoint_id: endpoint.id,
    org_id: endpoint.org_id,
    method,
    path: url.pathname,
    query: queryToJson(url.searchParams),
    headers: sanitizeHeaders(headers), // 5. minúsculas + redação
    body,
    body_encoding: encoding,
    content_type: headers.get("content-type"),
    size_bytes: raw.byteLength,
    ip, // 6.
    signature_status: signatureStatus,
  });
  if (insertError || !inserted) {
    console.error("[in] falha ao gravar requisição", insertError?.code);
    return { status: 500, body: { ok: false, error: "internal_error" } };
  }

  // 8. Encaminhamento. Uma requisição que já veio de um encaminhamento do Hookbox
  // (tem x-hookbox-request-id) é gravada, mas não é reencaminhada: evita loops entre
  // endpoints, inclusive por URLs alternativas do mesmo deploy.
  const isHookboxForward = headers.has("x-hookbox-request-id");
  if (endpoint.forward_enabled && !isHookboxForward) {
    try {
      await deps.enqueueDelivery(inserted.id);
    } catch {
      // A requisição já foi gravada; o usuário pode usar "Reenviar".
      console.error("[in] falha ao publicar no QStash", inserted.id);
    }
  }

  // 9.
  return { status: 200, body: { ok: true, id: inserted.id } };
}

import { NextResponse, type NextRequest } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import { MAX_BODY_BYTES, clientIp, decodeBody, queryToJson, retryAfterSeconds, sanitizeHeaders } from "@/lib/ingest";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature, type SignatureStatus } from "@/lib/signature";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueDelivery, rateLimiters } from "@/lib/upstash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9]{12}$/;

type Context = { params: Promise<{ slug: string }> };

function json(body: unknown, status: number, method: string, headers?: Record<string, string>) {
  // HEAD não tem corpo.
  if (method === "HEAD") return new NextResponse(null, { status, headers });
  return NextResponse.json(body, { status, headers });
}

async function handle(request: NextRequest, { params }: Context): Promise<Response> {
  const method = request.method.toUpperCase();
  const { slug } = await params;
  const ip = clientIp(request.headers);

  // 1. Rate limit: 60/min por slug e 120/min por IP.
  try {
    const { slug: bySlug, ip: byIp } = rateLimiters();
    const [s, i] = await Promise.all([
      bySlug.limit(slug),
      ip ? byIp.limit(ip) : Promise.resolve({ success: true, reset: 0 }),
    ]);
    const retryAfter = retryAfterSeconds([s, i]);
    if (retryAfter !== null) {
      return json({ ok: false, error: "rate_limited" }, 429, method, { "Retry-After": String(retryAfter) });
    }
  } catch {
    // Redis fora do ar: deixa passar (fail-open) para não perder webhooks.
    console.error("[in] rate limit indisponível");
  }

  // 2. Endpoint.
  if (!SLUG_RE.test(slug)) return json({ ok: false, error: "not_found" }, 404, method);
  const supabase = createAdminClient();
  const { data: endpoint, error: endpointError } = await supabase
    .from("endpoints")
    .select("id, org_id, secret_ciphertext, forward_enabled")
    .eq("slug", slug)
    .maybeSingle();
  if (endpointError) {
    console.error("[in] falha ao buscar endpoint", endpointError.code);
    return json({ ok: false, error: "internal_error" }, 500, method);
  }
  if (!endpoint) return json({ ok: false, error: "not_found" }, 404, method);

  // 3. Corpo bruto, no máximo 256 KB.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload_too_large" }, 413, method);
  }
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) {
    return json({ ok: false, error: "payload_too_large" }, 413, method);
  }

  // 4. UTF-8 ou base64.
  const { body, encoding } = decodeBody(raw);

  // 7. Assinatura (informativa).
  let signatureStatus: SignatureStatus = "not_configured";
  if (endpoint.secret_ciphertext) {
    let secret: string | null = null;
    try {
      secret = decryptSecret(endpoint.secret_ciphertext);
    } catch {
      console.error("[in] não foi possível decifrar o segredo do endpoint");
    }
    signatureStatus = secret
      ? verifySignature({
          secret,
          signature: request.headers.get(SIGNATURE_HEADER),
          timestamp: request.headers.get(TIMESTAMP_HEADER),
          rawBody: raw,
        })
      : "invalid";
  }

  const url = new URL(request.url);
  const { data: inserted, error: insertError } = await supabase
    .from("requests")
    .insert({
      endpoint_id: endpoint.id,
      org_id: endpoint.org_id,
      method,
      path: url.pathname,
      query: queryToJson(url.searchParams),
      headers: sanitizeHeaders(request.headers), // 5. minúsculas + redação
      body,
      body_encoding: encoding,
      content_type: request.headers.get("content-type"),
      size_bytes: raw.byteLength,
      ip, // 6.
      signature_status: signatureStatus,
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    console.error("[in] falha ao gravar requisição", insertError?.code);
    return json({ ok: false, error: "internal_error" }, 500, method);
  }

  // 8. Encaminhamento. Uma requisição que já veio de um encaminhamento do Hookbox
  // (tem x-hookbox-request-id) é gravada, mas não é reencaminhada: evita loops entre
  // endpoints, inclusive por URLs alternativas do mesmo deploy.
  const isHookboxForward = request.headers.has("x-hookbox-request-id");
  if (endpoint.forward_enabled && !isHookboxForward) {
    try {
      await enqueueDelivery(inserted.id);
    } catch {
      // A requisição já foi gravada; o usuário pode usar "Reenviar".
      console.error("[in] falha ao publicar no QStash", inserted.id);
    }
  }

  // 9.
  return json({ ok: true, id: inserted.id }, 200, method);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;

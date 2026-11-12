import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/lib/env";
import { buildForwardHeaders, sendForward } from "@/lib/forward";
import { ForwardUrlError, validateForwardUrl } from "@/lib/ssrf";
import { createAdminClient } from "@/lib/supabase/admin";
import { qstashReceiver } from "@/lib/upstash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const payloadSchema = z.object({ requestId: z.uuid() });

function done(message: string) {
  return NextResponse.json({ ok: true, message }, { status: 200 });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // Assinatura do QStash.
  const signature = request.headers.get("upstash-signature");
  if (!signature) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const valid = await qstashReceiver().verify({
      signature,
      body: rawBody,
      url: `${serverEnv.APP_URL}/api/deliver`,
    });
    if (!valid) return NextResponse.json({ ok: false }, { status: 401 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let requestId: string;
  try {
    requestId = payloadSchema.parse(JSON.parse(rawBody)).requestId;
  } catch {
    // Mensagem malformada: não adianta tentar de novo.
    return done("payload inválido");
  }

  const supabase = createAdminClient();
  const { data: req, error } = await supabase
    .from("requests")
    .select(
      "id, org_id, method, headers, body, body_encoding, endpoints ( forward_url, forward_enabled ), organizations ( is_demo )",
    )
    .eq("id", requestId)
    .maybeSingle();
  if (error) {
    console.error("[deliver] falha ao carregar requisição", error.code);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  const endpoint = req?.endpoints;

  const attempt = (Number.parseInt(request.headers.get("upstash-retried") ?? "0", 10) || 0) + 1;

  async function record(statusCode: number | null, errorMessage: string | null, durationMs: number | null) {
    const { error: insertError } = await supabase.from("deliveries").insert({
      request_id: req!.id,
      org_id: req!.org_id,
      attempt,
      status_code: statusCode,
      error: errorMessage ? errorMessage.slice(0, 500) : null,
      duration_ms: durationMs,
    });
    if (insertError) console.error("[deliver] falha ao gravar entrega", insertError.code);
  }

  // Na demo pública não há encaminhamento real: registra a tentativa e encerra.
  if (req?.organizations?.is_demo) {
    await record(null, "Encaminhamento desativado na demo.", null);
    return done("encaminhamento desativado na demo");
  }

  if (!req || !endpoint || !endpoint.forward_enabled || !endpoint.forward_url) {
    return done("encaminhamento desligado ou endpoint removido");
  }

  // Revalida a URL (SSRF) antes de cada envio.
  let url: URL;
  try {
    url = await validateForwardUrl(endpoint.forward_url, {
      appUrl: serverEnv.APP_URL,
      requireHttps: process.env.NODE_ENV === "production",
    });
  } catch (err) {
    const message = err instanceof ForwardUrlError ? err.message : "URL de encaminhamento inválida.";
    await record(null, message, null);
    return done("url recusada");
  }

  const outcome = await sendForward({
    url,
    method: req.method,
    headers: buildForwardHeaders((req.headers ?? {}) as Record<string, unknown>, req.id),
    body: req.body,
    bodyEncoding: req.body_encoding,
  });

  await record(outcome.statusCode, outcome.kind === "success" ? null : outcome.error, outcome.durationMs);

  if (outcome.kind === "retry") {
    return NextResponse.json({ ok: false, retry: true }, { status: 500 });
  }
  return done(outcome.kind);
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, encryptSecret, generateEndpointSecret } from "@/lib/crypto";
import { computeSignature, type SignatureStatus } from "@/lib/signature";
import type { Database, Json } from "@/lib/supabase/types";

/**
 * Dados da organização demo. Usado pelo seed e pelo cron de limpeza.
 * Recebe o cliente admin por parâmetro (quem chama é que tem permissão para usá-lo).
 */

type Admin = SupabaseClient<Database>;

import {
  DEMO_ENDPOINT_PLAIN,
  DEMO_ENDPOINT_SIGNED,
  DEMO_ENDPOINT_SLUGS,
  DEMO_ORG_SLUG,
} from "@/lib/demo-constants";

export async function ensureDemoOrg(admin: Admin): Promise<string> {
  const { data, error } = await admin
    .from("organizations")
    .upsert({ name: "Demo", slug: DEMO_ORG_SLUG, is_demo: true }, { onConflict: "slug" })
    .select("id")
    .single();
  if (error) throw new Error(`organização demo: ${error.message}`);
  return data.id;
}

async function ensureDemoEndpoints(admin: Admin, orgId: string) {
  // Endpoints criados por visitantes somem no reset.
  const { error: cleanupError } = await admin
    .from("endpoints")
    .delete()
    .eq("org_id", orgId)
    .not("slug", "in", `(${DEMO_ENDPOINT_SLUGS.join(",")})`);
  if (cleanupError) throw new Error(`limpeza de endpoints: ${cleanupError.message}`);

  const { error: plainError } = await admin.from("endpoints").upsert(
    {
      org_id: orgId,
      slug: DEMO_ENDPOINT_PLAIN,
      name: "Loja virtual (sem segredo)",
      secret_ciphertext: null,
      forward_url: null,
      forward_enabled: false,
    },
    { onConflict: "slug" },
  );
  if (plainError) throw new Error(`endpoint demo: ${plainError.message}`);

  const { data: existing } = await admin
    .from("endpoints")
    .select("secret_ciphertext")
    .eq("slug", DEMO_ENDPOINT_SIGNED)
    .maybeSingle();
  let secret: string | null = null;
  if (existing?.secret_ciphertext) {
    try {
      secret = decryptSecret(existing.secret_ciphertext);
    } catch {
      secret = null; // ENCRYPTION_KEY mudou: gera outro
    }
  }
  secret ??= generateEndpointSecret();

  const { error: signedError } = await admin.from("endpoints").upsert(
    {
      org_id: orgId,
      slug: DEMO_ENDPOINT_SIGNED,
      name: "ERP via legacy-bridge (assinado)",
      secret_ciphertext: encryptSecret(secret),
      forward_url: "https://example.com/webhooks/erp",
      forward_enabled: false,
    },
    { onConflict: "slug" },
  );
  if (signedError) throw new Error(`endpoint demo assinado: ${signedError.message}`);

  const { data: endpoints, error } = await admin
    .from("endpoints")
    .select("id, slug")
    .in("slug", DEMO_ENDPOINT_SLUGS);
  if (error || !endpoints) throw new Error(`endpoints demo: ${error?.message}`);
  const bySlug = Object.fromEntries(endpoints.map((e) => [e.slug, e.id]));
  return { plainId: bySlug[DEMO_ENDPOINT_PLAIN], signedId: bySlug[DEMO_ENDPOINT_SIGNED], secret };
}

type Sample = {
  endpoint: "plain" | "signed";
  minutesAgo: number;
  method: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  binary?: Uint8Array;
  signature?: "valid" | "invalid" | "missing" | "stale";
};

function uuid7Like(i: number): string {
  return `019a7b3c-5e2f-7d41-9c3a-${(0x2b8e4f6a1d00 + i).toString(16).padStart(12, "0")}`;
}

function bridgeEvent(i: number, entity: string, operation: string, entityId: number, data: unknown) {
  return JSON.stringify({
    eventId: uuid7Like(i),
    occurredAt: new Date(Date.now() - i * 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
    source: "erp-demo",
    entity,
    operation,
    entityId,
    data,
  });
}

function samples(): Sample[] {
  return [
    {
      endpoint: "signed",
      minutesAgo: 2,
      method: "POST",
      signature: "valid",
      body: bridgeEvent(1, "pedido", "updated", 123, {
        id: 123,
        clienteId: 7,
        data: "2026-11-10T09:12:00",
        status: "PAGO",
        total: 412.9,
      }),
    },
    {
      endpoint: "signed",
      minutesAgo: 9,
      method: "POST",
      signature: "valid",
      body: bridgeEvent(2, "cliente", "created", 7, {
        id: 7,
        nome: "Comercial Exemplo Ltda",
        cidade: "Campinas",
        uf: "SP",
      }),
    },
    {
      endpoint: "signed",
      minutesAgo: 17,
      method: "POST",
      signature: "invalid",
      body: bridgeEvent(3, "produto", "updated", 55, { id: 55, descricao: "Parafuso M8", estoque: 1200 }),
    },
    {
      endpoint: "signed",
      minutesAgo: 31,
      method: "POST",
      signature: "valid",
      body: bridgeEvent(4, "pedido", "deleted", 98, null),
    },
    {
      endpoint: "signed",
      minutesAgo: 44,
      method: "POST",
      signature: "missing",
      body: bridgeEvent(5, "pedido", "created", 124, { id: 124, clienteId: 3, status: "ABERTO", total: 89.5 }),
    },
    {
      endpoint: "signed",
      minutesAgo: 63,
      method: "POST",
      signature: "stale",
      body: bridgeEvent(6, "cliente", "updated", 3, { id: 3, nome: "Mercado Bom Preço", uf: "MG" }),
    },
    {
      endpoint: "plain",
      minutesAgo: 5,
      method: "POST",
      query: { source: "checkout" },
      headers: { "user-agent": "Shopify-Captain-Hook", authorization: "Bearer sk_live_exemplo" },
      body: JSON.stringify({
        id: "ord_1029",
        event: "order.paid",
        customer: { name: "Ana Souza", email: "ana@example.com" },
        items: [
          { sku: "CAM-P-AZ", qty: 2, price: 59.9 },
          { sku: "BON-UNI", qty: 1, price: 39.9 },
        ],
        total: 159.7,
        currency: "BRL",
      }),
    },
    {
      endpoint: "plain",
      minutesAgo: 22,
      method: "GET",
      query: { ping: "1", attempt: "3" },
      headers: { "user-agent": "curl/8.7.1" },
    },
    {
      endpoint: "plain",
      minutesAgo: 38,
      method: "PUT",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "legacy-crm/2.1" },
      body: "cliente_id=42&status=inativo&motivo=sem+compras+ha+180+dias",
    },
    {
      endpoint: "plain",
      minutesAgo: 75,
      method: "POST",
      headers: { "content-type": "application/octet-stream", "user-agent": "iot-gateway/0.9" },
      binary: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x10, 0x20]),
    },
  ];
}

/** Apaga as requisições da org demo e recria os 10 exemplos. Garante também os endpoints. */
export async function resetDemoOrg(admin: Admin): Promise<{ orgId: string; inserted: number }> {
  const orgId = await ensureDemoOrg(admin);
  const { plainId, signedId, secret } = await ensureDemoEndpoints(admin, orgId);

  const { error: deleteError } = await admin.from("requests").delete().eq("org_id", orgId);
  if (deleteError) throw new Error(`limpeza de requests: ${deleteError.message}`);

  const now = Date.now();
  const rows = samples().map((s, index) => {
    const receivedAt = new Date(now - s.minutesAgo * 60_000);
    const raw = s.binary ?? new TextEncoder().encode(s.body ?? "");
    const isBinary = Boolean(s.binary);
    const contentType = s.headers?.["content-type"] ?? (s.body ? "application/json" : null);

    const headers: Record<string, string> = {
      host: "hookbox.example",
      accept: "*/*",
      ...(contentType ? { "content-type": contentType } : {}),
      ...(raw.byteLength ? { "content-length": String(raw.byteLength) } : {}),
      "x-forwarded-for": "203.0.113.10",
      ...s.headers,
    };
    if (headers.authorization) headers.authorization = "[redacted]";

    let status: SignatureStatus = "not_configured";
    if (s.endpoint === "signed") {
      headers["user-agent"] = "LegacyBridge/1.0";
      headers["x-bridge-event-id"] = JSON.parse(s.body ?? "{}").eventId ?? uuid7Like(index + 1);
      const ts = Math.floor(receivedAt.getTime() / 1000) - (s.signature === "stale" ? 900 : 0);
      if (s.signature === "missing") {
        status = "missing";
      } else {
        headers["x-bridge-timestamp"] = String(ts);
        headers["x-bridge-signature"] =
          s.signature === "invalid"
            ? computeSignature("segredo-antigo-rotacionado", String(ts), raw)
            : computeSignature(secret, String(ts), raw);
        status = s.signature === "valid" ? "valid" : "invalid";
      }
    }

    return {
      endpoint_id: s.endpoint === "plain" ? plainId : signedId,
      org_id: orgId,
      method: s.method,
      path: `/in/${s.endpoint === "plain" ? DEMO_ENDPOINT_PLAIN : DEMO_ENDPOINT_SIGNED}`,
      query: (s.query ?? {}) as { [key: string]: Json },
      headers: headers as { [key: string]: Json },
      body: isBinary ? Buffer.from(raw).toString("base64") : (s.body ?? ""),
      body_encoding: isBinary ? "base64" : "utf8",
      content_type: contentType,
      size_bytes: raw.byteLength,
      ip: "203.0.113.10",
      signature_status: status,
      received_at: receivedAt.toISOString(),
    };
  });

  const { error } = await admin.from("requests").insert(rows);
  if (error) throw new Error(`inserção de requests: ${error.message}`);
  return { orgId, inserted: rows.length };
}

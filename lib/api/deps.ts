import "server-only";
import { NextResponse } from "next/server";
import type { ApiDeps, ApiResponse } from "@/lib/api/v1";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueDelivery, rateLimiters } from "@/lib/upstash";

/**
 * Deps reais da API /api/v1. O cliente admin ignora o RLS: TODA consulta abaixo filtra
 * por org_id da chave de API. Erros do banco são lançados (a lógica devolve 500).
 */
export function apiDeps(): ApiDeps {
  const admin = createAdminClient();

  return {
    async findKey(hash) {
      const { data, error } = await admin.from("api_keys").select("id, org_id").eq("key_hash", hash).maybeSingle();
      if (error) throw new Error(`falha ao buscar chave (${error.code})`);
      return data;
    },
    async touchKey(id) {
      await admin.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", id);
    },
    limit: (keyId) => rateLimiters().api.limit(keyId),
    appUrl: serverEnv.APP_URL,
    async listEndpoints(orgId) {
      const { data, error } = await admin
        .from("endpoints")
        .select("id, name, slug, forward_enabled, forward_url, transform_template, created_at")
        .eq("org_id", orgId)
        .order("created_at", { ascending: true });
      if (error) throw new Error(`falha ao listar endpoints (${error.code})`);
      return data;
    },
    async listRequests(orgId, endpointId, { limit, before }) {
      const { data: endpoint, error: endpointError } = await admin
        .from("endpoints")
        .select("id")
        .eq("id", endpointId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (endpointError) throw new Error(`falha ao buscar endpoint (${endpointError.code})`);
      if (!endpoint) return null;

      let query = admin
        .from("requests")
        .select("id, method, path, query, content_type, size_bytes, signature_status, received_at")
        .eq("org_id", orgId)
        .eq("endpoint_id", endpointId)
        .order("received_at", { ascending: false })
        .limit(limit);
      if (before) query = query.lt("received_at", before);
      const { data, error } = await query;
      if (error) throw new Error(`falha ao listar requisições (${error.code})`);
      return data;
    },
    async getRequest(orgId, requestId) {
      const { data, error } = await admin
        .from("requests")
        .select(
          "id, endpoint_id, method, path, query, headers, body, body_encoding, content_type, size_bytes, ip, signature_status, received_at, deliveries ( attempt, status_code, error, duration_ms, created_at )",
        )
        .eq("id", requestId)
        .eq("org_id", orgId)
        .order("created_at", { referencedTable: "deliveries", ascending: true })
        .maybeSingle();
      if (error) throw new Error(`falha ao buscar requisição (${error.code})`);
      // inet chega como string; os tipos gerados o representam como unknown.
      return data ? { ...data, ip: typeof data.ip === "string" ? data.ip : null } : null;
    },
    async getRequestForwarding(orgId, requestId) {
      const { data, error } = await admin
        .from("requests")
        .select("endpoints ( forward_enabled, forward_url )")
        .eq("id", requestId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (error) throw new Error(`falha ao buscar requisição (${error.code})`);
      if (!data) return null;
      // Endpoint removido leva as requisições junto (cascade); sem ele, trata como desligado.
      return data.endpoints ?? { forward_enabled: false, forward_url: null };
    },
    enqueueDelivery,
  };
}

/** Converte o resultado da lógica em Response. Nada da API é cacheável. */
export function toResponse({ status, body, headers }: ApiResponse): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

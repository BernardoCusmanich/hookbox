import { NextResponse, type NextRequest } from "next/server";
import { handleDelivery, type DeliveryDeps } from "@/lib/deliver";
import { serverEnv } from "@/lib/env";
import { sendForward } from "@/lib/forward";
import { validateForwardUrl } from "@/lib/ssrf";
import { createAdminClient } from "@/lib/supabase/admin";
import { qstashReceiver } from "@/lib/upstash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const deps: DeliveryDeps = {
    async verifySignature(signature, body) {
      try {
        return await qstashReceiver().verify({
          signature,
          body,
          url: `${serverEnv.APP_URL}/api/deliver`,
        });
      } catch {
        return false;
      }
    },
    async loadRequest(requestId) {
      const { data, error } = await createAdminClient()
        .from("requests")
        .select(
          "id, org_id, method, headers, body, body_encoding, endpoints ( forward_url, forward_enabled ), organizations ( is_demo )",
        )
        .eq("id", requestId)
        .maybeSingle();
      return { data, error };
    },
    async recordDelivery(row) {
      const { error } = await createAdminClient().from("deliveries").insert(row);
      if (error) console.error("[deliver] falha ao gravar entrega", error.code);
    },
    validateForwardUrl: (url) =>
      validateForwardUrl(url, {
        appUrl: serverEnv.APP_URL,
        requireHttps: process.env.NODE_ENV === "production",
      }),
    sendForward,
  };

  const { status, body } = await handleDelivery(
    {
      rawBody,
      signature: request.headers.get("upstash-signature"),
      retried: request.headers.get("upstash-retried"),
    },
    deps,
  );
  return NextResponse.json(body, { status });
}

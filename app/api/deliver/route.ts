import { NextResponse, type NextRequest } from "next/server";
import { sendFailureAlert } from "@/lib/alerts";
import { handleDelivery, type DeliveryDeps } from "@/lib/deliver";
import { serverEnv } from "@/lib/env";
import { sendForward } from "@/lib/forward";
import { validateForwardUrl } from "@/lib/ssrf";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/email";
import { acquireAlertThrottle, qstashReceiver } from "@/lib/upstash";

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
          "id, org_id, method, headers, body, body_encoding, endpoints ( id, name, forward_url, forward_enabled ), organizations ( slug, is_demo )",
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
    async notifyFailure(info) {
      const result = await sendFailureAlert(info, {
        appUrl: serverEnv.APP_URL,
        enabled: Boolean(serverEnv.RESEND_API_KEY),
        ownerEmails,
        acquireThrottle: acquireAlertThrottle,
        sendEmail,
      });
      console.info("[deliver] alerta de falha:", result);
    },
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

/** E-mails dos owners da organização (auth.users só é acessível pela service role). */
async function ownerEmails(orgId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("memberships").select("user_id").eq("org_id", orgId).eq("role", "owner");
  if (error) throw new Error(`falha ao listar owners (${error.code})`);
  const users = await Promise.all((data ?? []).map((m) => admin.auth.admin.getUserById(m.user_id)));
  return users.flatMap(({ data: u }) => (u.user?.email ? [u.user.email] : []));
}

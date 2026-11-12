import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { Inspector } from "./inspector";

export const metadata: Metadata = { title: "Inspetor" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EndpointPage({ params }: PageProps<"/app/[orgSlug]/endpoints/[id]">) {
  const { orgSlug, id } = await params;
  if (!UUID_RE.test(id)) notFound();
  const { supabase, org } = await requireOrg(orgSlug);

  const { data: endpoint } = await supabase
    .from("endpoints")
    .select("id, name, slug, forward_url, forward_enabled, transform_template, secret_ciphertext")
    .eq("id", id)
    .eq("org_id", org.id)
    .maybeSingle();
  if (!endpoint) notFound();

  const { data: requests } = await supabase
    .from("requests")
    .select("id, method, received_at, size_bytes, signature_status, content_type")
    .eq("endpoint_id", endpoint.id)
    .order("received_at", { ascending: false })
    .limit(100);

  return (
    <Inspector
      appUrl={serverEnv.APP_URL}
      orgSlug={org.slug}
      isDemo={org.is_demo}
      endpoint={{
        id: endpoint.id,
        name: endpoint.name,
        slug: endpoint.slug,
        forwardUrl: endpoint.forward_url,
        forwardEnabled: endpoint.forward_enabled,
        transformTemplate: endpoint.transform_template,
        // O ciphertext nunca vai para o navegador; só se existe ou não.
        hasSecret: Boolean(endpoint.secret_ciphertext),
      }}
      initialRequests={requests ?? []}
    />
  );
}

import { NextResponse, type NextRequest } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import { handleIngest, type IngestDeps } from "@/lib/ingest-handler";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueDelivery, rateLimiters } from "@/lib/upstash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ slug: string }> };

function json(body: unknown, status: number, method: string, headers?: Record<string, string>) {
  // HEAD não tem corpo.
  if (method === "HEAD") return new NextResponse(null, { status, headers });
  return NextResponse.json(body, { status, headers });
}

const deps: IngestDeps = {
  async limit(slug, ip) {
    const { slug: bySlug, ip: byIp } = rateLimiters();
    return Promise.all([
      bySlug.limit(slug),
      ip ? byIp.limit(ip) : Promise.resolve({ success: true, reset: 0 }),
    ]);
  },
  async findEndpoint(slug) {
    const { data, error } = await createAdminClient()
      .from("endpoints")
      .select("id, org_id, secret_ciphertext, forward_enabled")
      .eq("slug", slug)
      .maybeSingle();
    return { data, error };
  },
  decryptSecret,
  async insertRequest(row) {
    const { data, error } = await createAdminClient().from("requests").insert(row).select("id").single();
    return { data, error };
  },
  enqueueDelivery,
};

async function handle(request: NextRequest, { params }: Context): Promise<Response> {
  const method = request.method.toUpperCase();
  const { slug } = await params;

  const { status, body, headers } = await handleIngest(
    {
      method,
      slug,
      url: request.url,
      headers: request.headers,
      readBody: async () => new Uint8Array(await request.arrayBuffer()),
    },
    deps,
  );
  return json(body, status, method, headers);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;

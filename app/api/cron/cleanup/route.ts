import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { resetDemoOrg } from "@/lib/demo";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RETENTION_DAYS = 7;

function authorized(request: NextRequest): boolean {
  const received = Buffer.from(request.headers.get("authorization") ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${serverEnv.CRON_SECRET}`, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from("requests")
    .delete({ count: "exact" })
    .lt("received_at", cutoff);
  if (error) {
    console.error("[cron] falha ao apagar requests antigos", error.code);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  try {
    const demo = await resetDemoOrg(supabase);
    return NextResponse.json({ ok: true, deleted: count ?? 0, demo: { inserted: demo.inserted } });
  } catch (err) {
    console.error("[cron] falha ao resetar a demo", err instanceof Error ? err.message : "");
    return NextResponse.json({ ok: false, deleted: count ?? 0 }, { status: 500 });
  }
}

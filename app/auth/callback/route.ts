import { NextResponse, type NextRequest } from "next/server";
import { safeNextPath } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/** Retorno do magic link e do OAuth do GitHub (fluxo PKCE). */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${serverEnv.APP_URL}${next}`);
  }
  return NextResponse.redirect(`${serverEnv.APP_URL}/login?error=callback`);
}

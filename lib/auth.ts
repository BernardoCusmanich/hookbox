import "server-only";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export type Role = "owner" | "member";

/** Usuário logado (ou redireciona para /login). Memoizado por request. */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
});

/** Organização pelo slug + papel do usuário. 404 se não for membro. */
export const requireOrg = cache(async (orgSlug: string) => {
  const { supabase, user } = await requireUser();
  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, slug, is_demo")
    .eq("slug", orgSlug)
    .maybeSingle();
  if (!org) notFound();
  const { data: membership } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", org.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership) notFound();
  return { supabase, user, org, role: membership.role as Role };
});

/** Para redirects pós-login: só caminhos internos. */
export function safeNextPath(next: unknown, fallback = "/app"): string {
  if (typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

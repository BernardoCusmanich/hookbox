import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

export default async function AppIndex() {
  const { supabase, user } = await requireUser();
  const { data } = await supabase
    .from("memberships")
    .select("created_at, organizations ( slug )")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const slug = data?.organizations?.slug;
  redirect(slug ? `/app/${slug}/endpoints` : "/app/onboarding");
}

import type { Metadata } from "next";
import { requireOrg } from "@/lib/auth";
import { isPast } from "@/lib/format";
import { ApiKeysSection, InvitesSection, MembersSection, OrgNameSection } from "./sections";

export const metadata: Metadata = { title: "Configurações" };

export default async function SettingsPage({ params }: PageProps<"/app/[orgSlug]/settings">) {
  const { orgSlug } = await params;
  const { supabase, user, org, role } = await requireOrg(orgSlug);
  const isOwner = role === "owner";

  const [{ data: members }, { data: invites }, { data: apiKeys }] = await Promise.all([
    supabase.rpc("org_members", { org: org.id }),
    isOwner
      ? supabase
          .from("invites")
          .select("id, email, role, expires_at, accepted_at, created_at")
          .eq("org_id", org.id)
          .is("accepted_at", null)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    isOwner
      ? supabase
          .from("api_keys")
          .select("id, name, prefix, created_at, last_used_at")
          .eq("org_id", org.id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-8 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Configurações</h1>
        <p className="text-sm text-muted-foreground">
          {isOwner
            ? "Gerencie a organização, os membros, os convites e as chaves de API."
            : "Só owners podem alterar a organização, os membros e os convites."}
        </p>
      </div>
      <OrgNameSection orgId={org.id} name={org.name} canEdit={isOwner} />
      <MembersSection orgId={org.id} members={members ?? []} currentUserId={user.id} canEdit={isOwner} />
      {isOwner && (
        <InvitesSection
          orgId={org.id}
          invites={(invites ?? []).map((invite) => ({ ...invite, expired: isPast(invite.expires_at) }))}
        />
      )}
      {isOwner && <ApiKeysSection orgId={org.id} apiKeys={apiKeys ?? []} isDemo={org.is_demo} />}
    </div>
  );
}

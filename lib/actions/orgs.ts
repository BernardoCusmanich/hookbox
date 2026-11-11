"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { generateInviteToken } from "@/lib/crypto";
import { serverEnv } from "@/lib/env";
import { ActionError, action, assertMember, dbErrorMessage, ok, uuid } from "@/lib/actions/shared";

const orgName = z
  .string()
  .trim()
  .min(2, { message: "O nome precisa ter pelo menos 2 caracteres." })
  .max(80, { message: "O nome pode ter no máximo 80 caracteres." });

export const createOrganization = action(z.object({ name: orgName }), async ({ name }, { supabase }) => {
  const { data, error } = await supabase.rpc("create_organization", { name });
  if (error || !data) throw new ActionError(error ? dbErrorMessage(error) : "Não foi possível criar.");
  revalidatePath("/app", "layout");
  return ok({ slug: data.slug });
});

export const renameOrganization = action(
  z.object({ orgId: uuid, name: orgName }),
  async ({ orgId, name }, { supabase, user }) => {
    await assertMember(supabase, user.id, orgId, { owner: true });
    const { error } = await supabase.from("organizations").update({ name }).eq("id", orgId);
    if (error) throw new ActionError(dbErrorMessage(error));
    revalidatePath("/app", "layout");
    return ok();
  },
);

const role = z.enum(["owner", "member"], { message: "Papel inválido." });

export const changeMemberRole = action(
  z.object({ orgId: uuid, userId: uuid, role }),
  async ({ orgId, userId, role }, { supabase, user }) => {
    await assertMember(supabase, user.id, orgId, { owner: true });
    const { data, error } = await supabase
      .from("memberships")
      .update({ role })
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .select("user_id");
    if (error) throw new ActionError(dbErrorMessage(error));
    if (!data?.length) throw new ActionError("Membro não encontrado.");
    revalidatePath("/app", "layout");
    return ok();
  },
);

export const removeMember = action(
  z.object({ orgId: uuid, userId: uuid }),
  async ({ orgId, userId }, { supabase, user }) => {
    await assertMember(supabase, user.id, orgId, { owner: true });
    const { data, error } = await supabase
      .from("memberships")
      .delete()
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .select("user_id");
    if (error) throw new ActionError(dbErrorMessage(error));
    if (!data?.length) throw new ActionError("Membro não encontrado.");
    revalidatePath("/app", "layout");
    return ok();
  },
);

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const createInvite = action(
  z.object({
    orgId: uuid,
    email: z.email({ message: "Informe um e-mail válido." }).max(254),
    role,
  }),
  async ({ orgId, email, role }, { supabase, user }) => {
    await assertMember(supabase, user.id, orgId, { owner: true });
    const token = generateInviteToken();
    const { error } = await supabase.from("invites").insert({
      org_id: orgId,
      email: email.toLowerCase(),
      role,
      token,
      expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
      created_by: user.id,
    });
    if (error) throw new ActionError(dbErrorMessage(error));
    revalidatePath("/app", "layout");
    return ok({ link: `${serverEnv.APP_URL}/invite/${token}` });
  },
);

export const revokeInvite = action(
  z.object({ orgId: uuid, inviteId: uuid }),
  async ({ orgId, inviteId }, { supabase, user }) => {
    await assertMember(supabase, user.id, orgId, { owner: true });
    const { error } = await supabase.from("invites").delete().eq("id", inviteId).eq("org_id", orgId);
    if (error) throw new ActionError(dbErrorMessage(error));
    revalidatePath("/app", "layout");
    return ok();
  },
);

export const acceptInvite = action(
  z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, { message: "Convite inválido." }) }),
  async ({ token }, { supabase }) => {
    const { data, error } = await supabase.rpc("accept_invite", { invite_token: token });
    if (error || !data) throw new ActionError(error ? dbErrorMessage(error) : "Convite inválido.");
    revalidatePath("/app", "layout");
    return ok({ slug: data });
  },
);

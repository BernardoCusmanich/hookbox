"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ActionError, action, assertMember, dbErrorMessage, ok, uuid } from "@/lib/actions/shared";
import { generateApiKey } from "@/lib/api-keys";

const keyName = z
  .string()
  .trim()
  .min(1, { message: "Dê um nome à chave." })
  .max(60, { message: "O nome pode ter no máximo 60 caracteres." });

/** A chave em texto só é devolvida aqui; o banco guarda apenas o prefixo e o hash. */
export const createApiKey = action(
  z.object({ orgId: uuid, name: keyName }),
  async ({ orgId, name }, { supabase, user }) => {
    await assertMember(supabase, user.id, orgId, { owner: true });
    const { key, prefix, hash } = generateApiKey();
    const { error } = await supabase
      .from("api_keys")
      .insert({ org_id: orgId, name, prefix, key_hash: hash, created_by: user.id });
    if (error) throw new ActionError(dbErrorMessage(error));
    revalidatePath("/app", "layout");
    return ok({ key });
  },
);

export const deleteApiKey = action(z.object({ keyId: uuid }), async ({ keyId }, { supabase, user }) => {
  const { data: apiKey } = await supabase.from("api_keys").select("id, org_id").eq("id", keyId).maybeSingle();
  if (!apiKey) throw new ActionError("Chave não encontrada.");
  await assertMember(supabase, user.id, apiKey.org_id, { owner: true });
  const { error } = await supabase.from("api_keys").delete().eq("id", keyId).eq("org_id", apiKey.org_id);
  if (error) throw new ActionError(dbErrorMessage(error));
  revalidatePath("/app", "layout");
  return ok();
});

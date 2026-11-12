"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { decryptSecret, encryptSecret, generateEndpointSecret, generateEndpointSlug } from "@/lib/crypto";
import { DEMO_ENDPOINT_SLUGS } from "@/lib/demo-constants";
import { serverEnv } from "@/lib/env";
import { ForwardUrlError, validateForwardUrl } from "@/lib/ssrf";
import { applyTransform, buildTransformContext, TransformError, validateTemplate } from "@/lib/transform";
import { enqueueDelivery } from "@/lib/upstash";
import { ActionError, action, assertMember, dbErrorMessage, ok, uuid } from "@/lib/actions/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

const MAX_ENDPOINTS = 5;

const endpointName = z
  .string()
  .trim()
  .min(1, { message: "Dê um nome ao endpoint." })
  .max(80, { message: "O nome pode ter no máximo 80 caracteres." });

/** Carrega o endpoint via RLS e confere a membership explicitamente. */
async function loadEndpoint(supabase: SupabaseClient<Database>, userId: string, endpointId: string) {
  const { data: endpoint } = await supabase
    .from("endpoints")
    .select("id, org_id, slug, secret_ciphertext, organizations ( is_demo )")
    .eq("id", endpointId)
    .maybeSingle();
  if (!endpoint) throw new ActionError("Endpoint não encontrado.");
  await assertMember(supabase, userId, endpoint.org_id);
  return endpoint;
}

export const createEndpoint = action(
  z.object({ orgId: uuid, name: endpointName }),
  async ({ orgId, name }, { supabase, user }) => {
    await assertMember(supabase, user.id, orgId);
    const { count } = await supabase
      .from("endpoints")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId);
    if ((count ?? 0) >= MAX_ENDPOINTS) {
      throw new ActionError(`Limite de ${MAX_ENDPOINTS} endpoints por organização atingido.`);
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error } = await supabase
        .from("endpoints")
        .insert({ org_id: orgId, name, slug: generateEndpointSlug() })
        .select("id")
        .single();
      if (!error && data) {
        revalidatePath("/app", "layout");
        return ok({ id: data.id });
      }
      if (error?.code !== "23505") throw new ActionError(error ? dbErrorMessage(error) : "Falha ao criar.");
    }
    throw new ActionError("Não foi possível gerar um endereço único. Tente de novo.");
  },
);

export const updateEndpoint = action(
  z.object({
    endpointId: uuid,
    name: endpointName,
    forwardUrl: z.string().trim().max(2048, { message: "URL longa demais." }),
    forwardEnabled: z.boolean(),
    transformTemplate: z.string().trim().max(10000, { message: "O template pode ter no máximo 10.000 caracteres." }),
  }),
  async ({ endpointId, name, forwardUrl, forwardEnabled, transformTemplate }, { supabase, user }) => {
    await loadEndpoint(supabase, user.id, endpointId);
    if (transformTemplate) {
      const templateError = validateTemplate(transformTemplate);
      if (templateError) throw new ActionError(templateError);
    }
    if (forwardEnabled && !forwardUrl) {
      throw new ActionError("Informe a URL de encaminhamento para ativá-lo.");
    }
    if (forwardUrl) {
      try {
        await validateForwardUrl(forwardUrl, {
          appUrl: serverEnv.APP_URL,
          requireHttps: process.env.NODE_ENV === "production",
        });
      } catch (err) {
        throw new ActionError(err instanceof ForwardUrlError ? err.message : "URL inválida.");
      }
    }
    const { error } = await supabase
      .from("endpoints")
      .update({
        name,
        forward_url: forwardUrl || null,
        forward_enabled: forwardEnabled,
        transform_template: transformTemplate || null,
      })
      .eq("id", endpointId);
    if (error) throw new ActionError(dbErrorMessage(error));
    revalidatePath("/app", "layout");
    return ok();
  },
);

/** Pré-visualiza o template contra a requisição mais recente do endpoint (só leitura). */
export const previewTransform = action(
  z.object({
    endpointId: uuid,
    template: z.string().max(10000, { message: "O template pode ter no máximo 10.000 caracteres." }),
  }),
  async ({ endpointId, template }, { supabase, user }) => {
    await loadEndpoint(supabase, user.id, endpointId);
    const templateError = validateTemplate(template);
    if (templateError) throw new ActionError(templateError);
    const { data: req } = await supabase
      .from("requests")
      .select("method, headers, query, body, body_encoding")
      .eq("endpoint_id", endpointId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!req) throw new ActionError("Envie uma requisição para este endpoint para pré-visualizar.");
    try {
      const output = applyTransform(template, buildTransformContext(req));
      return ok({ output: JSON.stringify(JSON.parse(output), null, 2) });
    } catch (err) {
      if (err instanceof TransformError) throw new ActionError(err.message);
      throw err;
    }
  },
);

export const revealSecret = action(z.object({ endpointId: uuid }), async ({ endpointId }, { supabase, user }) => {
  const endpoint = await loadEndpoint(supabase, user.id, endpointId);
  if (!endpoint.secret_ciphertext) throw new ActionError("Este endpoint não tem segredo.");
  return ok({ secret: decryptSecret(endpoint.secret_ciphertext) });
});

export const regenerateSecret = action(
  z.object({ endpointId: uuid }),
  async ({ endpointId }, { supabase, user }) => {
    await loadEndpoint(supabase, user.id, endpointId);
    const secret = generateEndpointSecret();
    const { error } = await supabase
      .from("endpoints")
      .update({ secret_ciphertext: encryptSecret(secret) })
      .eq("id", endpointId);
    if (error) throw new ActionError(dbErrorMessage(error));
    revalidatePath("/app", "layout");
    return ok({ secret });
  },
);

export const removeSecret = action(z.object({ endpointId: uuid }), async ({ endpointId }, { supabase, user }) => {
  await loadEndpoint(supabase, user.id, endpointId);
  const { error } = await supabase.from("endpoints").update({ secret_ciphertext: null }).eq("id", endpointId);
  if (error) throw new ActionError(dbErrorMessage(error));
  revalidatePath("/app", "layout");
  return ok();
});

export const deleteEndpoint = action(z.object({ endpointId: uuid }), async ({ endpointId }, { supabase, user }) => {
  const endpoint = await loadEndpoint(supabase, user.id, endpointId);
  if (endpoint.organizations?.is_demo && DEMO_ENDPOINT_SLUGS.includes(endpoint.slug)) {
    throw new ActionError("Os endpoints de exemplo da demo não podem ser excluídos.");
  }
  const { error } = await supabase.from("endpoints").delete().eq("id", endpointId);
  if (error) throw new ActionError(dbErrorMessage(error));
  revalidatePath("/app", "layout");
  return ok();
});

export const resendRequest = action(z.object({ requestId: uuid }), async ({ requestId }, { supabase, user }) => {
  const { data: req } = await supabase
    .from("requests")
    .select("id, org_id, endpoints ( forward_enabled, forward_url )")
    .eq("id", requestId)
    .maybeSingle();
  if (!req) throw new ActionError("Requisição não encontrada.");
  await assertMember(supabase, user.id, req.org_id);
  if (!req.endpoints?.forward_enabled || !req.endpoints.forward_url) {
    throw new ActionError("Ative o encaminhamento do endpoint para reenviar.");
  }
  try {
    await enqueueDelivery(req.id);
  } catch {
    throw new ActionError("Não foi possível enfileirar o reenvio.");
  }
  return ok();
});

import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/types";

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

export class ActionError extends Error {}

type Client = SupabaseClient<Database>;

export function ok<T>(data: T): ActionResult<T>;
export function ok(): ActionResult<undefined>;
export function ok<T>(data?: T): ActionResult<T | undefined> {
  return { ok: true, data };
}

/**
 * Envolve uma Server Action: valida a entrada com Zod, exige usuário logado e
 * converte erros em mensagens em pt-BR (sem vazar detalhes internos).
 */
export function action<S extends z.ZodType, T>(
  schema: S,
  handler: (input: z.infer<S>, ctx: { supabase: Client; user: User }) => Promise<ActionResult<T>>,
) {
  return async (raw: z.input<S>): Promise<ActionResult<T>> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
    }
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Sessão expirada. Entre de novo." };
    try {
      return await handler(parsed.data, { supabase, user });
    } catch (err) {
      if (err instanceof ActionError) return { ok: false, error: err.message };
      // Erros de redirect/notFound do Next precisam continuar subindo.
      if (err && typeof err === "object" && "digest" in err) throw err;
      console.error("[action] erro inesperado", err instanceof Error ? err.name : "");
      return { ok: false, error: "Algo deu errado. Tente de novo." };
    }
  };
}

/** Confere a membership explicitamente (além do RLS). Devolve o papel. */
export async function assertMember(
  supabase: Client,
  userId: string,
  orgId: string,
  opts: { owner?: boolean } = {},
): Promise<"owner" | "member"> {
  const { data } = await supabase
    .from("memberships")
    .select("role")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new ActionError("Você não tem acesso a esta organização.");
  if (opts.owner && data.role !== "owner") {
    throw new ActionError("Só owners podem fazer isso.");
  }
  return data.role as "owner" | "member";
}

/** Converte erros de trigger (hint) em mensagens amigáveis. */
export function dbErrorMessage(error: { message: string; hint?: string | null; code?: string }): string {
  switch (error.hint) {
    case "last_owner":
    case "endpoint_limit":
    case "demo":
    case "not_found":
    case "accepted":
    case "expired":
    case "email_mismatch":
      return error.message;
  }
  if (error.code === "42501") return "Você não tem permissão para isso.";
  return "Algo deu errado. Tente de novo.";
}

export const uuid = z.uuid({ message: "Identificador inválido." });

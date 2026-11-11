"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNextPath } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { ActionResult } from "@/lib/actions/shared";

const magicLinkSchema = z.object({
  email: z.email({ message: "Informe um e-mail válido." }).max(254),
  next: z.string().max(500).optional(),
});

function callbackUrl(next: string): string {
  return `${serverEnv.APP_URL}/auth/callback?next=${encodeURIComponent(next)}`;
}

export async function signInWithMagicLink(input: z.input<typeof magicLinkSchema>): Promise<ActionResult> {
  const parsed = magicLinkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0].message };
  if (parsed.data.email.toLowerCase() === serverEnv.DEMO_EMAIL.toLowerCase()) {
    return { ok: false, error: "Use o botão “Entrar na demo”." };
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: { emailRedirectTo: callbackUrl(safeNextPath(parsed.data.next)), shouldCreateUser: true },
  });
  if (error) {
    return {
      ok: false,
      error: error.status === 429 ? "Muitas tentativas. Aguarde um pouco." : "Não foi possível enviar o link.",
    };
  }
  return { ok: true, data: undefined };
}

const nextSchema = z.object({ next: z.string().max(500).optional() });

export async function signInWithGitHub(input: z.input<typeof nextSchema>): Promise<ActionResult> {
  const parsed = nextSchema.safeParse(input);
  const next = safeNextPath(parsed.success ? parsed.data.next : undefined);
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: callbackUrl(next) },
  });
  if (error || !data.url) return { ok: false, error: "Login com GitHub indisponível." };
  redirect(data.url);
}

export async function signInDemo(): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: serverEnv.DEMO_EMAIL,
    password: serverEnv.DEMO_PASSWORD,
  });
  if (error) return { ok: false, error: "A demo está indisponível no momento." };
  redirect("/app/demo/endpoints");
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

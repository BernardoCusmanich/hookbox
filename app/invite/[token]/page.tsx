import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/logo";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { AcceptInviteButton } from "./accept-button";

export const metadata: Metadata = { title: "Convite" };

export default async function InvitePage({ params }: PageProps<"/invite/[token]">) {
  const { token } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);

  const { data } = await supabase.rpc("get_invite", { invite_token: token });
  const invite = data?.[0];
  const emailMatches = invite && user.email?.toLowerCase() === invite.email.toLowerCase();

  let title = "Convite";
  let message: React.ReactNode = null;
  if (!invite) {
    title = "Convite não encontrado";
    message = "O link pode ter sido revogado ou digitado errado.";
  } else if (invite.accepted) {
    title = "Convite já utilizado";
    message = "Este convite já foi aceito.";
  } else if (invite.expired) {
    title = "Convite expirado";
    message = "Peça um novo convite a um owner da organização.";
  } else if (!emailMatches) {
    title = "E-mail diferente";
    message = (
      <>
        Este convite é para <strong>{invite.email}</strong>, mas você entrou como <strong>{user.email}</strong>. Saia e
        entre com o e-mail convidado.
      </>
    );
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="px-4 py-4 sm:px-6">
        <Logo />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <Card className="w-full max-w-md">
          {message ? (
            <>
              <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{message}</CardDescription>
              </CardHeader>
              <CardContent>
                <Link href="/app" className={buttonVariants({ variant: "outline" })}>
                  Ir para o Hookbox
                </Link>
              </CardContent>
            </>
          ) : (
            <>
              <CardHeader>
                <CardTitle>Entrar em {invite!.org_name}</CardTitle>
                <CardDescription>
                  Você foi convidado como {invite!.role === "owner" ? "owner" : "membro"} da organização.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AcceptInviteButton token={token} />
              </CardContent>
            </>
          )}
        </Card>
      </main>
    </div>
  );
}

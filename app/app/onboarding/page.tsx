import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { CreateOrgForm } from "./create-org-form";

export const metadata: Metadata = { title: "Nova organização" };

export default async function OnboardingPage() {
  const { supabase, user } = await requireUser();
  const { count } = await supabase
    .from("memberships")
    .select("org_id", { count: "exact", head: true })
    .eq("user_id", user.id);
  const isDemoUser = user.app_metadata?.hookbox_demo === true;

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between px-4 py-4 sm:px-6">
        <Logo href="/app" />
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-16">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>{count ? "Nova organização" : "Crie sua organização"}</CardTitle>
            <CardDescription>
              Endpoints, requisições e membros ficam dentro de uma organização. Você pode convidar o time depois.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {isDemoUser ? (
              <p className="text-sm text-muted-foreground">A conta demo não pode criar organizações.</p>
            ) : (
              <CreateOrgForm />
            )}
            {!!count && (
              <Link href="/app" className="text-center text-sm text-muted-foreground hover:text-foreground">
                Voltar
              </Link>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

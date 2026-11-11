import { LogoMark } from "@/components/logo";
import { NavLinks } from "@/components/nav-links";
import { OrgSwitcher } from "@/components/org-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { requireOrg } from "@/lib/auth";
import Link from "next/link";

export default async function OrgLayout({ children, params }: LayoutProps<"/app/[orgSlug]">) {
  const { orgSlug } = await params;
  const { supabase, user, org } = await requireOrg(orgSlug);
  const { data: orgs } = await supabase.from("organizations").select("slug, name, is_demo").order("name");
  const isDemoUser = user.app_metadata?.hookbox_demo === true;

  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="flex h-14 items-center gap-2 px-3 sm:px-5">
          <Link href="/app" aria-label="Hookbox">
            <LogoMark />
          </Link>
          <span className="text-muted-foreground/50">/</span>
          <OrgSwitcher current={org} orgs={orgs ?? [org]} canCreate={!isDemoUser} />
          <div className="ml-2 hidden sm:block">
            <NavLinks orgSlug={org.slug} />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
            <UserMenu email={user.email ?? ""} avatarUrl={user.user_metadata?.avatar_url} />
          </div>
        </div>
        <div className="border-t px-3 py-1.5 sm:hidden">
          <NavLinks orgSlug={org.slug} />
        </div>
      </header>
      {org.is_demo && (
        <div className="border-b bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-800 dark:text-amber-300">
          Você está na demo pública. Os dados são compartilhados e voltam ao estado inicial todo dia.
        </div>
      )}
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}

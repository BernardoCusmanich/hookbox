"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function NavLinks({ orgSlug }: { orgSlug: string }) {
  const pathname = usePathname();
  const links = [
    { href: `/app/${orgSlug}/endpoints`, label: "Endpoints" },
    { href: `/app/${orgSlug}/settings`, label: "Configurações" },
  ];
  return (
    <nav className="flex items-center gap-1 text-sm">
      {links.map((link) => {
        const active = pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "rounded-md px-2.5 py-1.5 transition-colors hover:text-foreground",
              active ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

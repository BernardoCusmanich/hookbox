"use client";

import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Org = { slug: string; name: string; is_demo: boolean };

export function OrgSwitcher({ current, orgs, canCreate }: { current: Org; orgs: Org[]; canCreate: boolean }) {
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" className="max-w-56 gap-2 px-2" />}>
        <span className="truncate">{current.name}</span>
        {current.is_demo && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 uppercase dark:text-amber-400">
            demo
          </span>
        )}
        <ChevronsUpDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organizações</DropdownMenuLabel>
          {orgs.map((org) => (
            <DropdownMenuItem key={org.slug} onClick={() => router.push(`/app/${org.slug}/endpoints`)}>
              <span className="flex-1 truncate">{org.name}</span>
              {org.slug === current.slug && <CheckIcon />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {canCreate && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => router.push("/app/onboarding")}>
              <PlusIcon />
              Nova organização
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

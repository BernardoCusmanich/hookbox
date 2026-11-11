"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { acceptInvite } from "@/lib/actions/orgs";

export function AcceptInviteButton({ token }: { token: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      className="w-full"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await acceptInvite({ token });
          if (!result.ok) return void toast.error(result.error);
          toast.success("Convite aceito.");
          router.push(`/app/${result.data.slug}/endpoints`);
        })
      }
    >
      {pending ? "Entrando..." : "Aceitar convite"}
    </Button>
  );
}

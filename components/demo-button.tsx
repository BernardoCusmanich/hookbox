"use client";

import { PlayIcon } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { signInDemo } from "@/lib/actions/auth";

export function DemoButton({
  size = "lg",
  variant = "default",
  className,
}: {
  size?: "lg" | "default";
  variant?: "default" | "outline" | "secondary";
  className?: string;
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      size={size}
      variant={variant}
      className={className}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await signInDemo();
          if (result && !result.ok) toast.error(result.error);
        })
      }
    >
      <PlayIcon />
      {pending ? "Entrando..." : "Entrar na demo"}
    </Button>
  );
}

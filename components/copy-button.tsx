"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function CopyButton({
  value,
  label = "Copiar",
  size = "icon-sm",
  variant = "ghost",
  showLabel = false,
}: {
  value: string;
  label?: string;
  size?: "icon-sm" | "sm" | "default" | "icon";
  variant?: "ghost" | "outline" | "secondary";
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Não foi possível copiar.");
    }
  }
  return (
    <Button type="button" variant={variant} size={size} onClick={copy} aria-label={label}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {showLabel && <span>{copied ? "Copiado" : label}</span>}
    </Button>
  );
}

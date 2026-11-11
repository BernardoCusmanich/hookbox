import { cn } from "@/lib/utils";

const methodColors: Record<string, string> = {
  GET: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  POST: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  PUT: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  PATCH: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  DELETE: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

export function MethodBadge({ method, className }: { method: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex w-16 shrink-0 justify-center rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold",
        methodColors[method] ?? "bg-muted text-muted-foreground",
        className,
      )}
    >
      {method}
    </span>
  );
}

export type SignatureStatus = "valid" | "invalid" | "missing" | "not_configured";

const signatureInfo: Record<SignatureStatus, { icon: string; label: string; className: string }> = {
  valid: { icon: "✅", label: "Assinatura válida", className: "text-emerald-700 dark:text-emerald-400" },
  invalid: { icon: "❌", label: "Assinatura inválida", className: "text-rose-700 dark:text-rose-400" },
  missing: { icon: "—", label: "Assinatura ausente", className: "text-muted-foreground" },
  not_configured: { icon: "—", label: "Sem segredo configurado", className: "text-muted-foreground" },
};

export function SignatureBadge({ status, withLabel = false }: { status: string; withLabel?: boolean }) {
  const info = signatureInfo[status as SignatureStatus] ?? signatureInfo.not_configured;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", info.className)} title={info.label}>
      <span aria-hidden>{info.icon}</span>
      <span className={withLabel ? "" : "sr-only"}>{info.label}</span>
    </span>
  );
}

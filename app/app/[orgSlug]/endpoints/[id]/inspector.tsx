"use client";

import { ArrowLeftIcon, InboxIcon, SendIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { MethodBadge, SignatureBadge } from "@/components/request-meta";
import { Button } from "@/components/ui/button";
import { formatBytes, relativeTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { EndpointSettings } from "./endpoint-settings";
import { RequestDetailPanel } from "./request-detail";
import type { EndpointInfo, RequestSummary } from "./types";

const MAX_ITEMS = 200;

function useNow(intervalMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function Inspector({
  appUrl,
  orgSlug,
  isDemo,
  endpoint,
  initialRequests,
}: {
  appUrl: string;
  orgSlug: string;
  isDemo: boolean;
  endpoint: EndpointInfo;
  initialRequests: RequestSummary[];
}) {
  const supabase = useMemo(() => createClient(), []);
  const [requests, setRequests] = useState(initialRequests);
  const [selectedId, setSelectedId] = useState<string | null>(initialRequests[0]?.id ?? null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [live, setLive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileDetail, setMobileDetail] = useState(false);
  const now = useNow();
  const ingestUrl = `${appUrl}/in/${endpoint.slug}`;

  // Realtime: INSERT em requests deste endpoint (o RLS filtra por organização).
  useEffect(() => {
    const channel = supabase
      .channel(`requests:${endpoint.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "requests", filter: `endpoint_id=eq.${endpoint.id}` },
        (payload) => {
          const row = payload.new as RequestSummary;
          const summary: RequestSummary = {
            id: row.id,
            method: row.method,
            received_at: row.received_at,
            size_bytes: row.size_bytes,
            signature_status: row.signature_status,
            content_type: row.content_type,
          };
          setRequests((prev) =>
            prev.some((r) => r.id === summary.id) ? prev : [summary, ...prev].slice(0, MAX_ITEMS),
          );
          setSelectedId((current) => current ?? summary.id);
          setFresh((prev) => new Set(prev).add(summary.id));
          setTimeout(() => {
            setFresh((prev) => {
              const next = new Set(prev);
              next.delete(summary.id);
              return next;
            });
          }, 2500);
        },
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [supabase, endpoint.id]);

  async function sendTest() {
    try {
      const res = await fetch(`/in/${endpoint.slug}?origem=inspetor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "teste.hookbox",
          enviadoEm: new Date().toISOString(),
          mensagem: "Olá do Hookbox!",
        }),
      });
      if (res.status === 429) toast.error("Muitas requisições. Aguarde um pouco.");
      else if (!res.ok) toast.error("A requisição de teste falhou.");
    } catch {
      toast.error("A requisição de teste falhou.");
    }
  }

  const selected = requests.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Cabeçalho do endpoint */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-3 sm:px-5">
        <div className="flex min-w-0 basis-full flex-col gap-1 sm:basis-0 sm:flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              href={`/app/${orgSlug}/endpoints`}
              className="text-sm text-muted-foreground hover:text-foreground"
              aria-label="Voltar para endpoints"
            >
              <ArrowLeftIcon className="size-4" />
            </Link>
            <h1 className="truncate font-semibold">{endpoint.name}</h1>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs whitespace-nowrap",
                live ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" : "bg-muted text-muted-foreground",
              )}
            >
              <span className={cn("size-1.5 rounded-full", live ? "animate-pulse bg-emerald-500" : "bg-muted-foreground")} />
              {live ? "ao vivo" : "conectando"}
            </span>
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{ingestUrl}</code>
            <CopyButton value={ingestUrl} label="Copiar URL de ingestão" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={sendTest}>
            <SendIcon />
            Enviar teste
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <SettingsIcon />
            Configurações
          </Button>
        </div>
      </div>

      {requests.length === 0 ? (
        <EmptyState ingestUrl={ingestUrl} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Lista */}
          <aside
            className={cn(
              "w-full shrink-0 overflow-y-auto border-r md:block md:w-80 lg:w-96",
              "md:h-[calc(100svh-8.5rem)]",
              mobileDetail ? "hidden" : "block",
            )}
          >
            <ul>
              {requests.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(r.id);
                      setMobileDetail(true);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 border-b px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/60",
                      r.id === selectedId && "bg-muted",
                      fresh.has(r.id) && "animate-in fade-in slide-in-from-top-1 bg-emerald-500/10",
                    )}
                  >
                    <MethodBadge method={r.method} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{relativeTime(r.received_at, now)}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {formatBytes(r.size_bytes)}
                        {r.content_type ? ` · ${r.content_type.split(";")[0]}` : ""}
                      </span>
                    </span>
                    <SignatureBadge status={r.signature_status} />
                  </button>
                </li>
              ))}
            </ul>
            {requests.length >= 100 && (
              <p className="px-3 py-3 text-center text-xs text-muted-foreground">
                Mostrando as requisições mais recentes.
              </p>
            )}
          </aside>

          {/* Detalhe */}
          <section
            className={cn(
              "min-w-0 flex-1 overflow-y-auto md:block md:h-[calc(100svh-8.5rem)]",
              mobileDetail ? "block" : "hidden",
            )}
          >
            {selected ? (
              <RequestDetailPanel
                key={selected.id}
                summary={selected}
                appUrl={appUrl}
                forwardEnabled={endpoint.forwardEnabled}
                onBack={() => setMobileDetail(false)}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                Selecione uma requisição.
              </div>
            )}
          </section>
        </div>
      )}

      <EndpointSettings
        // Remonta quando o endpoint muda (após salvar), recarregando o formulário.
        key={`${endpoint.name}|${endpoint.forwardUrl}|${endpoint.forwardEnabled}|${endpoint.transformTemplate}|${endpoint.hasSecret}`}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        endpoint={endpoint}
        orgSlug={orgSlug}
        isDemo={isDemo}
      />
    </div>
  );
}

function EmptyState({ ingestUrl }: { ingestUrl: string }) {
  const curl = `curl -X POST '${ingestUrl}' \\
  -H 'content-type: application/json' \\
  -d '{"evento": "pedido.criado", "id": 123}'`;
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-xl flex-col items-center gap-4 text-center">
        <InboxIcon className="size-10 text-muted-foreground" />
        <div>
          <p className="font-medium">Esperando a primeira requisição</p>
          <p className="text-sm text-muted-foreground">
            Aponte o seu provedor para a URL acima ou cole este comando no terminal. A requisição aparece aqui na hora.
          </p>
        </div>
        <div className="relative w-full text-left">
          <pre className="code-block pr-10">{curl}</pre>
          <div className="absolute top-1.5 right-1.5">
            <CopyButton value={curl} label="Copiar comando" />
          </div>
        </div>
      </div>
    </div>
  );
}

import { ArrowLeftIcon, RefreshCwIcon, RepeatIcon, TerminalIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { JsonView } from "@/components/json-view";
import { MethodBadge, SignatureBadge } from "@/components/request-meta";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { resendRequest } from "@/lib/actions/endpoints";
import { buildCurl } from "@/lib/curl";
import { formatBytes, formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { Delivery, RequestDetail, RequestSummary } from "./types";

export function RequestDetailPanel({
  summary,
  appUrl,
  forwardEnabled,
  onBack,
}: {
  summary: RequestSummary;
  appUrl: string;
  forwardEnabled: boolean;
  onBack: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState("body");
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [resending, startResend] = useTransition();

  useEffect(() => {
    let cancelled = false;
    supabase
      .from("requests")
      .select("id, method, received_at, size_bytes, signature_status, content_type, path, query, headers, body, body_encoding, ip")
      .eq("id", summary.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) setFailed(true);
        else setDetail(data as RequestDetail);
      });
    return () => {
      cancelled = true;
    };
  }, [supabase, summary.id]);

  const [refreshTick, setRefreshTick] = useState(0);
  const loadDeliveries = useCallback(async () => setRefreshTick((t) => t + 1), []);

  // Entregas: carrega ao abrir a aba e atualiza a cada 5 s enquanto ela estiver aberta.
  useEffect(() => {
    if (tab !== "deliveries") return;
    let cancelled = false;
    const run = () =>
      supabase
        .from("deliveries")
        .select("id, attempt, status_code, error, duration_ms, created_at")
        .eq("request_id", summary.id)
        .order("created_at", { ascending: false })
        .then(({ data }) => {
          if (!cancelled) setDeliveries(data ?? []);
        });
    void run();
    const id = setInterval(run, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [tab, supabase, summary.id, refreshTick]);

  function copyCurl() {
    if (!detail) return;
    const curl = buildCurl({
      url: `${appUrl}${detail.path}`,
      method: detail.method,
      query: (detail.query ?? {}) as Record<string, unknown>,
      headers: (detail.headers ?? {}) as Record<string, unknown>,
      body: detail.body,
      bodyEncoding: detail.body_encoding,
    });
    navigator.clipboard.writeText(curl).then(
      () => toast.success("cURL copiado."),
      () => toast.error("Não foi possível copiar."),
    );
  }

  function resend() {
    startResend(async () => {
      const result = await resendRequest({ requestId: summary.id });
      if (!result.ok) return void toast.error(result.error);
      toast.success("Reenvio enfileirado.");
      setTab("deliveries");
    });
  }

  if (failed) {
    return <div className="p-6 text-sm text-muted-foreground">Não foi possível carregar esta requisição.</div>;
  }

  const headers = Object.entries((detail?.headers ?? {}) as Record<string, string>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const query = Object.entries((detail?.query ?? {}) as Record<string, string | string[]>);

  return (
    <div className="flex flex-col gap-4 p-3 sm:p-5">
      <Button variant="ghost" size="sm" className="self-start md:hidden" onClick={onBack}>
        <ArrowLeftIcon />
        Requisições
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <MethodBadge method={summary.method} />
            <code className="truncate font-mono text-sm">{detail?.path ?? "…"}</code>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{formatDateTime(summary.received_at)}</span>
            <span>{formatBytes(summary.size_bytes)}</span>
            {detail?.ip ? <span>IP {String(detail.ip)}</span> : null}
            <SignatureBadge status={summary.signature_status} withLabel />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={copyCurl} disabled={!detail}>
            <TerminalIcon />
            Copiar como cURL
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={resend}
            disabled={resending || !forwardEnabled}
            title={forwardEnabled ? undefined : "Ative o encaminhamento nas configurações do endpoint"}
          >
            <RepeatIcon />
            {resending ? "Enfileirando..." : "Reenviar"}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
        <TabsList>
          <TabsTrigger value="body">Corpo</TabsTrigger>
          <TabsTrigger value="headers">Headers{detail ? ` (${headers.length})` : ""}</TabsTrigger>
          <TabsTrigger value="query">Query{detail ? ` (${query.length})` : ""}</TabsTrigger>
          <TabsTrigger value="deliveries">Entregas</TabsTrigger>
        </TabsList>

        <TabsContent value="body" className="pt-2">
          {detail ? <BodyView detail={detail} /> : <Skeleton className="h-48 w-full" />}
        </TabsContent>

        <TabsContent value="headers" className="pt-2">
          {detail ? <KeyValueTable rows={headers} empty="Sem headers." /> : <Skeleton className="h-48 w-full" />}
        </TabsContent>

        <TabsContent value="query" className="pt-2">
          {detail ? (
            <KeyValueTable
              rows={query.map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])}
              empty="Sem parâmetros de query."
            />
          ) : (
            <Skeleton className="h-24 w-full" />
          )}
        </TabsContent>

        <TabsContent value="deliveries" className="pt-2">
          <DeliveriesView deliveries={deliveries} forwardEnabled={forwardEnabled} onRefresh={loadDeliveries} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function BodyView({ detail }: { detail: RequestDetail }) {
  if (!detail.body) return <p className="text-sm text-muted-foreground">Requisição sem corpo.</p>;
  if (detail.body_encoding === "base64") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">Corpo binário, exibido em base64.</p>
        <pre className="code-block">{detail.body}</pre>
      </div>
    );
  }
  let parsed: unknown;
  let isJson = false;
  try {
    parsed = JSON.parse(detail.body);
    isJson = typeof parsed === "object" && parsed !== null;
  } catch {
    isJson = false;
  }
  return isJson ? <JsonView value={parsed} /> : <pre className="code-block">{detail.body}</pre>;
}

function KeyValueTable({ rows, empty }: { rows: [string, string][]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-xs">
        <tbody className="divide-y">
          {rows.map(([key, value]) => (
            <tr key={key} className="align-top">
              <td className="w-1/3 bg-muted/40 px-3 py-2 font-mono font-medium break-all">{key}</td>
              <td
                className={
                  value === "[redacted]"
                    ? "px-3 py-2 font-mono text-muted-foreground italic"
                    : "px-3 py-2 font-mono break-all"
                }
              >
                {value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DeliveriesView({
  deliveries,
  forwardEnabled,
  onRefresh,
}: {
  deliveries: Delivery[] | null;
  forwardEnabled: boolean;
  onRefresh: () => Promise<void>;
}) {
  if (deliveries === null) return <Skeleton className="h-24 w-full" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {forwardEnabled ? "Atualiza sozinho a cada 5 s." : "O encaminhamento deste endpoint está desligado."}
        </p>
        <Button variant="ghost" size="sm" onClick={() => void onRefresh()}>
          <RefreshCwIcon />
          Atualizar
        </Button>
      </div>
      {deliveries.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhuma tentativa de entrega.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Tentativa</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Duração</th>
                <th className="px-3 py-2 font-medium">Quando</th>
                <th className="px-3 py-2 font-medium">Erro</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {deliveries.map((d) => {
                const ok = d.status_code !== null && d.status_code >= 200 && d.status_code < 300;
                return (
                  <tr key={d.id}>
                    <td className="px-3 py-2 tabular-nums">#{d.attempt}</td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          ok
                            ? "rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-emerald-700 dark:text-emerald-300"
                            : "rounded bg-rose-500/15 px-1.5 py-0.5 font-mono text-rose-700 dark:text-rose-300"
                        }
                      >
                        {d.status_code ?? "erro"}
                      </span>
                    </td>
                    <td className="px-3 py-2 tabular-nums">{d.duration_ms !== null ? `${d.duration_ms} ms` : "—"}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(d.created_at)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{d.error ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

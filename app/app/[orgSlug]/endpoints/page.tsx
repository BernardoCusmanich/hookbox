import { ArrowRightIcon, RadioTowerIcon, RepeatIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { requireOrg } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { CreateEndpointDialog } from "./create-endpoint-dialog";

export const metadata: Metadata = { title: "Endpoints" };

const MAX_ENDPOINTS = 5;

export default async function EndpointsPage({ params }: PageProps<"/app/[orgSlug]/endpoints">) {
  const { orgSlug } = await params;
  const { supabase, org } = await requireOrg(orgSlug);

  const [{ data: endpoints }, { data: counts }] = await Promise.all([
    supabase
      .from("endpoints")
      .select("id, name, slug, forward_enabled, forward_url, created_at")
      .eq("org_id", org.id)
      .order("created_at", { ascending: true }),
    supabase.rpc("endpoint_request_counts", { org: org.id }),
  ]);
  const countBy = new Map((counts ?? []).map((c) => [c.endpoint_id, Number(c.total)]));
  const list = endpoints ?? [];

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Endpoints</h1>
          <p className="text-sm text-muted-foreground">
            Cada endpoint tem uma URL própria para receber webhooks. {list.length} de {MAX_ENDPOINTS} em uso.
          </p>
        </div>
        <CreateEndpointDialog orgId={org.id} orgSlug={org.slug} disabled={list.length >= MAX_ENDPOINTS} />
      </div>

      {list.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          <RadioTowerIcon className="size-8 text-muted-foreground" />
          <p className="font-medium">Nenhum endpoint ainda</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Crie um endpoint para ganhar uma URL de ingestão e começar a ver as requisições chegando.
          </p>
        </div>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {list.map((endpoint) => {
            const url = `${serverEnv.APP_URL}/in/${endpoint.slug}`;
            const total = countBy.get(endpoint.id) ?? 0;
            return (
              <li key={endpoint.id} className="group relative flex flex-col gap-3 p-4 hover:bg-muted/40 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/app/${org.slug}/endpoints/${endpoint.id}`}
                      className="truncate font-medium after:absolute after:inset-0"
                    >
                      {endpoint.name}
                    </Link>
                    {endpoint.forward_enabled ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300"
                        title={endpoint.forward_url ?? undefined}
                      >
                        <RepeatIcon className="size-3" /> Encaminhando
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        Sem encaminhamento
                      </span>
                    )}
                  </div>
                  <div className="relative z-10 flex min-w-0 items-center gap-1">
                    <code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{url}</code>
                    <CopyButton value={url} label="Copiar URL de ingestão" />
                  </div>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <div className="text-right">
                    <div className="font-medium tabular-nums">{total.toLocaleString("pt-BR")}</div>
                    <div className="text-xs text-muted-foreground">req. em 24 h</div>
                  </div>
                  <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

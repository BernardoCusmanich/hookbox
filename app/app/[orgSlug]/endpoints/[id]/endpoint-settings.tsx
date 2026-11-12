import { EyeIcon, EyeOffIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  deleteEndpoint,
  previewTransform,
  regenerateSecret,
  removeSecret,
  revealSecret,
  updateEndpoint,
} from "@/lib/actions/endpoints";
import type { EndpointInfo } from "./types";

const MASK = "•".repeat(32);

export function EndpointSettings({
  open,
  onOpenChange,
  endpoint,
  orgSlug,
  isDemo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: EndpointInfo;
  orgSlug: string;
  isDemo: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(endpoint.name);
  const [forwardUrl, setForwardUrl] = useState(endpoint.forwardUrl ?? "");
  const [forwardEnabled, setForwardEnabled] = useState(endpoint.forwardEnabled);
  const [transformTemplate, setTransformTemplate] = useState(endpoint.transformTemplate ?? "");
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [previewing, startPreview] = useTransition();
  const [secretPending, startSecret] = useTransition();
  const [deleting, startDelete] = useTransition();

  // O segredo revelado some quando o drawer fecha.
  function handleOpenChange(next: boolean) {
    if (!next) setSecret(null);
    onOpenChange(next);
  }

  function save(e: { preventDefault(): void }) {
    e.preventDefault();
    startSave(async () => {
      const result = await updateEndpoint({
        endpointId: endpoint.id,
        name,
        forwardUrl,
        forwardEnabled,
        transformTemplate,
      });
      if (!result.ok) return void toast.error(result.error);
      toast.success("Configurações salvas.");
      router.refresh();
    });
  }

  function runPreview() {
    startPreview(async () => {
      const result = await previewTransform({ endpointId: endpoint.id, template: transformTemplate });
      setPreview(result.ok ? { ok: true, text: result.data.output } : { ok: false, text: result.error });
    });
  }

  function reveal() {
    if (secret) return setSecret(null);
    startSecret(async () => {
      const result = await revealSecret({ endpointId: endpoint.id });
      if (!result.ok) return void toast.error(result.error);
      setSecret(result.data.secret);
    });
  }

  function regenerate() {
    startSecret(async () => {
      const result = await regenerateSecret({ endpointId: endpoint.id });
      if (!result.ok) return void toast.error(result.error);
      setSecret(result.data.secret);
      toast.success(endpoint.hasSecret ? "Novo segredo gerado." : "Segredo gerado.");
      router.refresh();
    });
  }

  function clearSecret() {
    startSecret(async () => {
      const result = await removeSecret({ endpointId: endpoint.id });
      if (!result.ok) return void toast.error(result.error);
      setSecret(null);
      toast.success("Segredo removido.");
      router.refresh();
    });
  }

  function remove() {
    startDelete(async () => {
      const result = await deleteEndpoint({ endpointId: endpoint.id });
      if (!result.ok) return void toast.error(result.error);
      toast.success("Endpoint excluído.");
      router.push(`/app/${orgSlug}/endpoints`);
    });
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Configurações do endpoint</SheetTitle>
          <SheetDescription>Nome, segredo de assinatura, encaminhamento e transformação.</SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-6 px-4 pb-6">
          <form id="endpoint-form" onSubmit={save} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="ep-name">Nome</Label>
              <Input id="ep-name" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} />
            </div>

            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label htmlFor="ep-forward">Encaminhamento</Label>
                  <p className="text-xs text-muted-foreground">
                    Reenvia cada requisição para a URL abaixo, com até 5 novas tentativas. Se a entrega falhar de vez, os owners recebem um e-mail (no máximo um por hora).
                  </p>
                </div>
                <Switch
                  id="ep-forward"
                  checked={forwardEnabled}
                  onCheckedChange={setForwardEnabled}
                  disabled={isDemo}
                />
              </div>
              <Input
                type="url"
                inputMode="url"
                placeholder="https://api.suaempresa.com/webhooks"
                value={forwardUrl}
                maxLength={2048}
                onChange={(e) => setForwardUrl(e.target.value)}
                aria-label="URL de encaminhamento"
                disabled={isDemo}
              />
              <p className="text-xs text-muted-foreground">
                Só https e endereços públicos. IPs internos, de rede privada e de metadata da cloud são recusados.
              </p>
              {isDemo && <p className="text-xs text-muted-foreground">Indisponível na demo pública</p>}
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="ep-transform">Transformação (opcional)</Label>
              <Textarea
                id="ep-transform"
                className="min-h-24 font-mono text-xs"
                placeholder={'{\n  "text": "Pedido {{ body.id }}: {{ body.status }}"\n}'}
                value={transformTemplate}
                maxLength={10000}
                spellCheck={false}
                onChange={(e) => setTransformTemplate(e.target.value)}
                disabled={isDemo}
              />
              <p className="text-xs text-muted-foreground">
                Template JSON. Use {"{{ body.campo }}"}, {"{{ headers.nome }}"}, {"{{ query.param }}"} ou{" "}
                {"{{ method }}"}. Vazio = encaminha o corpo original.
              </p>
              {isDemo && <p className="text-xs text-muted-foreground">Indisponível na demo pública</p>}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={runPreview}
                disabled={previewing}
              >
                {previewing ? "Gerando..." : "Pré-visualizar"}
              </Button>
              {preview && (
                <pre
                  className={
                    preview.ok
                      ? "max-h-60 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs"
                      : "max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-destructive/40 bg-destructive/10 p-2 font-mono text-xs text-destructive"
                  }
                  role={preview.ok ? undefined : "alert"}
                >
                  {preview.text}
                </pre>
              )}
            </div>

            <Button type="submit" disabled={saving} className="self-start">
              {saving ? "Salvando..." : "Salvar"}
            </Button>
          </form>

          <Separator />

          <div className="flex flex-col gap-3">
            <div>
              <Label>Segredo de assinatura</Label>
              <p className="text-xs text-muted-foreground">
                Valida os headers <code>x-bridge-signature</code> e <code>x-bridge-timestamp</code> (HMAC-SHA256),
                no formato do legacy-bridge.
              </p>
            </div>
            {endpoint.hasSecret || secret ? (
              <>
                <div className="flex items-center gap-1">
                  <code className="flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs">
                    {secret ?? MASK}
                  </code>
                  {secret && <CopyButton value={secret} label="Copiar segredo" />}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={reveal} disabled={secretPending}>
                    {secret ? <EyeOffIcon /> : <EyeIcon />}
                    {secret ? "Ocultar" : "Revelar"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={regenerate} disabled={secretPending || isDemo}>
                    <KeyRoundIcon />
                    Gerar novo
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearSecret} disabled={secretPending || isDemo}>
                    Remover
                  </Button>
                </div>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={regenerate}
                disabled={secretPending || isDemo}
              >
                <KeyRoundIcon />
                Gerar segredo
              </Button>
            )}
            {isDemo && <p className="text-xs text-muted-foreground">Indisponível na demo pública</p>}
          </div>

          <Separator />

          <div className="flex flex-col gap-3">
            <div>
              <Label>Excluir endpoint</Label>
              <p className="text-xs text-muted-foreground">
                Apaga o endpoint e todas as requisições dele. A URL de ingestão para de funcionar.
              </p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger
                render={<Button variant="destructive" size="sm" className="self-start" disabled={deleting} />}
              >
                <Trash2Icon />
                Excluir endpoint
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Excluir “{endpoint.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    {isDemo
                      ? "Na demo, os endpoints de exemplo não podem ser excluídos."
                      : "Esta ação não pode ser desfeita."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancelar</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={remove} disabled={deleting}>
                    Excluir
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

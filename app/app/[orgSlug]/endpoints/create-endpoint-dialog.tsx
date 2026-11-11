"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createEndpoint } from "@/lib/actions/endpoints";

export function CreateEndpointDialog({
  orgId,
  orgSlug,
  disabled,
}: {
  orgId: string;
  orgSlug: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button disabled={disabled} title={disabled ? "Limite de 5 endpoints atingido" : undefined} />}>
        <PlusIcon />
        Novo endpoint
      </DialogTrigger>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const result = await createEndpoint({ orgId, name });
              if (!result.ok) return void toast.error(result.error);
              setOpen(false);
              setName("");
              router.push(`/app/${orgSlug}/endpoints/${result.data.id}`);
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>Novo endpoint</DialogTitle>
            <DialogDescription>A URL de ingestão é gerada automaticamente.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="endpoint-name">Nome</Label>
            <Input
              id="endpoint-name"
              placeholder="Stripe produção"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Criando..." : "Criar endpoint"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

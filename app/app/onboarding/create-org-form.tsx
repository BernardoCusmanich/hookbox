"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createOrganization } from "@/lib/actions/orgs";

export function CreateOrgForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const result = await createOrganization({ name });
          if (!result.ok) return void toast.error(result.error);
          router.push(`/app/${result.data.slug}/endpoints`);
        });
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="org-name">Nome</Label>
        <Input
          id="org-name"
          placeholder="Minha empresa"
          required
          minLength={2}
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Criando..." : "Criar organização"}
      </Button>
    </form>
  );
}

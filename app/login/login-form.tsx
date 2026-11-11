"use client";

import { MailCheckIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { DemoButton } from "@/components/demo-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { signInWithGitHub, signInWithMagicLink } from "@/lib/actions/auth";

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="size-4 fill-current">
      <path d="M12 .5a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.7 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .5Z" />
    </svg>
  );
}

export function LoginForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [githubPending, startGithub] = useTransition();

  if (sentTo) {
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <MailCheckIcon className="size-8 text-muted-foreground" />
        <p className="font-medium">Confira seu e-mail</p>
        <p className="text-sm text-muted-foreground">
          Enviamos um link de acesso para <span className="font-medium text-foreground">{sentTo}</span>.
        </p>
        <Button variant="ghost" size="sm" onClick={() => setSentTo(null)}>
          Usar outro e-mail
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const result = await signInWithMagicLink({ email, next });
            if (result.ok) setSentTo(email);
            else toast.error(result.error);
          });
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">E-mail</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="voce@empresa.com"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? "Enviando..." : "Enviar link de acesso"}
        </Button>
      </form>

      <Button
        variant="outline"
        disabled={githubPending}
        onClick={() =>
          startGithub(async () => {
            const result = await signInWithGitHub({ next });
            if (result && !result.ok) toast.error(result.error);
          })
        }
      >
        <GitHubIcon />
        Continuar com GitHub
      </Button>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <Separator className="flex-1" />
        ou
        <Separator className="flex-1" />
      </div>

      <DemoButton size="default" variant="secondary" />
    </div>
  );
}

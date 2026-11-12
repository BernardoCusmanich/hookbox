"use client";

import { KeyRoundIcon, LinkIcon, Trash2Icon, UserMinusIcon } from "lucide-react";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createApiKey, deleteApiKey } from "@/lib/actions/api-keys";
import {
  changeMemberRole,
  createInvite,
  removeMember,
  renameOrganization,
  revokeInvite,
} from "@/lib/actions/orgs";
import { formatDateTime } from "@/lib/format";

type Role = "owner" | "member";
const roleLabel: Record<string, string> = { owner: "Owner", member: "Membro" };
const roleItems = [
  { value: "member", label: "Membro" },
  { value: "owner", label: "Owner" },
];

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function RoleSelect({
  value,
  onChange,
  disabled,
}: {
  value: Role;
  onChange: (role: Role) => void;
  disabled?: boolean;
}) {
  return (
    <Select items={roleItems} value={value} onValueChange={(v) => v && onChange(v as Role)} disabled={disabled}>
      <SelectTrigger size="sm" className="w-28" aria-label="Papel">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {roleItems.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function OrgNameSection({ orgId, name, canEdit }: { orgId: string; name: string; canEdit: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(name);
  const [pending, start] = useTransition();
  return (
    <Section title="Organização" description="O nome aparece no seletor de organizações.">
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const result = await renameOrganization({ orgId, name: value });
            if (!result.ok) return void toast.error(result.error);
            toast.success("Nome atualizado.");
            router.refresh();
          });
        }}
      >
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="org-name">Nome</Label>
          <Input
            id="org-name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={!canEdit}
            minLength={2}
            maxLength={80}
            required
          />
        </div>
        {canEdit && (
          <Button type="submit" disabled={pending || value.trim() === name}>
            {pending ? "Salvando..." : "Salvar"}
          </Button>
        )}
      </form>
    </Section>
  );
}

type Member = {
  user_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: string;
  created_at: string;
};

export function MembersSection({
  orgId,
  members,
  currentUserId,
  canEdit,
}: {
  orgId: string;
  members: Member[];
  currentUserId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function setRole(userId: string, role: Role) {
    start(async () => {
      const result = await changeMemberRole({ orgId, userId, role });
      if (!result.ok) return void toast.error(result.error);
      toast.success("Papel atualizado.");
      router.refresh();
    });
  }

  function remove(userId: string) {
    start(async () => {
      const result = await removeMember({ orgId, userId });
      if (!result.ok) return void toast.error(result.error);
      toast.success(userId === currentUserId ? "Você saiu da organização." : "Membro removido.");
      if (userId === currentUserId) router.push("/app");
      else router.refresh();
    });
  }

  return (
    <Section title="Membros" description={`${members.length} ${members.length === 1 ? "pessoa" : "pessoas"} nesta organização.`}>
      <ul className="divide-y rounded-xl border">
        {members.map((m) => (
          <li key={m.user_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Avatar className="size-8">
              {m.avatar_url && <AvatarImage src={m.avatar_url} alt="" />}
              <AvatarFallback className="text-xs uppercase">{m.email.slice(0, 2)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">
                {m.name ?? m.email}
                {m.user_id === currentUserId && <span className="font-normal text-muted-foreground"> (você)</span>}
              </span>
              {m.name && <span className="truncate text-xs text-muted-foreground">{m.email}</span>}
            </div>
            {canEdit ? (
              <div className="flex items-center gap-1">
                <RoleSelect value={m.role as Role} onChange={(role) => setRole(m.user_id, role)} disabled={pending} />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remover membro"
                  onClick={() => remove(m.user_id)}
                  disabled={pending}
                >
                  <UserMinusIcon />
                </Button>
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">{roleLabel[m.role] ?? m.role}</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

type Invite = { id: string; email: string; role: string; expires_at: string; created_at: string; expired: boolean };

export function InvitesSection({ orgId, invites }: { orgId: string; invites: Invite[] }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [link, setLink] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Section
      title="Convites"
      description="O convite gera um link para você enviar à pessoa. Ele expira em 7 dias e só funciona com o mesmo e-mail."
    >
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const result = await createInvite({ orgId, email, role });
            if (!result.ok) return void toast.error(result.error);
            setLink(result.data.link);
            setEmail("");
            router.refresh();
          });
        }}
      >
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="invite-email">E-mail</Label>
          <Input
            id="invite-email"
            type="email"
            placeholder="colega@empresa.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <RoleSelect value={role} onChange={setRole} />
        <Button type="submit" disabled={pending}>
          {pending ? "Gerando..." : "Gerar convite"}
        </Button>
      </form>

      {link && (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <LinkIcon className="size-4" /> Link do convite
          </p>
          <div className="flex items-center gap-1">
            <code className="flex-1 truncate font-mono text-xs">{link}</code>
            <CopyButton value={link} label="Copiar link" showLabel size="sm" variant="outline" />
          </div>
          <p className="text-xs text-muted-foreground">Copie agora: por segurança, o link não é mostrado de novo.</p>
        </div>
      )}

      {invites.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {invites.map((invite) => {
            const { expired } = invite;
            return (
              <li key={invite.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium">{invite.email}</span>
                  <span className="text-xs text-muted-foreground">
                    {roleLabel[invite.role]} · {expired ? "expirado em" : "expira em"} {formatDateTime(invite.expires_at)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const result = await revokeInvite({ orgId, inviteId: invite.id });
                      if (!result.ok) return void toast.error(result.error);
                      toast.success("Convite revogado.");
                      router.refresh();
                    })
                  }
                >
                  <Trash2Icon />
                  Revogar
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

type ApiKeyItem = { id: string; name: string; prefix: string; created_at: string; last_used_at: string | null };

export function ApiKeysSection({ orgId, apiKeys, isDemo }: { orgId: string; apiKeys: ApiKeyItem[]; isDemo: boolean }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <Section
      title="Chaves de API"
      description="Use no header Authorization: Bearer <chave> para acessar a API. Veja a documentação no README."
    >
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const result = await createApiKey({ orgId, name });
            if (!result.ok) return void toast.error(result.error);
            setNewKey(result.data.key);
            setName("");
            router.refresh();
          });
        }}
      >
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="api-key-name">Nome</Label>
          <Input
            id="api-key-name"
            placeholder="Ex.: Integração de CI"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            disabled={isDemo}
            required
          />
        </div>
        <Button type="submit" disabled={pending || isDemo}>
          {pending ? "Criando..." : "Criar chave"}
        </Button>
      </form>
      {isDemo && <p className="text-xs text-muted-foreground">Indisponível na demo pública</p>}

      {newKey && (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <KeyRoundIcon className="size-4" /> Nova chave de API
          </p>
          <div className="flex items-center gap-1">
            <code className="flex-1 break-all font-mono text-xs">{newKey}</code>
            <CopyButton value={newKey} label="Copiar chave" showLabel size="sm" variant="outline" />
          </div>
          <p className="text-xs text-muted-foreground">Copie agora: ela não será mostrada de novo.</p>
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setNewKey(null)}>
            Fechar
          </Button>
        </div>
      )}

      {apiKeys.length > 0 && (
        <ul className="divide-y rounded-xl border">
          {apiKeys.map((apiKey) => (
            <li key={apiKey.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{apiKey.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{apiKey.prefix}…</span>
                <span className="text-xs text-muted-foreground">
                  Criada em {formatDateTime(apiKey.created_at)} · Último uso:{" "}
                  {apiKey.last_used_at ? formatDateTime(apiKey.last_used_at) : "Nunca"}
                </span>
              </div>
              <AlertDialog>
                <AlertDialogTrigger
                  render={<Button variant="ghost" size="icon-sm" aria-label="Excluir chave" disabled={pending} />}
                >
                  <Trash2Icon />
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Excluir “{apiKey.name}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Quem usa esta chave perde o acesso à API na hora. Esta ação não pode ser desfeita.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          const result = await deleteApiKey({ keyId: apiKey.id });
                          if (!result.ok) return void toast.error(result.error);
                          toast.success("Chave excluída.");
                          router.refresh();
                        })
                      }
                    >
                      Excluir
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

import { ActivityIcon, KeyRoundIcon, RepeatIcon, ShieldCheckIcon, UsersIcon, ZapIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { DemoButton } from "@/components/demo-button";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { buttonVariants } from "@/components/ui/button";

const features = [
  { icon: ZapIcon, title: "Inspeção em tempo real", text: "Cada requisição aparece na hora, com corpo, headers e query." },
  { icon: ShieldCheckIcon, title: "Assinatura HMAC", text: "Valida a assinatura e o timestamp de cada webhook recebido." },
  { icon: RepeatIcon, title: "Encaminhamento com retry", text: "Repasse para a sua API com até 5 novas tentativas pelo QStash." },
  { icon: UsersIcon, title: "Multi-tenant", text: "Organizações, papéis e convites, isolados por RLS no Postgres." },
  { icon: KeyRoundIcon, title: "Segredos cifrados", text: "AES-256-GCM em repouso e headers sensíveis redigidos." },
  { icon: ActivityIcon, title: "Histórico de entregas", text: "Status, duração e erro de cada tentativa de encaminhamento." },
];

export default function Home() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Link href="/login" className={buttonVariants({ variant: "ghost" })}>
            Entrar
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 sm:px-6">
        <section className="flex flex-col items-center gap-6 py-14 text-center sm:py-20">
          <span className="rounded-full border px-3 py-1 text-xs text-muted-foreground">
            Projeto open source · Next.js + Supabase + Upstash
          </span>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Uma caixa de entrada para os seus webhooks
          </h1>
          <p className="max-w-2xl text-lg text-pretty text-muted-foreground">
            Receba webhooks numa URL própria, veja cada requisição chegar em tempo real, confira a assinatura e
            encaminhe para a sua aplicação com retry automático.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <DemoButton />
            <Link href="/login" className={buttonVariants({ variant: "outline", size: "lg" })}>
              Entrar
            </Link>
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border bg-muted/30 shadow-sm">
          <Image
            src="/inspector.png"
            alt="Inspetor do Hookbox mostrando a lista de requisições e o corpo JSON de um webhook"
            width={1440}
            height={900}
            priority
            className="h-auto w-full"
          />
        </section>

        <section className="grid gap-6 py-16 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, text }) => (
            <div key={title} className="flex flex-col gap-2">
              <Icon className="size-5 text-muted-foreground" />
              <h2 className="font-medium">{title}</h2>
              <p className="text-sm text-muted-foreground">{text}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-sm text-muted-foreground sm:px-6">
          <span>Hookbox — projeto de portfólio</span>
          <a href="https://github.com/BernardoCusmanich/hookbox" className="hover:text-foreground">
            Código no GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}

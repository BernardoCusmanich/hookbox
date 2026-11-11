import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold">Página não encontrada</h1>
      <p className="text-sm text-muted-foreground">O endereço não existe ou você não tem acesso a ele.</p>
      <Link href="/app" className={buttonVariants({ variant: "outline" })}>
        Voltar ao início
      </Link>
    </div>
  );
}

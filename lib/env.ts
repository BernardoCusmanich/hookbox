import { z } from "zod";

/**
 * Variáveis de ambiente validadas com Zod.
 *
 * - `clientEnv`: só `NEXT_PUBLIC_*`, seguras para o navegador. Cada uma é lida
 *   com `process.env.NOME` literal, para o Next inlinear no bundle.
 * - `serverEnv`: tudo o que é segredo. Acessar no navegador lança erro.
 *
 * `next.config.ts` chama `validateEnv()`, então faltar alguma variável quebra o build.
 */

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

const base64Key32 = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, "base64").length === 32, {
    message: "precisa ser 32 bytes em base64 (openssl rand -base64 32)",
  });

const serverSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  APP_URL: z.url().transform((v) => v.replace(/\/+$/, "")),
  ENCRYPTION_KEY: base64Key32,
  QSTASH_TOKEN: z.string().min(1),
  QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
  QSTASH_NEXT_SIGNING_KEY: z.string().min(1),
  /** Opcional: só para o servidor local do QStash (`npx @upstash/qstash-cli dev`). */
  QSTASH_URL: z.url().optional(),
  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  CRON_SECRET: z.string().min(16),
  DEMO_EMAIL: z.email(),
  DEMO_PASSWORD: z.string().min(8),
});

export type ClientEnv = z.infer<typeof clientSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

function format(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
}

function parseClient(): ClientEnv {
  const parsed = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!parsed.success) {
    throw new Error(`Variáveis de ambiente públicas inválidas:\n${format(parsed.error)}`);
  }
  return parsed.data;
}

function parseServer(): ServerEnv {
  const parsed = serverSchema.safeParse({
    ...process.env,
    // A integração do Upstash na Vercel Marketplace cria KV_REST_API_*; aceita os dois nomes.
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  });
  if (!parsed.success) {
    throw new Error(`Variáveis de ambiente do servidor inválidas:\n${format(parsed.error)}`);
  }
  return parsed.data;
}

let cachedClient: ClientEnv | undefined;

export const clientEnv: ClientEnv = new Proxy({} as ClientEnv, {
  get(_target, prop: string) {
    cachedClient ??= parseClient();
    return cachedClient[prop as keyof ClientEnv];
  },
});

let cachedServer: ServerEnv | undefined;

export const serverEnv: ServerEnv = new Proxy({} as ServerEnv, {
  get(_target, prop: string) {
    if (typeof window !== "undefined") {
      throw new Error(`serverEnv.${prop} não pode ser lido no navegador.`);
    }
    cachedServer ??= parseServer();
    return cachedServer[prop as keyof ServerEnv];
  },
});

/** Valida tudo de uma vez. Chamado no build (next.config.ts) e no seed. */
export function validateEnv(): void {
  cachedClient = parseClient();
  cachedServer = parseServer();
}

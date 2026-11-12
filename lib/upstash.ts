import "server-only";
import { Client, Receiver } from "@upstash/qstash";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { MAX_RETRIES } from "@/lib/deliver";
import { serverEnv } from "@/lib/env";

let qstash: Client | undefined;
let receiver: Receiver | undefined;
let redis: Redis | undefined;
let limiters: { slug: Ratelimit; ip: Ratelimit; api: Ratelimit } | undefined;

export function qstashClient(): Client {
  qstash ??= new Client({
    token: serverEnv.QSTASH_TOKEN,
    ...(serverEnv.QSTASH_URL ? { baseUrl: serverEnv.QSTASH_URL } : {}),
  });
  return qstash;
}

export function qstashReceiver(): Receiver {
  receiver ??= new Receiver({
    currentSigningKey: serverEnv.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: serverEnv.QSTASH_NEXT_SIGNING_KEY,
  });
  return receiver;
}

/** Enfileira a entrega de uma requisição para o /api/deliver, com até MAX_RETRIES retries. */
export async function enqueueDelivery(requestId: string): Promise<void> {
  await qstashClient().publishJSON({
    url: `${serverEnv.APP_URL}/api/deliver`,
    body: { requestId },
    retries: MAX_RETRIES,
    headers: protectionBypassHeaders(),
  });
}

/**
 * As previews da Vercel ficam atrás do Deployment Protection. Com o "Protection Bypass for
 * Automation" ligado, a Vercel expõe VERCEL_AUTOMATION_BYPASS_SECRET, e o QStash repassa este
 * header para o /api/deliver. Em produção (sem proteção) nada é enviado.
 */
export function protectionBypassHeaders(): Record<string, string> | undefined {
  const secret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (process.env.VERCEL_ENV !== "preview" || !secret) return undefined;
  return { "x-vercel-protection-bypass": secret };
}

export function redisClient(): Redis {
  redis ??= new Redis({
    url: serverEnv.UPSTASH_REDIS_REST_URL,
    token: serverEnv.UPSTASH_REDIS_REST_TOKEN,
  });
  return redis;
}

/** Trava de alerta por endpoint: true só para o primeiro pedido dentro da janela. */
export async function acquireAlertThrottle(endpointId: string, seconds: number): Promise<boolean> {
  const result = await redisClient().set(`hookbox:alert:${endpointId}`, "1", { nx: true, ex: seconds });
  return result === "OK";
}

/** Sliding window: 60 req/min por slug, 120 req/min por IP e 60 req/min por chave de API. */
export function rateLimiters() {
  if (!limiters) {
    const client = redisClient();
    limiters = {
      slug: new Ratelimit({
        redis: client,
        limiter: Ratelimit.slidingWindow(60, "1 m"),
        prefix: "hookbox:rl:slug",
      }),
      ip: new Ratelimit({
        redis: client,
        limiter: Ratelimit.slidingWindow(120, "1 m"),
        prefix: "hookbox:rl:ip",
      }),
      api: new Ratelimit({
        redis: client,
        limiter: Ratelimit.slidingWindow(60, "1 m"),
        prefix: "hookbox:rl:api",
      }),
    };
  }
  return limiters;
}

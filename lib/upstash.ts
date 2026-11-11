import "server-only";
import { Client, Receiver } from "@upstash/qstash";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { serverEnv } from "@/lib/env";

let qstash: Client | undefined;
let receiver: Receiver | undefined;
let limiters: { slug: Ratelimit; ip: Ratelimit } | undefined;

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

/** Enfileira a entrega de uma requisição para o /api/deliver, com até 5 retries. */
export async function enqueueDelivery(requestId: string): Promise<void> {
  await qstashClient().publishJSON({
    url: `${serverEnv.APP_URL}/api/deliver`,
    body: { requestId },
    retries: 5,
  });
}

/** Sliding window: 60 req/min por slug e 120 req/min por IP. */
export function rateLimiters() {
  if (!limiters) {
    const redis = new Redis({
      url: serverEnv.UPSTASH_REDIS_REST_URL,
      token: serverEnv.UPSTASH_REDIS_REST_TOKEN,
    });
    limiters = {
      slug: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(60, "1 m"),
        prefix: "hookbox:rl:slug",
      }),
      ip: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(120, "1 m"),
        prefix: "hookbox:rl:ip",
      }),
    };
  }
  return limiters;
}

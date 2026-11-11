import { shellQuote } from "@/lib/format";
import { REDACTED } from "@/lib/ingest-constants";

/** Headers que não fazem sentido repetir num cURL. */
const SKIP = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "accept-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "forwarded",
  "via",
  "cdn-loop",
]);

export function buildCurl(params: {
  url: string;
  method: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: string | null;
  bodyEncoding: string;
}): string {
  const url = new URL(params.url);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    for (const v of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(v));
  }

  const lines: string[] = [];
  const method = params.method.toUpperCase();
  lines.push(`curl -X ${method} ${shellQuote(url.toString())}`);
  for (const [name, value] of Object.entries(params.headers ?? {})) {
    if (SKIP.has(name) || typeof value !== "string" || value === REDACTED) continue;
    lines.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
  }

  const hasBody = Boolean(params.body) && method !== "GET" && method !== "HEAD";
  if (hasBody && params.bodyEncoding === "base64") {
    lines.push("  --data-binary @-");
    return `printf '%s' ${shellQuote(params.body!)} | base64 -d | \\\n${lines.join(" \\\n")}`;
  }
  if (hasBody) lines.push(`  --data-binary ${shellQuote(params.body!)}`);
  return lines.join(" \\\n");
}

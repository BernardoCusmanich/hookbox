import type { NextConfig } from "next";
import { validateEnv } from "./lib/env";

// Falta de variável de ambiente quebra o build (e o `next dev`).
validateEnv();

const isDev = process.env.NODE_ENV !== "production";
// HTTPS só quando o app é servido em https (na Vercel). Local com `next start` fica em http.
const isHttps = process.env.APP_URL?.startsWith("https://") ?? false;
const supabaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);
const supabaseWs = `${supabaseUrl.protocol === "https:" ? "wss:" : "ws:"}//${supabaseUrl.host}`;

const csp = [
  "default-src 'self'",
  // O Next injeta scripts inline para hidratação; 'unsafe-eval' só no dev (React Refresh).
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://avatars.githubusercontent.com",
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseUrl.origin} ${supabaseWs}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  ...(isHttps ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ...(isHttps ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

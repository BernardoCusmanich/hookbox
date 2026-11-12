/**
 * Aplica no Supabase hospedado os templates de e-mail definidos em supabase/config.toml
 * (seções [auth.email.template.*]), para produção ficar igual ao ambiente local.
 *
 * Uso: npm run email:templates -- <project-ref>
 * Token: SUPABASE_ACCESS_TOKEN ou o arquivo ~/.supabase/access-token do `supabase login`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "..");

const ref = process.argv[2] ?? process.env.SUPABASE_PROJECT_REF;
if (!ref) {
  console.error("Informe o project ref: npm run email:templates -- <project-ref>");
  process.exit(1);
}

const token =
  process.env.SUPABASE_ACCESS_TOKEN ??
  readFileSync(join(homedir(), ".supabase", "access-token"), "utf8").trim();

const config = readFileSync(join(root, "supabase", "config.toml"), "utf8");
const section = /^\[auth\.email\.template\.(\w+)\]\s*\nsubject = "(.*)"\s*\ncontent_path = "(.*)"/gm;

const body: Record<string, string> = {};
for (const [, name, subject, contentPath] of config.matchAll(section)) {
  body[`mailer_subjects_${name}`] = subject;
  body[`mailer_templates_${name}_content`] = readFileSync(join(root, contentPath), "utf8");
}

const names = Object.keys(body)
  .filter((k) => k.startsWith("mailer_subjects_"))
  .map((k) => k.slice("mailer_subjects_".length));
if (names.length === 0) {
  console.error("Nenhuma seção [auth.email.template.*] encontrada no config.toml.");
  process.exit(1);
}

async function main() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/config/auth`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Falhou (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  console.log(`Templates aplicados em ${ref}: ${names.join(", ")}`);
}

void main();

import { MAX_BODY_BYTES } from "@/lib/ingest";

/**
 * Transformação de payload: um template JSON com placeholders `{{ caminho }}` que gera o corpo
 * encaminhado no lugar do original. Módulo puro (sem eval, sem Function, sem dependências de servidor).
 */

export const MAX_TEMPLATE_CHARS = 10_000;
/** O resultado respeita o mesmo limite de corpo da ingestão (256 KB). */
export const MAX_OUTPUT_BYTES = MAX_BODY_BYTES;
const MAX_DEPTH = 32;
const ROOTS = ["body", "headers", "query", "method"] as const;
type Root = (typeof ROOTS)[number];

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransformError";
  }
}

export type TransformContext = {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
};

type Segment = string | number;
type Path = { root: Root; segments: Segment[] };

/** Texto entre {{ e }} sem '}' dentro: busca linear, sem backtracking. */
const PLACEHOLDER_RE = /\{\{([^{}]*)\}\}/g;
const KEY_RE = /^[A-Za-z0-9_-]+$/;
const INDEX_RE = /^\d+$/;

function parsePath(raw: string): Path | null {
  const text = raw.trim();
  let i = 0;
  while (i < text.length && text[i] !== "." && text[i] !== "[") i++;
  const root = text.slice(0, i) as Root;
  if (!ROOTS.includes(root)) return null;

  const segments: Segment[] = [];
  while (i < text.length) {
    if (text[i] === ".") {
      let j = i + 1;
      while (j < text.length && text[j] !== "." && text[j] !== "[") j++;
      const key = text.slice(i + 1, j);
      if (!KEY_RE.test(key)) return null;
      segments.push(root === "headers" && segments.length === 0 ? key.toLowerCase() : key);
      i = j;
    } else {
      const close = text.indexOf("]", i);
      if (close === -1) return null;
      const index = text.slice(i + 1, close);
      if (!INDEX_RE.test(index)) return null;
      const n = Number(index);
      if (!Number.isSafeInteger(n)) return null;
      segments.push(n);
      i = close + 1;
    }
  }
  // `method` não tem filhos; headers e query exigem uma chave para serem úteis, mas a raiz sozinha é válida.
  if (root === "method" && segments.length > 0) return null;
  return { root, segments };
}

function lookup(path: Path, ctx: TransformContext): unknown {
  let current: unknown = ctx[path.root];
  for (const segment of path.segments) {
    if (current === null || current === undefined) return null;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return null;
      current = current[segment];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return null;
      if (!Object.hasOwn(current, segment)) return null;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current === undefined ? null : current;
}

function interpolate(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
}

function parseTemplate(template: string): unknown {
  if (template.length > MAX_TEMPLATE_CHARS) {
    throw new TransformError("O template pode ter no máximo 10.000 caracteres.");
  }
  try {
    return JSON.parse(template);
  } catch {
    throw new TransformError("O template não é um JSON válido.");
  }
}

const OUTPUT_TOO_BIG = "O resultado da transformação passa de 256 KB.";

/**
 * Orçamento de tamanho (em caracteres, que são <= bytes) consumido pelos valores inseridos. Um template
 * pequeno com muitos `{{ body }}` poderia multiplicar um corpo de 256 KB; aborta cedo em vez de montar tudo.
 */
type Budget = { left: number; sizes: WeakMap<object, number> };

function newBudget(): Budget {
  return { left: MAX_OUTPUT_BYTES, sizes: new WeakMap() };
}

function spend(budget: Budget, value: unknown): void {
  let size: number;
  if (typeof value === "string") size = value.length;
  else if (value !== null && typeof value === "object") {
    const cached = budget.sizes.get(value);
    size = cached ?? (JSON.stringify(value)?.length ?? 0);
    if (cached === undefined) budget.sizes.set(value, size);
  } else size = 8;
  budget.left -= size;
  if (budget.left < 0) throw new TransformError(OUTPUT_TOO_BIG);
}

/** Percorre o template; `ctx` nulo só valida os caminhos. */
function walk(node: unknown, ctx: TransformContext | null, depth: number, budget: Budget): unknown {
  if (depth > MAX_DEPTH) throw new TransformError("O template tem aninhamento demais (máximo de 32 níveis).");
  if (typeof node === "string") return renderString(node, ctx, budget);
  if (Array.isArray(node)) return node.map((item) => walk(item, ctx, depth + 1, budget));
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      // defineProperty evita que uma chave "__proto__" altere o protótipo.
      Object.defineProperty(out, key, {
        value: walk(value, ctx, depth + 1, budget),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return node;
}

function renderString(text: string, ctx: TransformContext | null, budget: Budget): unknown {
  const matches = [...text.matchAll(PLACEHOLDER_RE)];
  if (matches.length === 0) return text;

  const paths = matches.map((m) => {
    const path = parsePath(m[1]);
    if (!path) throw new TransformError(`Caminho inválido: {{ ${m[1].trim()} }}.`);
    return path;
  });
  if (!ctx) return text;

  // A string inteira é um único placeholder: preserva o tipo original.
  if (matches.length === 1 && matches[0][0] === text) {
    const value = lookup(paths[0], ctx);
    spend(budget, value);
    return value;
  }

  let result = "";
  let last = 0;
  matches.forEach((m, i) => {
    const piece = interpolate(lookup(paths[i], ctx));
    spend(budget, piece);
    result += text.slice(last, m.index) + piece;
    last = (m.index ?? 0) + m[0].length;
  });
  return result + text.slice(last);
}

/** null se o template é válido; senão a mensagem de erro em pt-BR. */
export function validateTemplate(template: string): string | null {
  try {
    walk(parseTemplate(template), null, 0, newBudget());
    return null;
  } catch (err) {
    if (err instanceof TransformError) return err.message;
    throw err;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === "string") out[key.toLowerCase()] = v;
    }
  }
  return out;
}

function queryRecord(value: unknown): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === "string") out[key] = v;
      else if (Array.isArray(v)) out[key] = v.filter((item): item is string => typeof item === "string");
    }
  }
  return out;
}

export function buildTransformContext(req: {
  method: string;
  headers: unknown;
  query: unknown;
  body: string | null;
  body_encoding: string;
}): TransformContext {
  let body: unknown = null;
  if (req.body_encoding === "utf8" && req.body !== null) {
    try {
      body = JSON.parse(req.body);
    } catch {
      body = req.body;
    }
  }
  return { method: req.method, headers: stringRecord(req.headers), query: queryRecord(req.query), body };
}

/** Aplica o template e devolve o JSON (texto) a ser encaminhado. */
export function applyTransform(template: string, ctx: TransformContext): string {
  const output = JSON.stringify(walk(parseTemplate(template), ctx, 0, newBudget()));
  if (new TextEncoder().encode(output).byteLength > MAX_OUTPUT_BYTES) throw new TransformError(OUTPUT_TOO_BIG);
  return output;
}

import { Fragment, type ReactNode } from "react";

const TOKEN_RE = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const MAX_HIGHLIGHT_CHARS = 100_000;

/** JSON formatado com destaque de sintaxe, sem dangerouslySetInnerHTML. */
export function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  if (text.length > MAX_HIGHLIGHT_CHARS) return <pre className="code-block">{text}</pre>;

  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const token = match[0];
    let className = "text-amber-700 dark:text-amber-300"; // número
    if (token.startsWith('"')) {
      className = match[2] ? "text-sky-700 dark:text-sky-300" : "text-emerald-700 dark:text-emerald-300";
    } else if (token === "true" || token === "false") {
      className = "text-violet-700 dark:text-violet-300";
    } else if (token === "null") {
      className = "text-muted-foreground";
    }
    nodes.push(
      <span key={i++} className={className}>
        {token}
      </span>,
    );
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return (
    <pre className="code-block">
      <Fragment>{nodes}</Fragment>
    </pre>
  );
}

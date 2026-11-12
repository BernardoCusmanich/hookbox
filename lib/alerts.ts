/**
 * Alerta por e-mail quando uma entrega falha de vez (falha permanente ou retries esgotados).
 * Sem dependências de servidor, para poder ser testado com fakes em memória.
 *
 * Regras:
 * - vai só para os owners da organização;
 * - no máximo um e-mail por endpoint por hora (trava no Redis);
 * - sem SMTP configurado, nada é enviado (local e CI).
 */

export const ALERT_THROTTLE_SECONDS = 60 * 60;

export type FailureInfo = {
  orgId: string;
  orgSlug: string;
  endpointId: string;
  endpointName: string;
  requestId: string;
  attempt: number;
  statusCode: number | null;
  error: string;
};

export type Email = { to: string[]; subject: string; html: string; text: string };

export type AlertDeps = {
  /** Endereço do app, sem barra no final. */
  appUrl: string;
  /** false quando não há SMTP configurado: o alerta é ignorado. */
  enabled: boolean;
  ownerEmails(orgId: string): Promise<string[]>;
  /** true se conseguiu a trava (nenhum alerta deste endpoint na última hora). */
  acquireThrottle(endpointId: string, seconds: number): Promise<boolean>;
  sendEmail(email: Email): Promise<void>;
};

export type AlertResult = "disabled" | "no-recipients" | "throttled" | "sent";

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function buildFailureEmail(info: FailureInfo, appUrl: string, to: string[]): Email {
  const link = `${appUrl}/app/${encodeURIComponent(info.orgSlug)}/endpoints/${encodeURIComponent(info.endpointId)}`;
  const status = info.statusCode === null ? "sem resposta" : String(info.statusCode);
  const tentativas = info.attempt === 1 ? "1 tentativa" : `${info.attempt} tentativas`;
  const subject = `Falha no encaminhamento: ${info.endpointName}`;

  const text = [
    `O encaminhamento de uma requisição do endpoint "${info.endpointName}" falhou depois de ${tentativas}.`,
    "",
    `Status do destino: ${status}`,
    `Erro: ${info.error}`,
    `Requisição: ${info.requestId}`,
    "",
    `Ver no Hookbox: ${link}`,
    "",
    "Você recebe no máximo um alerta por endpoint a cada hora.",
  ].join("\n");

  const html = `<!doctype html>
<html lang="pt-BR">
<body style="font-family: system-ui, sans-serif; color: #111; line-height: 1.5;">
  <h2 style="margin: 0 0 12px;">Falha no encaminhamento</h2>
  <p>O encaminhamento de uma requisição do endpoint <strong>${escapeHtml(info.endpointName)}</strong>
  falhou depois de ${tentativas}.</p>
  <table style="border-collapse: collapse; font-size: 14px;">
    <tr><td style="padding: 4px 12px 4px 0; color: #555;">Status do destino</td><td>${escapeHtml(status)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #555;">Erro</td><td>${escapeHtml(info.error)}</td></tr>
    <tr><td style="padding: 4px 12px 4px 0; color: #555;">Requisição</td><td><code>${escapeHtml(info.requestId)}</code></td></tr>
  </table>
  <p style="margin: 20px 0;"><a href="${escapeHtml(link)}" style="background: #111; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none;">Ver no Hookbox</a></p>
  <p style="font-size: 12px; color: #777;">Você recebe no máximo um alerta por endpoint a cada hora.</p>
</body>
</html>`;

  return { to, subject, html, text };
}

export async function sendFailureAlert(info: FailureInfo, deps: AlertDeps): Promise<AlertResult> {
  if (!deps.enabled) return "disabled";
  const to = [...new Set(await deps.ownerEmails(info.orgId))];
  if (to.length === 0) return "no-recipients";
  if (!(await deps.acquireThrottle(info.endpointId, ALERT_THROTTLE_SECONDS))) return "throttled";
  await deps.sendEmail(buildFailureEmail(info, deps.appUrl, to));
  return "sent";
}

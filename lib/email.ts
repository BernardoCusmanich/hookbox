import "server-only";
import type { Email } from "@/lib/alerts";
import { serverEnv } from "@/lib/env";

/** Envia um e-mail pela API HTTP do Resend (https://resend.com/docs/api-reference/emails/send-email). */
export async function sendEmail(email: Email): Promise<void> {
  const apiKey = serverEnv.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY não configurada");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: serverEnv.ALERT_EMAIL_FROM,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Resend respondeu ${response.status}`);
}

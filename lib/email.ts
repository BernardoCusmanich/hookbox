import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import type { Email } from "@/lib/alerts";
import { serverEnv } from "@/lib/env";

let transporter: Transporter | undefined;

/** true quando há servidor SMTP configurado (sem ele, os alertas ficam desligados). */
export function emailEnabled(): boolean {
  return Boolean(serverEnv.SMTP_HOST);
}

function smtp(): Transporter {
  if (!serverEnv.SMTP_HOST) throw new Error("SMTP_HOST não configurado");
  transporter ??= nodemailer.createTransport({
    host: serverEnv.SMTP_HOST,
    port: serverEnv.SMTP_PORT,
    // 465 usa TLS direto; nas outras portas o nodemailer faz STARTTLS quando o servidor oferece.
    secure: serverEnv.SMTP_PORT === 465,
    auth: serverEnv.SMTP_USER ? { user: serverEnv.SMTP_USER, pass: serverEnv.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  });
  return transporter;
}

/** Envia um e-mail pelo SMTP configurado (em produção, o Gmail do projeto). */
export async function sendEmail(email: Email): Promise<void> {
  await smtp().sendMail({
    from: serverEnv.ALERT_EMAIL_FROM ?? serverEnv.SMTP_USER,
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
}

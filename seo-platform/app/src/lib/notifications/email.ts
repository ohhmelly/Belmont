/**
 * Optional SMTP email delivery (Phase 5). Entirely gated on `SMTP_URL`
 * being set: with no `SMTP_URL`, `sendEmailNotification` logs that it
 * would have sent and resolves `{ sent: false, reason: "smtp_not_configured" }`
 * — it never throws and never blocks the pipeline. Nothing else in the
 * app depends on this succeeding; the in-app `notifications` row (see
 * notifier.ts) is written regardless and is the notification path that
 * requires no external service.
 *
 * `SMTP_URL` is a standard `smtp://user:pass@host:port` (or `smtps://`)
 * connection string, as nodemailer's `createTransport` accepts directly.
 */
import nodemailer from "nodemailer";

export interface SendEmailParams {
  to?: string | null;
  subject: string;
  text: string;
}

export interface SendEmailResult {
  sent: boolean;
  reason?: string;
  messageId?: string;
}

export async function sendEmailNotification(params: SendEmailParams): Promise<SendEmailResult> {
  const smtpUrl = process.env.SMTP_URL;
  const from = process.env.SMTP_FROM ?? "seo-platform@localhost";

  if (!smtpUrl) {
    console.log(
      `[notifications/email] SMTP_URL not configured — would have sent "${params.subject}" to ${params.to ?? "(no recipient on file)"}. No-op.`
    );
    return { sent: false, reason: "smtp_not_configured" };
  }

  if (!params.to) {
    console.log(`[notifications/email] no recipient resolved for "${params.subject}" — skipping send.`);
    return { sent: false, reason: "no_recipient" };
  }

  try {
    const transport = nodemailer.createTransport(smtpUrl);
    const info = await transport.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
    });
    console.log(`[notifications/email] sent "${params.subject}" to ${params.to} (messageId=${info.messageId})`);
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notifications/email] send failed, continuing without it: ${message}`);
    return { sent: false, reason: `send_failed: ${message}` };
  }
}

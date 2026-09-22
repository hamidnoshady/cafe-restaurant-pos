/**
 * Phase 37 Wave 3 — email via SMTP (nodemailer).
 *
 * A marketing email is plain text with a fixed simple HTML mirror (Phase 37's
 * out-of-scope note: no visual email editor). Nodemailer owns the transport;
 * this adapter only translates the seam's `OutboundMessage` into a mail and
 * nodemailer's errors onto the provider error catalogue, so an owner never sees
 * a raw SMTP code (Phase 33's rule).
 */
import nodemailer from "nodemailer";
import type {
  MessageProvider,
  OutboundMessage,
  SendResult,
} from "../provider";

export interface SmtpConnection {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
}

function classifySmtpError(error: unknown): { retryable: boolean; code: string } {
  const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
  const retryableCodes = ["ETIMEDOUT", "ECONNECTION", "ECONNRESET", "ESOCKET", "ETIMEDOUT", "EDNS"];
  if (code && retryableCodes.includes(code)) {
    return { retryable: true, code: "network" };
  }
  // Auth and 5xx recipient problems are permanent.
  return { retryable: false, code: "provider_rejected" };
}

export class SmtpMessageProvider implements MessageProvider {
  readonly key = "smtp";
  readonly channel = "email" as const;

  constructor(private readonly connection: SmtpConnection) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const { host, port, secure, user, password, from } = this.connection;
    if (!host || !from) {
      return { ok: false, retryable: false, code: "provider_config", message: "" };
    }
    let transport;
    try {
      transport = nodemailer.createTransport({
        host,
        port,
        secure,
        ...(user ? { auth: { user, pass: password } } : {}),
      });
    } catch (error) {
      return { ok: false, retryable: false, code: "provider_config", message: error instanceof Error ? error.message : "" };
    }

    try {
      const info = await transport.sendMail({
        from,
        to: msg.to,
        subject: msg.subject ?? "",
        text: msg.body,
        // A fixed, minimal HTML mirror of the same text — never an editor.
        html: `<div dir="rtl" style="font-family:inherit">${escapeHtml(msg.body).replace(/\n/g, "<br/>")}</div>`,
        // Only present for a scheduled data export; a marketing email never
        // carries one, so the key is omitted entirely rather than sent empty.
        ...(msg.attachments && msg.attachments.length > 0
          ? {
              attachments: msg.attachments.map((attachment) => ({
                filename: attachment.filename,
                content: attachment.content,
                contentType: attachment.contentType,
              })),
            }
          : {}),
      });
      return {
        ok: true,
        providerMessageId: String(info.messageId ?? `smtp:${Date.now()}`),
        segments: 1,
      };
    } catch (error) {
      const classified = classifySmtpError(error);
      return {
        ok: false,
        retryable: classified.retryable,
        code: classified.code,
        message: error instanceof Error ? error.message : "smtp error",
      };
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as nodemailer from 'nodemailer';

export interface OutgoingMail {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  html: string;
  text: string;
  attachment?: { filename: string; content: Buffer };
  /** Message-ID propio. Si se omite se genera uno aleatorio. */
  messageId?: string;
}

/**
 * Qué se sabe del resultado cuando falla un envío SMTP:
 * - definite_permanent: el servidor lo rechazó (5xx). No salió y no tiene sentido reintentar.
 * - definite_transient: no salió (conexión, autenticación, 4xx). Es seguro reintentar.
 * - ambiguous: se cortó mientras se enviaba el contenido; puede haber salido o no.
 */
export type SmtpFailure = 'definite_permanent' | 'definite_transient' | 'ambiguous';

export function classifySmtpError(err: any): SmtpFailure {
  const code = Number(err?.responseCode);
  // El servidor respondió con un error: se sabe que no aceptó el mensaje
  if (code >= 500) return 'definite_permanent';
  if (code >= 400) return 'definite_transient';
  // Sin respuesta del servidor. Nodemailer informa igual (ECONNECTION/CONN) una conexión que nunca se
  // estableció y una que se cortó a mitad del envío, así que ante la duda es incierto.
  // Solo hay evidencia de que no salió nada si falló antes de conectar o antes de enviar el contenido.
  const neverConnected =
    ['connect', 'getaddrinfo'].includes(err?.syscall) ||
    ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN'].includes(err?.code) ||
    ['EDNS', 'EENVELOPE', 'EAUTH'].includes(err?.code) ||
    /Connection timeout|Greeting never received/i.test(String(err?.message));
  return neverConnected ? 'definite_transient' : 'ambiguous';
}

/** Message-ID estable para un mismo contenido: un reintento reutiliza el mismo y se puede buscar. */
export const stableMessageId = (kind: string, key: string, domain: string) =>
  `<${kind}-${key.replace(/[^A-Za-z0-9._-]/g, '')}@${domain}>`;

@Injectable()
export class MailService {
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;
  readonly domain: string;

  constructor(private readonly config: ConfigService) {
    const user = config.getOrThrow<string>('SMTP_USER');
    this.from = config.get('MAIL_FROM') ?? user;
    this.domain = user.split('@')[1] ?? 'localhost';
    this.transporter = nodemailer.createTransport({
      host: config.get('SMTP_HOST', 'smtp.office365.com'),
      port: Number(config.get('SMTP_PORT', 587)),
      secure: config.get('SMTP_SECURE', 'false') === 'true', // false: 587 usa STARTTLS; true: 465
      requireTLS: config.get('SMTP_REQUIRE_TLS', 'true') === 'true',
      auth: { user, pass: config.getOrThrow('SMTP_PASS') },
      tls: { minVersion: config.get('SMTP_TLS_MIN_VERSION', 'TLSv1.2') },
    });
  }

  /** Envía el correo y devuelve el Message-ID usado (sirve para verificarlo después). */
  async send(mail: OutgoingMail): Promise<{ messageId: string; rejected: string[] }> {
    const messageId = mail.messageId ?? `<${randomUUID()}@${this.domain}>`;
    const info = await this.transporter.sendMail({
      from: this.from,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      messageId,
      attachments: mail.attachment
        ? [{ filename: mail.attachment.filename, content: mail.attachment.content, contentType: 'application/pdf' }]
        : [],
    });
    if (info.accepted.length === 0) {
      // SMTP respondió y no aceptó a nadie: se sabe que no salió
      const err: any = new Error(`El servidor SMTP rechazó al destinatario: ${info.response}`);
      err.responseCode = 550;
      throw err;
    }
    // Con varios destinatarios puede aceptar a unos y rechazar a otros: el correo sí salió
    return { messageId, rejected: info.rejected.map(String) };
  }
}

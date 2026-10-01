import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as nodemailer from 'nodemailer';

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachment: { filename: string; content: Buffer };
}

@Injectable()
export class MailService {
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;
  private readonly domain: string;

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
  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    const messageId = `<${randomUUID()}@${this.domain}>`;
    const info = await this.transporter.sendMail({
      from: this.from,
      to: mail.to,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      messageId,
      attachments: [
        { filename: mail.attachment.filename, content: mail.attachment.content, contentType: 'application/pdf' },
      ],
    });
    if (info.rejected.length > 0 || info.accepted.length === 0) {
      throw new Error(`El servidor SMTP rechazó al destinatario: ${info.response}`);
    }
    return { messageId };
  }
}

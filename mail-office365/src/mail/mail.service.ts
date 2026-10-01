import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { SendMailDto } from './dto/send-mail.dto';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: config.get('SMTP_HOST', 'smtp.office365.com'),
      port: Number(config.get('SMTP_PORT', 587)),
      secure: false, // 587 usa STARTTLS, no TLS directo
      requireTLS: true,
      auth: {
        user: config.getOrThrow('SMTP_USER'),
        pass: config.getOrThrow('SMTP_PASS'),
      },
      tls: { ciphers: 'TLSv1.2' },
    });
  }

  async sendWithPdf(dto: SendMailDto, file: Express.Multer.File) {
    try {
      const info = await this.transporter.sendMail({
        from: this.config.get('MAIL_FROM') ?? this.config.get('SMTP_USER'),
        to: dto.to,
        cc: dto.cc,
        subject: dto.subject,
        text: dto.body,
        attachments: [
          {
            filename: file.originalname,
            content: file.buffer,
            contentType: 'application/pdf',
          },
        ],
      });
      return { ok: true, messageId: info.messageId, accepted: info.accepted };
    } catch (err) {
      this.logger.error(`Fallo al enviar correo: ${(err as Error).message}`);
      throw new InternalServerErrorException('No se pudo enviar el correo');
    }
  }
}

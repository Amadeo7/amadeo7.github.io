import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'fs';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DEFAULT_HTML = `<!doctype html>
<html lang="es">
<body style="margin:0;padding:0;background:#f3f5f9;font-family:Segoe UI,Arial,sans-serif;color:#18202f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f9;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:8px;padding:28px">
        <tr><td>
          <h2 style="margin:0 0 16px;font-size:20px;color:#0b5fc4">Tu recibo de pago</h2>
          <p style="margin:0 0 12px;font-size:15px;line-height:1.6">Hola {{nombre}},</p>
          <p style="margin:0 0 12px;font-size:15px;line-height:1.6">Adjuntamos tu recibo de pago en formato PDF.</p>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6">Si ves algún error o tienes dudas, responde a este correo o comunícate con el área de nómina.</p>
          <p style="margin:0;font-size:15px;line-height:1.6">Saludos,<br>{{empresa}}</p>
        </td></tr>
      </table>
      <p style="font-size:12px;color:#556073;margin:12px 0 0">Este mensaje contiene información confidencial dirigida únicamente a su destinatario.</p>
    </td></tr>
  </table>
</body>
</html>`;

const DEFAULT_TEXT = `Hola {{nombre}},

Adjuntamos tu recibo de pago en formato PDF.

Si ves algún error o tienes dudas, responde a este correo o comunícate con el área de nómina.

Saludos,
{{empresa}}`;

/**
 * Plantilla del correo. Variables: {{nombre}} y {{empresa}}.
 * Se puede reemplazar con archivos propios (MAIL_TEMPLATE_HTML_PATH / MAIL_TEMPLATE_TEXT_PATH).
 */
@Injectable()
export class ReceiptEmailTemplate {
  private readonly html: string;
  private readonly text: string;
  private readonly company: string;
  private readonly defaultName: string;

  constructor(config: ConfigService) {
    const htmlPath = config.get<string>('MAIL_TEMPLATE_HTML_PATH');
    const textPath = config.get<string>('MAIL_TEMPLATE_TEXT_PATH');
    this.html = htmlPath ? readFileSync(htmlPath, 'utf8') : DEFAULT_HTML;
    this.text = textPath ? readFileSync(textPath, 'utf8') : DEFAULT_TEXT;
    this.company = config.get<string>('COMPANY_NAME', '');
    this.defaultName = config.get<string>('MAIL_DEFAULT_NAME', 'colaborador');
  }

  render(name: string) {
    const who = name || this.defaultName;
    const fill = (tpl: string, n: string, c: string) => tpl.replace(/{{nombre}}/g, n).replace(/{{empresa}}/g, c);
    return {
      html: fill(this.html, escapeHtml(who), escapeHtml(this.company)),
      text: fill(this.text, who, this.company),
    };
  }
}

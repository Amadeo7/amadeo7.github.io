# mail-office365

API NestJS que envía correos con un PDF adjunto usando una cuenta de Office 365 (SMTP).
Explicación visual del funcionamiento: [`docs/como-funciona.html`](docs/como-funciona.html).

## Uso

```bash
npm install
cp .env.example .env   # completa SMTP_USER / SMTP_PASS / MAIL_FROM
npm run start:dev

curl -X POST http://localhost:3000/mail/send \
  -F "to=cliente@ejemplo.com" \
  -F "subject=Factura" \
  -F "body=Adjunto la factura." \
  -F "file=@factura.pdf;type=application/pdf"
```

Campos: `to` (uno o varios separados por coma), `cc` (opcional), `subject`, `body`, `file` (PDF).

> El endpoint no incluye autenticación: protégelo antes de exponerlo.

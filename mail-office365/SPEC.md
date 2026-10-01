# SPEC: mail-office365

API NestJS que envía correos con un PDF adjunto usando una cuenta de Office 365 por SMTP.
Este documento define todo lo necesario para implementarla desde cero.

## 1. Objetivo

Exponer un endpoint HTTP que reciba un PDF y los datos de un correo (destinatarios, asunto, texto) y lo envíe a través del servidor SMTP de Office 365 con las credenciales de un buzón.

### Fuera de alcance (v1)
- Autenticación del endpoint (se documenta como pendiente, ver §10).
- OAuth2 / Microsoft Graph (ver §11, extensión futura).
- Cuerpo HTML, múltiples adjuntos, plantillas, colas de reintento, persistencia.

## 2. Stack

| Elemento | Versión / paquete |
|---|---|
| Node.js | >= 20 |
| NestJS | ^10.4 (`@nestjs/common`, `core`, `platform-express`, `config`) |
| Correo | `nodemailer` ^6.9 |
| Validación | `class-validator` ^0.14, `class-transformer` ^0.5 |
| Subida de archivos | Multer (incluido en `platform-express`), `@types/multer` |
| Lenguaje | TypeScript ^5.5, `strict: true`, `strictPropertyInitialization: false` |
| Gestor | npm |

Dev: `@nestjs/cli`, `@types/express`, `@types/node`, `@types/nodemailer`.

## 3. Estructura

```
mail-office365/
├── package.json
├── tsconfig.json            # commonjs, ES2021, decorators + emitDecoratorMetadata, outDir ./dist
├── nest-cli.json            # sourceRoot: src
├── .gitignore               # node_modules, dist, .env
├── .env.example
├── README.md
├── SPEC.md
├── docs/como-funciona.html  # explicación visual del flujo
└── src/
    ├── main.ts
    ├── app.module.ts
    └── mail/
        ├── mail.module.ts
        ├── mail.controller.ts
        ├── mail.service.ts
        └── dto/send-mail.dto.ts
```

Scripts de `package.json`: `build` (`nest build`), `start`, `start:dev` (`nest start --watch`), `start:prod` (`node dist/main`).

## 4. Configuración (variables de entorno)

Cargadas con `ConfigModule.forRoot({ isGlobal: true })`. Se entrega `.env.example`; `.env` nunca se versiona.

| Variable | Obligatoria | Default | Descripción |
|---|---|---|---|
| `SMTP_HOST` | no | `smtp.office365.com` | Servidor SMTP |
| `SMTP_PORT` | no | `587` | Puerto (STARTTLS) |
| `SMTP_USER` | **sí** | — | Buzón de Office 365 que autentica |
| `SMTP_PASS` | **sí** | — | Contraseña o contraseña de aplicación (MFA) |
| `MAIL_FROM` | no | valor de `SMTP_USER` | Remitente visible, p. ej. `"Mi Empresa <cuenta@dominio.com>"`. Debe ser el buzón o un alias con permiso "Enviar como" |
| `MAX_PDF_MB` | no | `10` | Tamaño máximo del PDF en MB |
| `PORT` | no | `3000` | Puerto HTTP |

Si faltan `SMTP_USER` o `SMTP_PASS`, la app debe fallar al arrancar (`config.getOrThrow`).

## 5. Endpoint

### `POST /mail/send`

`Content-Type: multipart/form-data`

| Campo | Tipo | Obligatorio | Reglas |
|---|---|---|---|
| `to` | texto | sí | Uno o varios correos separados por coma. Se convierte a `string[]` (trim, sin vacíos). Cada uno debe ser email válido; al menos uno |
| `cc` | texto | no | Igual que `to`, opcional |
| `subject` | texto | sí | String no vacío |
| `body` | texto | sí | String no vacío; se envía como texto plano |
| `file` | archivo | sí | PDF |

#### Validación del archivo (controller)
1. `FileInterceptor('file')` con `memoryStorage()` (el PDF nunca se escribe a disco).
2. `limits.fileSize = MAX_PDF_MB * 1024 * 1024`.
3. `fileFilter`: solo `mimetype === 'application/pdf'`; si no, `BadRequestException('Solo se permiten archivos PDF')`.
4. Si no hay archivo: `BadRequestException('Adjunta un PDF en el campo "file"')`.
5. Verificar firma real: los primeros 5 bytes del buffer deben ser `%PDF-`; si no, `BadRequestException('El archivo no es un PDF válido')`.

#### Validación de campos (DTO + `ValidationPipe` global)
`ValidationPipe({ whitelist: true, transform: true })` registrado en `main.ts`. El DTO `SendMailDto` usa `@Transform` para partir strings por coma, más `@IsArray`, `@ArrayNotEmpty` (solo `to`), `@IsEmail({}, { each: true })`, `@IsString`, `@IsNotEmpty`, `@IsOptional` (`cc`).

#### Respuestas

| Caso | Código | Cuerpo |
|---|---|---|
| Enviado | 201 | `{ "ok": true, "messageId": "<...>", "accepted": ["a@x.com"] }` |
| Falta archivo / no es PDF / campo inválido | 400 | Formato estándar de Nest (`message`, `error`, `statusCode`) |
| PDF supera el tamaño máximo | 413 | Generado por Multer/Nest |
| Fallo SMTP (auth, red, rechazo) | 500 | `InternalServerErrorException('No se pudo enviar el correo')` |

El detalle del error SMTP se registra con `Logger` y **no** se devuelve al cliente.

## 6. Comportamiento del servicio (`MailService`)

- Crea un único transporte Nodemailer en el constructor:
  - `host`, `port` desde config; `secure: false`; `requireTLS: true` (STARTTLS en 587).
  - `auth: { user: SMTP_USER, pass: SMTP_PASS }`.
  - `tls: { ciphers: 'TLSv1.2' }`.
- Método `sendWithPdf(dto, file)`:
  - `from`: `MAIL_FROM` o, si no existe, `SMTP_USER`.
  - `to`, `cc`, `subject`, `text: dto.body`.
  - `attachments: [{ filename: file.originalname, content: file.buffer, contentType: 'application/pdf' }]`.
  - Devuelve `{ ok: true, messageId, accepted }`.
  - Ante excepción: log del error y `InternalServerErrorException`.

## 7. Arranque (`main.ts`)

- `NestFactory.create(AppModule)`.
- `app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))`.
- Escucha en `process.env.PORT ?? 3000`.

## 8. Configuración requerida en Office 365 (documentar en README)

1. Buzón real o de servicio que enviará.
2. Centro de administración de Microsoft 365 → Usuarios → buzón → Correo → Administrar aplicaciones de correo electrónico → activar **SMTP autenticado**.
3. Con MFA: crear contraseña de aplicación y usarla como `SMTP_PASS`.
4. Límite de Office 365: ~25 MB por mensaje; `MAX_PDF_MB` debe quedar por debajo.

## 9. Criterios de aceptación

1. `npm install && npm run build` termina sin errores.
2. Sin `SMTP_USER`/`SMTP_PASS` la app no arranca.
3. `POST /mail/send` sin archivo → 400 con mensaje "Adjunta un PDF…".
4. `to=malo` (email inválido) → 400 con mensaje de validación.
5. Archivo `text/plain` → 400 "Solo se permiten archivos PDF".
6. Archivo con mimetype `application/pdf` pero contenido que no empieza con `%PDF-` → 400 "El archivo no es un PDF válido".
7. PDF mayor que `MAX_PDF_MB` → 413.
8. Con credenciales válidas, un PDF real llega al destinatario como adjunto con el nombre original; `to` con dos correos separados por coma entrega a ambos; `cc` se respeta.
9. Con credenciales inválidas → 500 genérico y el motivo real aparece solo en el log.
10. Ningún secreto en el repositorio (`.env` ignorado).

Verificación manual:

```bash
curl -X POST http://localhost:3000/mail/send \
  -F "to=cliente@ejemplo.com,otro@ejemplo.com" \
  -F "cc=jefe@ejemplo.com" \
  -F "subject=Factura de septiembre" \
  -F "body=Hola, adjunto la factura." \
  -F "file=@factura.pdf;type=application/pdf"
```

## 10. Riesgos conocidos

- **Endpoint sin autenticación**: cualquiera con acceso a la URL puede enviar correo desde la cuenta. Antes de producción añadir API key (guard de Nest) o JWT, y rate limiting (`@nestjs/throttler`). Documentarlo en el README.
- **Basic auth SMTP en retirada**: Microsoft está desactivando la autenticación básica en Exchange Online. Un error `535 5.7.139` indica que el tenant la bloquea.

## 11. Extensión futura: Microsoft Graph

Si el tenant bloquea SMTP con contraseña, reemplazar solo `MailService` por una implementación que use Graph (`POST /users/{id}/sendMail` con el adjunto en base64 en `fileAttachment`), con registro de aplicación en Entra ID, permiso de aplicación `Mail.Send` y variables `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. Controller, DTO y contrato HTTP no cambian.

## 12. Documentación a entregar

- `README.md`: instalación, variables, ejemplo de `curl`, aviso de seguridad.
- `docs/como-funciona.html`: página autocontenida en español que explica el flujo (cliente → controller → DTO → service → Office 365), las piezas, la configuración de Office 365, el uso y la seguridad.

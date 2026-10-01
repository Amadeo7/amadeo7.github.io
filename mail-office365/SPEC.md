# SPEC: mail-office365 (envío de recibos de pago desde SFTP)

## 1. Objetivo

Servicio NestJS que:
1. Lee todos los archivos de una carpeta SFTP.
2. Por cada archivo `Recibo de pago <NNNNN>.pdf` extrae `NNNNN` (código de empleado).
3. Busca ese código en la colección de empleados obtenida de una API REST y toma nombre y correo.
4. Envía un correo por archivo, con cuerpo HTML y el PDF adjunto, usando una cuenta de Office 365 (SMTP).
5. Registra cada envío en una tabla de PostgreSQL.
6. Mueve el PDF enviado a una carpeta del SFTP para indicar que se procesó.
7. Si es posible, verifica que el correo se envió y marca el registro como verificado.

Fuera de alcance: lectura de múltiples carpetas, múltiples adjuntos, plantillas editables, interfaz web, réplicas concurrentes.

## 2. Stack

Node >= 20, NestJS ^10.4 (`common`, `core`, `platform-express`, `config`, `schedule`), `nodemailer` ^6.9, `pg` ^8, `ssh2-sftp-client` ^11, `cron` (misma versión exacta que usa `@nestjs/schedule`, para evitar tipos duplicados), TypeScript ^5.5 `strict`. Sin ORM: SQL directo con `pg`. El HTTP a la API de empleados y a Graph usa `fetch` nativo.

## 3. Estructura

```
mail-office365/
├── Dockerfile, .dockerignore, docker-compose.yml
├── package.json, tsconfig.json, nest-cli.json, .env.example, README.md, SPEC.md
└── src/
    ├── main.ts, app.module.ts
    ├── common/api-key.guard.ts
    ├── db/            db.module.ts, db.service.ts          (pool + creación de tabla)
    ├── sftp/          sftp.module.ts, sftp.service.ts      (sesión: listar, descargar, archivar)
    ├── employees/     employees.module.ts, employees.service.ts
    ├── mail/          mail.module.ts, mail.service.ts, receipt-email.template.ts, graph-verifier.service.ts
    └── receipts/      receipts.module.ts, .service.ts, .repository.ts, .controller.ts, .scheduler.ts, parse-receipt-filename.ts
```

## 4. Variables de entorno

**Principio**: ningún valor parametrizable está fijo en el código. Todo se configura en `.env`; `.env.example` lista **todas** las variables con su valor por defecto y es la referencia. El código usa esos mismos defaults solo como respaldo.

Obligatorias (la app falla al arrancar si faltan): `API_KEY`, `DATABASE_URL`, `SFTP_HOST`, `SFTP_USER`, `SFTP_DIR`, `EMPLOYEES_API_URL`, `SMTP_USER`, `SMTP_PASS` y una credencial SFTP (`SFTP_PASSWORD` o `SFTP_PRIVATE_KEY_PATH`).

Grupos (detalle y defaults en `.env.example`):
- **HTTP/ejecución**: `PORT`, `API_KEY`, `RECEIPTS_CRON`, `TZ`, `LIST_DEFAULT_LIMIT`, `LIST_MAX_LIMIT`.
- **Archivos**: `RECEIPT_FILENAME_REGEX` (primer grupo de captura = código de empleado; se valida al arrancar), `MAX_PDF_MB`.
- **SFTP**: `SFTP_HOST/PORT/USER/PASSWORD/PRIVATE_KEY_PATH/PASSPHRASE/HOST_SHA256/READY_TIMEOUT_MS`, `SFTP_DIR`, `SFTP_PROCESSED_DIR`.
- **Empleados**: `EMPLOYEES_API_URL/TOKEN/AUTH_HEADER/AUTH_SCHEME/TIMEOUT_MS/ARRAY_PATH`, `EMPLOYEES_FIELD_CODE/NAME/EMAIL`.
- **SMTP**: `SMTP_HOST/PORT/SECURE/REQUIRE_TLS/TLS_MIN_VERSION/USER/PASS`, `MAIL_FROM`, `SEND_DELAY_MS`.
- **Contenido**: `MAIL_SUBJECT`, `COMPANY_NAME`, `MAIL_DEFAULT_NAME`, `MAIL_TEMPLATE_HTML_PATH`, `MAIL_TEMPLATE_TEXT_PATH`.
- **Graph (verificación)**: `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET/AUTH_URL`, `GRAPH_BASE_URL/SCOPE/MAILBOX/SENT_FOLDER/TIMEOUT_MS`, `VERIFY_MAX_ATTEMPTS`, `VERIFY_BATCH_SIZE`.
- **PostgreSQL**: `DATABASE_URL`, `DATABASE_SSL`, `DB_TABLE` (validada: minúsculas, dígitos y `_`, porque se interpola en el SQL).
- **Docker**: `NODE_VERSION`, `POSTGRES_VERSION`, `POSTGRES_USER/PASSWORD/DB` (los usa `docker-compose.yml` con `${VAR:-default}`; `NODE_VERSION` y `PORT` también son `ARG` del Dockerfile).

## 5. Componentes

### 5.1 Parseo del nombre
Regex de `RECEIPT_FILENAME_REGEX` (default `^Recibo de pago (\d+)\.pdf$`, insensible a mayúsculas; debe tener un grupo de captura). Devuelve el grupo con el código como texto (conserva ceros). Los archivos que no cumplan se **ignoran**: no se registran en la BD, se listan en `ignoredNames` del resumen y no se mueven.

### 5.2 SFTP
- Una conexión por ejecución, cerrada siempre (`finally`).
- Auth por contraseña o llave privada. Si existe `SFTP_HOST_SHA256` se verifica la huella del servidor y se rechaza cualquier otra.
- `listFiles`: solo archivos regulares (no carpetas) de `SFTP_DIR`, ordenados por nombre.
- `download(name)`: devuelve `Buffer`.
- `archive(name, sha256)`: mueve el archivo a `<SFTP_PROCESSED_DIR>/<AAAA-MM-DD>/<nombre sin .pdf>_<AAAAMMDD-HHmmss>_<hash8>.pdf` (fecha y hora en la zona `TZ`), creando las carpetas si no existen. Si el destino ya existiera se añade `_2`, `_3`… Así dos envíos del mismo empleado con el **mismo nombre de archivo** (p. ej. dos recibos por mes) nunca se sobrescriben ni se pierden. Devuelve la ruta final, que se guarda en `processed_path`. Un fallo al mover se registra como advertencia y **no** invalida el envío (el hash evita reenvíos y el movimiento se reintenta en la siguiente ejecución).

### 5.3 Empleados
- `GET EMPLOYEES_API_URL` una vez por ejecución, con `Authorization: Bearer <token>` si hay token, `Accept: application/json`, timeout configurable.
- El arreglo está en la raíz del JSON o en la ruta con puntos de `EMPLOYEES_API_ARRAY_PATH` (p. ej. `data.items`). Si no es un arreglo, error.
- Los nombres de campo se mapean con `EMPLOYEES_FIELD_*` (también admiten rutas con puntos).
- Se indexa por código normalizado (sin espacios y sin ceros a la izquierda): `00123` y `123` coinciden.
- **Supuestos**: la API devuelve todo en una sola respuesta (sin paginación) y usa Bearer. Si no es así hay que adaptar `EmployeesService.load`.
- Si la API falla, la ejecución se aborta antes de enviar o marcar nada (`fatalError` en el resumen).

### 5.4 Correo
- Transporte SMTP: STARTTLS en 587, TLS >= 1.2.
- Message-ID propio generado por envío: `<uuid@dominio-de-SMTP_USER>`; se guarda para verificar.
- Cuerpo HTML con estilos en línea más versión de texto plano, a partir de una plantilla con variables `{{nombre}}` y `{{empresa}}` (`COMPANY_NAME`). Se puede reemplazar con archivos propios (`MAIL_TEMPLATE_HTML_PATH` / `MAIL_TEMPLATE_TEXT_PATH`). En HTML los valores se escapan (`& < > "`). Si la API no trae nombre se usa `MAIL_DEFAULT_NAME`. Asunto = `MAIL_SUBJECT`. Adjunto = el PDF con su nombre original.
- Se trata como fallo si el servidor rechaza al destinatario o no acepta ninguno.

### 5.5 Base de datos
Tabla creada al arrancar (`CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE <DB_TABLE> (  -- por defecto receipt_emails
  id                BIGSERIAL PRIMARY KEY,
  file_name         TEXT NOT NULL,
  file_sha256       TEXT NOT NULL,
  employee_code     TEXT,
  employee_name     TEXT,
  to_email          TEXT,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,   -- intentos de envío SMTP
  message_id        TEXT,
  sent_at           TIMESTAMPTZ,
  verified          BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at       TIMESTAMPTZ,
  verify_attempts   INTEGER NOT NULL DEFAULT 0,
  verification_note TEXT,
  error             TEXT,
  processed_path    TEXT,                          -- ruta final del PDF en el SFTP
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_name, file_sha256)
);
-- índices: (status, verified) y (employee_code)
```

La identidad de un envío es **nombre + SHA-256 del contenido**: el mismo archivo no se reenvía; el mismo nombre con otro contenido (p. ej. el segundo recibo del mes) es un envío nuevo. Limitación: si dos recibos del mismo empleado fueran byte a byte idénticos, el segundo se trataría como duplicado (no se envía, solo se archiva).

### 5.6 Verificación (Microsoft Graph, opcional)
Activa solo si están `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` y `AZURE_CLIENT_SECRET`.
- Token con client credentials (`https://graph.microsoft.com/.default`), cacheado hasta su expiración.
- Consulta `GET /users/{buzón}/mailFolders/sentitems/messages?$filter=internetMessageId eq '<id>'`. Buzón = `GRAPH_MAILBOX` o `SMTP_USER`.
- Requiere permiso de aplicación `Mail.Read` (se recomienda limitarlo al buzón con Application Access Policy).
- Al final de cada ejecución se revisan todos los registros `sent` y no verificados con `verify_attempts < VERIFY_MAX_ATTEMPTS`: encontrado → `verified = true`, `verified_at`, nota; no encontrado o error → incrementa `verify_attempts` y deja nota.
- **Alcance**: confirma que Exchange aceptó y guardó el mensaje en Enviados. No confirma recepción en el buzón del destinatario ni lectura. Sin credenciales, los registros quedan `sent` con `verified = false`.
- **Supuesto a validar en el tenant**: que Exchange Online conserve el Message-ID enviado por SMTP.

## 6. Algoritmo de una ejecución

1. Si ya hay una ejecución en curso → error 409.
2. Cargar empleados (si falla, abortar).
3. Abrir SFTP y listar archivos.
4. Para cada archivo, en orden y secuencialmente:
   1. Parsear nombre; si no cumple, ignorar.
   2. Si `size > MAX_PDF_MB` → fallo. Descargar; si no empieza con `%PDF-` → fallo.
   3. Calcular SHA-256; `findOrCreate` (upsert) del registro.
   4. Si el registro ya está `sent`: contar como omitido, archivar el archivo, continuar.
   5. Buscar empleado; si no existe o su correo no es válido → registro `failed` con el motivo (no cuenta como intento de envío) y el archivo se queda.
   6. Esperar `SEND_DELAY_MS` entre envíos reales (Office 365 limita ~30 correos/min por buzón).
   7. Enviar. Éxito → `status='sent'`, `message_id`, `sent_at`, `attempts+1`, `error=NULL`, y archivar. Error → `status='failed'`, `error`, `attempts+1`.
   8. Cualquier excepción por archivo se captura: no detiene el resto.
5. Cerrar SFTP. Ejecutar verificación de pendientes.
6. Devolver y guardar el resumen: `startedAt`, `finishedAt`, `filesFound`, `sent`, `skippedAlreadySent`, `failed`, `ignoredNames`, `errors[]`, `verified`, `verificationEnabled`, `fatalError?`.

Los archivos fallidos permanecen en la carpeta origen y se reintentan en la siguiente ejecución.

## 7. API HTTP

Todas exigen el header `x-api-key` igual a `API_KEY` (comparación en tiempo constante; 401 si no coincide).

| Método | Ruta | Respuesta |
|---|---|---|
| POST | `/receipts/process` | 202 `{started:true}`; 409 si ya hay una ejecución |
| GET | `/receipts/status` | `{running, lastRun}` |
| GET | `/receipts?status=sent\|failed\|pending&verified=true\|false&limit=1..500` | Registros (sin el hash) |

Ejecución automática: si `RECEIPTS_CRON` está definido (cron de 6 campos), se programa con `SchedulerRegistry` y zona `TZ`; omite el disparo si ya hay una ejecución.

## 8. Contenedor

- `Dockerfile` multi-etapa sobre `node:${NODE_VERSION}-alpine`: etapa de build (`npm ci`, `npm run build`, `npm prune --omit=dev`) y etapa final con solo `node_modules` de producción y `dist`, ejecutando como usuario `node`, `EXPOSE 3000`, `HEALTHCHECK` contra `/receipts/status` con la API key, `CMD ["node","dist/main"]`.
- `.dockerignore` excluye `node_modules`, `dist`, `.env`, `.git`, docs y markdown.
- `docker-compose.yml` para desarrollo: servicio `app` (usa `.env`, sobrescribe `DATABASE_URL`) y `db` (`postgres:${POSTGRES_VERSION}-alpine` con healthcheck y volumen). El `.env` nunca se copia a la imagen.

## 9. Criterios de aceptación

1. `npm ci && npm run build` sin errores; `docker build` produce una imagen que arranca.
2. Sin `API_KEY` la app no arranca; sin header correcto, 401.
3. `Recibo de pago 123.pdf` coincide con el empleado `00123` de la API; llega un correo HTML con ese PDF adjunto al correo del empleado y se crea un registro `sent`.
4. Tras enviar, el PDF aparece en `<procesados>/<AAAA-MM-DD>/` del SFTP (creada si no existía) con fecha, hora y hash en el nombre, y ya no está en la carpeta origen. Dos archivos con el mismo nombre procesados en distintas fechas (o el mismo día) quedan ambos conservados.
5. Una segunda ejecución no reenvía nada (`skippedAlreadySent` > 0).
6. Empleado inexistente, sin correo, PDF inválido o error SMTP → registro `failed` con `error`, archivo intacto en origen, el resto de archivos se procesa.
7. Archivos con nombre fuera del formato se ignoran y aparecen en `ignoredNames`.
8. Si la API de empleados falla, no se envía ni registra nada y `lastRun.fatalError` lo indica.
9. Con credenciales Graph, los registros enviados pasan a `verified = true` con `verified_at`; sin ellas permanecen `verified = false`.
10. Dos disparos simultáneos de `POST /receipts/process` → el segundo recibe 409.
11. Cambiar en `.env` el patrón de nombre, la tabla, la plantilla, el asunto o la cabecera de autenticación de la API modifica el comportamiento sin tocar el código.

## 10. Riesgos y decisiones abiertas

- Forma real de la API de empleados (paginación, autenticación distinta de Bearer): hoy se asume lo de §5.3.
- SMTP con contraseña puede estar bloqueado en el tenant (`535 5.7.139`); alternativa: Graph `sendMail`, cambiando solo `MailService`.
- Una sola instancia. Para varias réplicas, añadir lock en BD (`pg_advisory_lock`).
- Los recibos contienen datos personales: usar SFTP con llave y huella de host, `DATABASE_SSL` en producción, y no registrar el contenido de los PDFs.

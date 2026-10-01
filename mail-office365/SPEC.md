# SPEC: mail-office365 (envío de recibos de pago desde SFTP)

## 1. Objetivo

Servicio NestJS que:
1. Lee todos los archivos de una carpeta SFTP.
2. Por cada archivo `Recibo de pago <NNNNN>.pdf` extrae `NNNNN` (código de empleado).
3. Consulta una API REST **por ese código** (una llamada por archivo) y toma nombre y correo.
4. Envía un correo por archivo, con cuerpo HTML y el PDF adjunto, usando una cuenta de Office 365 (SMTP).
5. Registra cada envío en PostgreSQL.
6. Mueve el PDF enviado a una carpeta del SFTP para indicar que se procesó, sin pisar envíos anteriores del mismo nombre.
7. Si es posible, verifica que el correo se envió (Elementos enviados vía Microsoft Graph).
8. Al terminar, envía un **correo de reporte** con lo enviado (con nombres de empleados) y lo que falló.
9. Orquesta las ejecuciones con **Temporal** (opcional por configuración); sin Temporal usa un bucle en proceso con la misma lógica.

Fuera de alcance: múltiples carpetas, múltiples adjuntos, plantillas editables por interfaz, interfaz web, réplicas concurrentes del bucle en proceso.

## 2. Stack

Node >= 20, NestJS ^10.4 (`common`, `core`, `platform-express`, `config`, `schedule`), `nodemailer` ^6.9, `pg` ^8, `ssh2-sftp-client` ^11, `@temporalio/*` 1.24.0 (todas la misma versión exacta: `client`, `worker`, `workflow`, `activity`, `common`, y `testing` en desarrollo), `cron` (misma versión exacta que usa `@nestjs/schedule`), TypeScript ^5.5 `strict`. Sin ORM: SQL directo con `pg`. HTTP a la API de empleados y a Graph con `fetch` nativo. Pruebas con `node:test` + `smtp-server` y `mailparser` (desarrollo).

## 3. Estructura

```
mail-office365/
├── Dockerfile, .dockerignore, docker-compose.yml
├── package.json, tsconfig.json, nest-cli.json, .env.example, README.md, SPEC.md
├── scripts/bundle-workflows.js          # empaqueta el workflow en el build (y valida su sandbox)
├── test/                                # node:test
└── src/
    ├── main.ts, worker.ts, app.module.ts
    ├── common/api-key.guard.ts
    ├── db/        db.module.ts, db.service.ts                 (pool + creación de tablas)
    ├── sftp/      sftp.module.ts, sftp.service.ts             (sesión: listar, descargar, archivar)
    ├── employees/ employees.module.ts, employees.service.ts   (consulta por código + caché de ejecución)
    ├── mail/      mail.service.ts, receipt-email.template.ts, graph-verifier.service.ts
    ├── receipts/  receipts.service.ts       (lógica de negocio y bucle en proceso)
    │              receipts.repository.ts, receipts.types.ts, parse-receipt-filename.ts
    │              report.service.ts, report.template.ts
    │              run-launcher.service.ts, receipts.controller.ts, receipts.scheduler.ts
    └── temporal/  workflows/receipts.workflow.ts   (determinista, sin I/O)
                   receipts.activities.ts, activities.types.ts
                   temporal.client.service.ts, temporal.worker.service.ts, *.module.ts
```

## 4. Variables de entorno

**Principio**: ningún valor parametrizable está fijo en el código. Todo se configura en `.env`; `.env.example` lista **todas** las variables con su valor por defecto y es la referencia. El código usa esos mismos defaults solo como respaldo.

Obligatorias (la app falla al arrancar si faltan): `API_KEY`, `DB_USER` y `DB_NAME` (o `DATABASE_URL`), `SFTP_HOST`, `SFTP_USER`, `SFTP_DIR`, `EMPLOYEES_API_URL` (con `{code}`), `SMTP_USER`, `SMTP_PASS` y una credencial SFTP (`SFTP_PASSWORD` o `SFTP_PRIVATE_KEY_PATH`).

**Servidores, IPs, puertos, rutas y credenciales** salen todos de `.env`. Cada servicio tiene host, puerto, usuario y contraseña propios: app (`LISTEN_HOST`, `PORT`, `API_KEY`), SFTP, API de empleados (token o `EMPLOYEES_API_USER/PASSWORD`), SMTP, Graph/Entra ID, PostgreSQL (`DB_HOST/PORT/USER/PASSWORD/NAME`) y Temporal (`TEMPORAL_ADDRESS`, namespace, TLS, API key).

Grupos (detalle y defaults en `.env.example`):
- **HTTP/ejecución**: `LISTEN_HOST`, `PORT`, `API_KEY`, `RECEIPTS_CRON`, `TZ`, `LIST_DEFAULT_LIMIT`, `LIST_MAX_LIMIT`.
- **Archivos**: `RECEIPT_FILENAME_REGEX` (primer grupo de captura = código; se valida al arrancar), `MAX_PDF_MB`.
- **SFTP**: `SFTP_HOST/PORT/USER/PASSWORD/PRIVATE_KEY_PATH/PASSPHRASE/HOST_SHA256/READY_TIMEOUT_MS`, `SFTP_DIR`, `SFTP_PROCESSED_DIR`.
- **Empleados**: `EMPLOYEES_API_URL`, `EMPLOYEES_API_TOKEN/USER/PASSWORD/AUTH_HEADER/AUTH_SCHEME/TIMEOUT_MS/STRIP_ZEROS/NOT_FOUND_STATUS/RESPONSE_PATH/MAX_CONSECUTIVE_ERRORS`, `EMPLOYEES_FIELD_CODE/NAME/EMAIL`.
- **SMTP**: `SMTP_HOST/PORT/SECURE/REQUIRE_TLS/TLS_MIN_VERSION/USER/PASS`, `MAIL_FROM`, `SEND_DELAY_MS`.
- **Contenido**: `MAIL_SUBJECT`, `COMPANY_NAME`, `MAIL_DEFAULT_NAME`, `MAIL_TEMPLATE_HTML_PATH`, `MAIL_TEMPLATE_TEXT_PATH`.
- **Reporte**: `REPORT_TO`, `REPORT_CC`, `REPORT_SUBJECT`, `REPORT_INCLUDE_EMAIL`.
- **Envíos a medias**: `UNCERTAIN_WINDOW_MIN`.
- **Graph**: `AZURE_TENANT_ID/CLIENT_ID/CLIENT_SECRET/AUTH_URL`, `GRAPH_BASE_URL/SCOPE/MAILBOX/SENT_FOLDER/TIMEOUT_MS`, `VERIFY_MAX_ATTEMPTS`, `VERIFY_BATCH_SIZE`.
- **PostgreSQL**: `DB_HOST/PORT/USER/PASSWORD/NAME` o `DATABASE_URL` (prioridad), `DATABASE_SSL`, `DB_TABLE` (validada: minúsculas, dígitos y `_`, máx. 57 caracteres, porque se interpola en el SQL).
- **Temporal**: `TEMPORAL_ENABLED`, `TEMPORAL_ADDRESS/NAMESPACE/TLS/API_KEY/TASK_QUEUE`, `TEMPORAL_WORKER_ENABLED`, `TEMPORAL_MAX_CONCURRENT_ACTIVITIES`, `TEMPORAL_ACTIVITIES_PER_SECOND`, `TEMPORAL_WORKFLOW_ID`, `TEMPORAL_SCHEDULE_ID`, `TEMPORAL_SCHEDULE_CRON`, `WORKFLOW_BATCH_SIZE`, `TEMPORAL_RETRY_ATTEMPTS/INITIAL_SECONDS/MAX_SECONDS`, `TEMPORAL_REPORT_RETRY_ATTEMPTS/INITIAL_SECONDS`.
- **Docker**: `NODE_VERSION`, `POSTGRES_VERSION`, `TEMPORAL_VERSION`, `TEMPORAL_UI_PORT`; el servicio `db` se crea con `DB_USER/DB_PASSWORD/DB_NAME`.

## 5. Componentes

### 5.1 Parseo del nombre
Regex de `RECEIPT_FILENAME_REGEX` (default `^Recibo de pago (\d+)\.pdf$`, insensible a mayúsculas; debe tener un grupo de captura). Devuelve el código como texto (conserva ceros). Los archivos que no cumplan se **ignoran**: no se registran en la BD, se listan en `ignoredNames` y no se mueven.

### 5.2 SFTP
- Una conexión por unidad de trabajo (por ejecución en el bucle en proceso; por activity con Temporal), cerrada siempre.
- Auth por contraseña o llave privada. Con `SFTP_HOST_SHA256` se verifica la huella del servidor y se rechaza cualquier otra.
- `listFiles`: solo archivos regulares, ordenados por nombre. `download(name)`: `Buffer`.
- `archive(name, sha256)`: mueve el archivo a `<SFTP_PROCESSED_DIR>/<AAAA-MM-DD>/<nombre sin .pdf>_<AAAAMMDD-HHmmss>_<hash8>.pdf` (fecha y hora en la zona `TZ`), creando carpetas si no existen; si el destino existiera añade `_2`, `_3`… Así dos envíos del mismo empleado con el **mismo nombre de archivo** (p. ej. dos recibos por mes) nunca se sobrescriben. Devuelve la ruta final, guardada en `processed_path`. Un fallo al mover es una advertencia y **no** invalida el envío.

### 5.3 Empleados (consulta por código)
- **Una llamada a la API por archivo**, con el código extraído del nombre. No se descarga ninguna colección completa.
- `EMPLOYEES_API_URL` lleva el marcador `{code}` (obligatorio, validado al arrancar), reemplazado por el código codificado para URL.
- `GET`, `Accept: application/json`. Autenticación: con `EMPLOYEES_API_TOKEN`, `<AUTH_HEADER>: <AUTH_SCHEME> <token>` (esquema vacío = token tal cual); sin token pero con `EMPLOYEES_API_USER/PASSWORD`, `Authorization: Basic`. Timeout `EMPLOYEES_API_TIMEOUT_MS`.
- El código se envía tal como viene en el archivo; con `EMPLOYEES_API_STRIP_ZEROS=true` se envía sin ceros a la izquierda.
- La respuesta puede ser un objeto o un arreglo; `EMPLOYEES_API_RESPONSE_PATH` (ruta con puntos) indica dónde está. Campos con `EMPLOYEES_FIELD_CODE/NAME/EMAIL`.
- **Regla de seguridad**: si la respuesta trae un código distinto al solicitado (comparando sin ceros a la izquierda) se descarta. Nunca se envía un recibo a un empleado cuyo código no coincide con el del archivo.
- Resultados: estado en `EMPLOYEES_API_NOT_FOUND_STATUS` (default 404) o respuesta vacía → **no encontrado** (`failed`, sin contar intento). Cualquier otro error (red, timeout, 401/403/5xx, JSON inválido) → **API no disponible** (`TransientError` de tipo `api`): se reintenta; no cuenta como intento de envío.
- Tras `EMPLOYEES_API_MAX_CONSECUTIVE_ERRORS` (default 5) fallos de API seguidos se **aborta la ejecución** (`fatalError`).
- Caché en memoria por ejecución (o por activity): el mismo código no se consulta dos veces.
- **Supuestos**: la API acepta el código en la URL y devuelve JSON con código, nombre y correo.

### 5.4 Correo
- Transporte SMTP: STARTTLS en 587, TLS >= 1.2.
- Plantilla con variables `{{nombre}}` y `{{empresa}}` (`COMPANY_NAME`), HTML con estilos en línea más texto plano; reemplazable con `MAIL_TEMPLATE_HTML_PATH` / `MAIL_TEMPLATE_TEXT_PATH`. En HTML los valores se escapan. Si la API no trae nombre se usa `MAIL_DEFAULT_NAME`.
- **Message-ID determinista** por recibo: `<receipt-<código>-<sha256[0..16]>@dominio-de-SMTP_USER>`; el mismo contenido siempre produce el mismo identificador, y por eso se puede buscar después.
- **Clasificación de fallos SMTP** (`classifySmtpError`), base de la idempotencia:
  - `definite_permanent`: el servidor respondió 5xx. No salió; no se reintenta.
  - `definite_transient`: el servidor respondió 4xx, o falló antes de conectar (`ECONNREFUSED`, DNS, timeout de conexión, sin saludo). No salió; es seguro reintentar.
  - `ambiguous`: cualquier otro caso, en particular una conexión que se corta durante el envío del contenido. Nodemailer informa igual (`ECONNECTION`) una conexión que nunca se estableció y una que se cortó a mitad, por eso **ante la duda es ambiguo**. Puede haber salido o no.

### 5.5 Base de datos
Tabla `<DB_TABLE>` (default `receipt_emails`), creada al arrancar con `CREATE TABLE IF NOT EXISTS` y migraciones idempotentes (`ADD COLUMN IF NOT EXISTS`, constraint de estados recreado):

```sql
CREATE TABLE <DB_TABLE> (
  id BIGSERIAL PRIMARY KEY,
  file_name TEXT NOT NULL, file_sha256 TEXT NOT NULL,
  employee_code TEXT, employee_name TEXT, to_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','uncertain')),
  attempts INTEGER NOT NULL DEFAULT 0,        -- intentos de envío SMTP
  message_id TEXT, sent_at TIMESTAMPTZ,
  verified BOOLEAN NOT NULL DEFAULT FALSE, verified_at TIMESTAMPTZ,
  verify_attempts INTEGER NOT NULL DEFAULT 0, verification_note TEXT,
  error TEXT, processed_path TEXT,
  run_id TEXT,                                -- ejecución que lo procesó (para el reporte)
  attempt_started_at TIMESTAMPTZ,             -- cuándo empezó el último intento de envío
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_name, file_sha256)
);
-- índices: (status, verified), (employee_code), (run_id)

CREATE TABLE <DB_TABLE>_runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','aborted')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,   -- contadores y fatalError
  report_sent_at TIMESTAMPTZ, report_message_id TEXT, report_error TEXT
);
```

Estados: `pending` (creado) · `sending` (se anotó antes de enviar; si queda así tras un fallo, no se sabe si salió) · `sent` · `failed` (falló, se reintenta en la siguiente ejecución) · `uncertain` (no se sabe si salió; **requiere revisión**, nunca se reenvía solo).

La identidad de un envío es **nombre + SHA-256 del contenido**: el mismo archivo no se reenvía; el mismo nombre con otro contenido (el segundo recibo del mes) es un envío nuevo. Limitación: dos recibos del mismo empleado idénticos byte a byte se tratarían como duplicado (no se envía, solo se archiva).

### 5.6 Idempotencia y envíos a medias
El envío de un correo no es idempotente y Temporal (como cualquier reintento) ofrece "al menos una vez". Para no duplicar un recibo de nómina:

1. Antes de enviar se escribe `status='sending'`, el `message_id` determinista y `attempt_started_at`.
2. Si el envío falla con certeza de que no salió (`definite_*`) → `failed` con intento contado, y es seguro reintentar.
3. Si el resultado es `ambiguous` → el estado queda `sending` y se lanza un `TransientError` ambiguo.
4. Al retomar un registro en `sending` o `uncertain` (siguiente intento o siguiente ejecución) se **busca el Message-ID en Elementos enviados** (Graph):
   - aparece → `sent` recuperado, `verified=true` («Recuperado: ya estaba en Elementos enviados»), **sin reenviar**;
   - no aparece y han pasado >= `UNCERTAIN_WINDOW_MIN` (default 10) → se reenvía con el **mismo** Message-ID;
   - no aparece y es reciente, o Graph está caído o no configurado → `uncertain`, **no se reenvía**; aparece en el reporte para revisión humana.
5. Resolución manual: `POST /receipts/:id/resolve` con `{"action":"resend"}` (pasa a `failed` y se reenvía en la siguiente ejecución) o `{"action":"mark_sent"}`. Solo desde `uncertain`/`sending`.

Entrega exactamente-una-vez no es alcanzable con SMTP; esto elige, ante la duda, un posible "no enviado" visible antes que un duplicado silencioso.

### 5.7 Reporte final
- Al terminar cada ejecución (también si se abortó) se envía **un** correo a `REPORT_TO` (lista separada por coma; vacío = sin reporte), con copia a `REPORT_CC`. Asunto: `<REPORT_SUBJECT> <fecha>: N enviados[, M con problemas]`.
- Contenido (HTML + texto): conteos; tabla de **enviados** (nombre del empleado, código, correo —omitible con `REPORT_INCLUDE_EMAIL=false`—, archivo, verificado); **no enviados** con el motivo (incluye archivos que fallaron sin dejar registro); **por revisar** (`uncertain`/`sending`/`pending`, con su id y cómo resolverlos); archivos ignorados; aviso si la ejecución se detuvo (`fatalError`). Los datos se escapan en HTML. Contiene datos personales: restringir los destinatarios.
- Los datos salen de PostgreSQL (`run_id`), no del historial de Temporal. Los ya enviados antes (omitidos) solo cuentan, no se listan.
- **Una sola vez por ejecución**: se marca `report_sent_at`; Message-ID determinista `<report-<runId>@dominio>`; si un intento anterior falló, antes de reenviar se busca ese Message-ID en Elementos enviados.
- **Nunca invalida los envíos**: si falla, se registra `report_error`, el resumen lo indica (`report: "error: …"`) y la ejecución termina igual.

### 5.8 Verificación (Microsoft Graph, opcional)
Activa solo con `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` y `AZURE_CLIENT_SECRET`. Token client credentials cacheado; consulta `GET /users/{buzón}/mailFolders/{GRAPH_SENT_FOLDER}/messages?$filter=internetMessageId eq '<id>'`; permiso de aplicación `Mail.Read` (limitar al buzón con Application Access Policy). Al final de cada ejecución se revisan los `sent` no verificados con `verify_attempts < VERIFY_MAX_ATTEMPTS`. Confirma que Exchange aceptó y guardó el mensaje; no que el destinatario lo recibiera o leyera. Es también la base de la recuperación de §5.6. **Supuesto a validar en el tenant**: que Exchange Online conserve el Message-ID enviado por SMTP.

## 6. Orquestación

La lógica de negocio vive en `ReceiptsService` (`listFiles`, `processFile`, `verifyPending`, `finishRun`). Dos orquestadores la usan, con el mismo comportamiento.

### 6.1 Sin Temporal (`TEMPORAL_ENABLED=false`)
`ReceiptsService.run()` recorre los archivos en serie en el proceso, con `SEND_DELAY_MS` entre envíos reales (Office 365 limita ~30 correos/min por buzón), aborta tras N fallos de API seguidos, verifica, guarda la ejecución y envía el reporte. Programación con `RECEIPTS_CRON` (6 campos, con segundos). Una sola instancia (bloqueo en memoria).

### 6.2 Con Temporal (`TEMPORAL_ENABLED=true`)

**Decisión: un workflow por ejecución, con una *activity* por archivo. No hace falta un workflow por envío.** Motivos: la visibilidad por envío ya está en PostgreSQL; un child workflow por correo añade ~10 eventos de historial, más carga en el servidor y complica el límite de 30 correos/min; solo valdría la pena con miles de envíos concurrentes o aprobaciones humanas por envío. Con ~3000 archivos el historial queda en ~12–15 mil eventos (límite de Temporal: 51 200), y de todos modos se acota con `continueAsNew`.

**Workflow `processReceiptsRun(input)`** (`src/temporal/workflows/`, determinista; importa solo `@temporalio/workflow` y tipos puros). El `input` lleva la configuración que el workflow no puede leer del entorno. Pasos:
1. (solo en la primera pasada) `startRun`, `listFiles` → cola de archivos. Solo viajan nombres y tamaños, **nunca PDFs**.
2. Por cada archivo, en serie: pausa durable `sleep(SEND_DELAY_MS)` si el anterior fue un envío real; `processReceipt(runId, file)`; acumula contadores.
3. Cada `WORKFLOW_BATCH_SIZE` archivos (default 500) hace `continueAsNew` con lo que falta y los contadores (listas acotadas a 200 nombres; el detalle completo vive en PostgreSQL). `runId` se conserva.
4. Tras `EMPLOYEES_API_MAX_CONSECUTIVE_ERRORS` fallos de API seguidos aborta el bucle (sin abandonar el cierre).
5. Cierre: `verifyPending` (si falla, no aborta) → `saveRun` → `sendReport` (si falla, no invalida nada) → si hubo aborto, el workflow termina como fallido con `RunAborted`.

**Activities** (`receipts.activities.ts`, todo el I/O): `startRun`, `listFiles`, `processReceipt`, `markUncertain`, `verifyPending`, `saveRun`, `sendReport`. Los `TransientError` se traducen a `ApplicationFailure` con tipo `Transient:api|sftp|smtp|smtp:ambiguous` y detalles `{rowId, file}`; el workflow decide con eso. Los resultados definitivos (no encontrado, PDF inválido, 5xx) se devuelven como valor, no como excepción, para no reintentarlos.

**Reintentos** (configurables, `TEMPORAL_RETRY_*`): `processReceipt` y las demás, 3 intentos, espera inicial 5 s, ×2, máximo 60 s; timeouts `StartToClose`: 2 min (rápidas), 3 min (por archivo), 10 min (verificación). `sendReport`: 5 intentos, espera inicial 30 s. Tras agotar reintentos con resultado ambiguo, el workflow marca el registro `uncertain` y sigue.

**Ritmo**: el control real es la pausa durable del workflow secuencial (≤ 30/min por construcción y sobrevive a reinicios). `TEMPORAL_ACTIVITIES_PER_SECOND` (`maxTaskQueueActivitiesPerSecond`) es una red de seguridad opcional por cola, no un límite por buzón.

**Solapamiento**: `TEMPORAL_WORKFLOW_ID` fijo + política de conflicto por defecto: lanzar otra ejecución mientras corre una devuelve 409. El Schedule usa `overlap: SKIP`.

**Programación**: `TEMPORAL_SCHEDULE_CRON` (cron de 5 campos, zona `TZ`) crea o actualiza el Schedule `TEMPORAL_SCHEDULE_ID` en cada arranque, así toma cambios de `.env`. Con Temporal activo se ignora `RECEIPTS_CRON`.

**Worker**: `TemporalWorkerService` (en el mismo proceso si `TEMPORAL_WORKER_ENABLED=true`) o proceso separado `npm run start:worker` (`src/worker.ts`, sin HTTP). Cola `TEMPORAL_TASK_QUEUE`, `maxConcurrentActivityTaskExecutions=1`. El workflow se empaqueta en el build (`dist/workflow-bundle.js`); si falta, el worker lo empaqueta al arrancar.

**Costo operativo** (a tener presente): requiere un servidor Temporal con su persistencia (propio o Temporal Cloud), gestión de namespaces y retención, y versionado de workflows (`patched`/determinismo) cuando se cambie la lógica con ejecuciones en vuelo. Con dos ejecuciones al mes la ventana de riesgo es corta. Si no hay un servidor Temporal ya operado, el modo sin Temporal cubre el mismo comportamiento funcional.

### 6.3 Algoritmo de un archivo (`processFile`)
1. Parsear el nombre; si excede `MAX_PDF_MB` → fallo sin registro.
2. Descargar (error → `TransientError` `sftp`). Calcular SHA-256; `findOrCreate` del registro.
3. Si ya está `sent` → archivar y devolver `skipped`.
4. Asociar el registro a la ejecución (`run_id`). Si no empieza con `%PDF-` → `failed` registrado.
5. Si estaba `sending`/`uncertain` → resolver según §5.6.
6. Consultar la API de empleados (§5.3): no encontrado o sin correo válido → `failed`; API caída → `TransientError` `api`.
7. `markSending` → enviar → `markSent` → archivar (§5.2). Errores según §5.4/§5.6.

## 7. API HTTP

Todas exigen el header `x-api-key` igual a `API_KEY` (comparación en tiempo constante; 401 si no coincide).

| Método | Ruta | Respuesta |
|---|---|---|
| POST | `/receipts/process` | 202 `{started, mode, workflowId?}`; 409 si ya hay una ejecución |
| GET | `/receipts/status` | `{mode, running, lastRun}`; `lastRun` sale de `<DB_TABLE>_runs` en ambos modos |
| GET | `/receipts?status=&verified=&runId=&limit=` | Registros (sin el hash). `status`: `pending`, `sending`, `sent`, `failed`, `uncertain` |
| POST | `/receipts/:id/resolve` | `{"action":"resend"\|"mark_sent"}`; 200, 400 si la acción no es válida, 404 si no está en `uncertain`/`sending` |

## 8. Contenedor

- `Dockerfile` multi-etapa sobre `node:${NODE_VERSION}-alpine`: build (`npm ci`, `npm run build` —incluye el empaquetado del workflow—, `npm prune --omit=dev`) y etapa final con `node_modules` de producción y `dist`, usuario `node`, `HEALTHCHECK` contra `/receipts/status`, `CMD ["node","dist/main"]`. El worker separado usa la misma imagen con `CMD ["node","dist/worker"]`.
- `docker-compose.yml`: `app` y `db` (`postgres:${POSTGRES_VERSION}-alpine`, con `DB_USER/DB_PASSWORD/DB_NAME`); el perfil `temporal` añade un servidor Temporal de **desarrollo** (`docker compose --profile temporal up`, con `TEMPORAL_ENABLED=true` y `TEMPORAL_ADDRESS=temporal:7233` en `.env`). En producción usar un cluster o Temporal Cloud.
- El `.env` nunca se copia a la imagen.

## 9. Pruebas (`npm test`)

`npm test` compila y corre `node --test test/*.test.js`. Las que requieren servicios se omiten si no están:
- **Siempre**: nombre de archivo y regex, plantilla, archivado con colisiones, `DB_TABLE`, BD por partes, API de empleados (404, errores, otro código, arreglo, Basic), SMTP real con STARTTLS (HTML, adjunto idéntico, Message-ID, **clasificación de fallos incluyendo corte a mitad del envío**, varios destinatarios), Graph simulado.
- `TEST_DATABASE_URL`: flujo completo con PostgreSQL (reporte, idempotencia, recuperación, `uncertain`, resolución manual, aborto por API, reporte fallido).
- `TEMPORAL_CLI_PATH` (binario del CLI de Temporal): comportamiento del workflow contra un servidor real (continueAsNew, pausa, reintentos, aborto, incierto, reporte/verificación fallidos, solapamiento, **replay del historial**) y, con la BD, punta a punta (cliente real + worker + activities reales + Schedule).

## 10. Criterios de aceptación

1. `npm ci && npm test` pasa; `docker build` produce una imagen que arranca.
2. Sin `API_KEY` la app no arranca; sin header correcto, 401.
3. `Recibo de pago 00123.pdf` → consulta `GET <API>/…/00123`; llega un correo HTML con ese PDF adjunto al correo del empleado y se crea un registro `sent`.
4. Tras enviar, el PDF aparece en `<procesados>/<AAAA-MM-DD>/` con fecha, hora y hash en el nombre y ya no está en origen. Dos archivos con el mismo nombre procesados en distintas fechas (o el mismo día) quedan ambos conservados.
5. Una segunda ejecución no reenvía nada.
6. Empleado inexistente, sin correo, PDF inválido o error SMTP → `failed` con motivo; archivo intacto en origen; el resto se procesa.
7. Archivos con nombre fuera del formato se ignoran y aparecen en `ignoredNames`.
8. Si la API de empleados falla N veces seguidas, la ejecución se aborta, los registros afectados quedan `failed` sin contar intentos y el reporte avisa. Una respuesta con código distinto al pedido nunca genera un envío.
9. Con credenciales Graph, los enviados pasan a `verified = true`; sin ellas permanecen `verified = false`.
10. Dos disparos simultáneos de `POST /receipts/process` → el segundo recibe 409 (en ambos modos).
11. **Al terminar cada ejecución llega un correo de reporte** a `REPORT_TO` con los nombres de los empleados enviados, los no enviados con su motivo y los pendientes de revisión; se envía una sola vez por ejecución y, si falla, no afecta a los envíos.
12. **Un envío cortado a mitad no se duplica**: queda `uncertain`, se recupera si aparece en Elementos enviados, se reenvía con el mismo Message-ID solo pasada la ventana sin rastro, y nunca se reenvía solo si no se puede comprobar.
13. Con `TEMPORAL_ENABLED=true`, la ejecución corre como workflow: sobrevive al reinicio del worker, reintenta con backoff, continúa con `continueAsNew` y el Schedule reemplaza al cron.
14. Cambiar en `.env` hosts, IPs, puertos, usuarios, contraseñas, rutas, patrón de nombre, tabla, plantilla, destinatarios del reporte o la política de reintentos modifica el comportamiento sin tocar el código.

## 11. Riesgos y decisiones abiertas

- Forma real de la API de empleados (marcador `{code}`, JSON con código/nombre/correo): hoy se asume §5.3. Una llamada por archivo, en serie: con muchos recibos la duración depende de su latencia.
- SMTP con contraseña puede estar bloqueado en el tenant (`535 5.7.139`); alternativa: Graph `sendMail`, cambiando solo `MailService`.
- La recuperación de envíos a medias depende de Graph y de que Exchange conserve el Message-ID; sin eso, lo incierto exige revisión manual.
- Temporal añade infraestructura y versionado de workflows (§6.2). El bucle en proceso es una sola instancia.
- Los recibos y el reporte contienen datos personales: SFTP con llave y huella de host, `DATABASE_SSL=true` en producción, destinatarios del reporte restringidos.

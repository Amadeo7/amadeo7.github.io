# mail-office365

Servicio NestJS que lee recibos de pago en PDF desde una carpeta SFTP y envía cada uno por correo (Office 365) al empleado correspondiente. Registra cada envío en PostgreSQL y, si se configura, verifica que el correo quedó en "Elementos enviados".

Especificación completa: [`SPEC.md`](SPEC.md).

## Flujo

1. Lee todos los archivos de `SFTP_DIR`.
2. Del nombre `Recibo de pago <NNNNN>.pdf` extrae el código de empleado.
3. Consulta la API de empleados **por ese código** (una llamada por archivo) para obtener nombre y correo.
4. Envía un correo HTML con el PDF adjunto.
5. Guarda el resultado en la tabla `receipt_emails`.
6. Mueve el PDF a `procesados/<AAAA-MM-DD>/` en el SFTP, con fecha, hora y hash en el nombre.
7. Verifica en Elementos enviados (Microsoft Graph) y marca `verified`.
8. Envía un **correo de reporte** a `REPORT_TO` con lo enviado (con nombres de empleados), lo que falló y lo que requiere revisión.

## Ejecutar

```bash
cp .env.example .env     # completa los valores
docker compose up --build
```

Sin Docker: `npm install && npm run start:dev` (requiere PostgreSQL; configura `DB_HOST/PORT/USER/PASSWORD/NAME`).

## Pruebas

```bash
npm test                                   # unitarias, API de empleados, SMTP con STARTTLS y Graph simulados
TEST_DATABASE_URL=postgres://u:p@localhost:5432/recibos_test npm test   # además, el flujo completo con PostgreSQL
TEMPORAL_CLI_PATH=/ruta/a/temporal TEST_DATABASE_URL=... npm test       # además, el workflow contra un servidor Temporal real
```

## Configuración

Todo es configurable en `.env`: servidores, IPs, puertos, usuarios, contraseñas y rutas de cada servicio (SFTP, API de empleados, SMTP, Graph, PostgreSQL y la propia app con `LISTEN_HOST`/`PORT`).  `.env.example` lista cada variable con su valor por defecto (patrón del nombre de archivo, carpetas SFTP, campos de la API, plantilla y asunto del correo, URLs de Graph, nombre de la tabla, etc.).

## Endpoints (header `x-api-key: <API_KEY>`)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/receipts/process` | Inicia el proceso en segundo plano (202). 409 si ya hay uno corriendo |
| GET | `/receipts/status` | Modo (`process` o `temporal`), si corre, y el resumen de la última ejecución |
| GET | `/receipts?status=&verified=&runId=&limit=` | Consulta la tabla de envíos |
| POST | `/receipts/:id/resolve` | Resuelve un envío incierto: `{"action":"resend"}` o `{"action":"mark_sent"}` |

Sin Temporal también puede correr solo con `RECEIPTS_CRON` (6 campos, con segundos), p. ej. `0 0 8 1,16 * *`. Con Temporal se programa con `TEMPORAL_SCHEDULE_CRON` (5 campos).

## Temporal (opcional)

Con `TEMPORAL_ENABLED=true` cada ejecución es un workflow de Temporal: si el worker se cae a medias, retoma donde iba; los fallos transitorios se reintentan con backoff; y un Schedule reemplaza al cron.

- **Un workflow por ejecución, no uno por correo.** Cada archivo es una *activity*. Un workflow por envío solo añadiría carga y complejidad: el detalle de cada envío ya está en PostgreSQL.
- Cada `WORKFLOW_BATCH_SIZE` archivos el workflow continúa como uno nuevo para mantener acotado su historial.
- El ritmo (límite de ~30 correos/min de Office 365) lo marca una pausa durable entre envíos (`SEND_DELAY_MS`).
- El worker corre en el mismo proceso o aparte (`npm run start:worker`, con `TEMPORAL_WORKER_ENABLED=false` en la API).
- Servidor de desarrollo: `docker compose --profile temporal up` (con `TEMPORAL_ADDRESS=temporal:7233`). En producción usa un cluster propio o Temporal Cloud.
- **Costo**: hay que operar un servidor Temporal con su persistencia y versionar los workflows al cambiarlos. Si no ya tienes uno, el modo sin Temporal da el mismo comportamiento funcional.

## Comportamiento a tener en cuenta

- **Dos envíos al mes con el mismo nombre de archivo**: cada uno se envía como envío distinto (la clave incluye el hash del contenido) y se archiva en una subcarpeta por fecha con nombre único, así ninguno se pierde ni se sobrescribe. La ruta final queda en `processed_path`.
- **Sin duplicados**: un archivo ya enviado nunca se reenvía.
- **Si el proceso se cae a mitad de un envío** no se sabe si el correo salió. Antes de reenviar se busca su Message-ID (determinista) en Elementos enviados: si aparece se recupera sin reenviar; si no aparece y pasaron `UNCERTAIN_WINDOW_MIN` minutos se reenvía; si no se puede comprobar (Graph caído o no configurado) queda `uncertain` y **nunca se reenvía solo**. Aparece en el reporte y se resuelve con `POST /receipts/:id/resolve`.
- **Reporte final**: un correo por ejecución a `REPORT_TO` (vacío = sin reporte). Se envía una sola vez y, si falla, no afecta a los envíos. Contiene datos personales: restringe los destinatarios.
- **API de empleados**: `EMPLOYEES_API_URL` debe llevar `{code}` (p. ej. `https://api.ejemplo.com/empleados/{code}`). Una respuesta con un código distinto al pedido se descarta, para no enviar un recibo a otra persona. Si la API falla 5 veces seguidas (configurable) se aborta la ejecución.
- **Fallos**: empleado inexistente, sin correo, PDF inválido, API caída o error SMTP dejan el archivo en la carpeta y el registro en `failed`; se reintentan en la siguiente ejecución.
- **Límite de Office 365**: ~30 correos por minuto por buzón; `SEND_DELAY_MS` (2500 ms por defecto) espacia los envíos. El reporte cuenta contra ese límite.
- **Verificación**: confirma que el mensaje aparece en Elementos enviados del remitente, no que el destinatario lo recibió ni lo leyó. Requiere un registro de aplicación en Entra ID con permiso de aplicación `Mail.Read` (restringido al buzón con una Application Access Policy). Sin esas variables, los correos quedan `sent` con `verified = false`.
- **SMTP con contraseña**: si el tenant lo bloquea (error `535 5.7.139`), hay que cambiar `MailService` a Microsoft Graph `sendMail`.
- **Una sola instancia** del bucle en proceso. Con Temporal, el Workflow ID fijo impide dos ejecuciones a la vez.

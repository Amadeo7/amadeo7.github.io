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
```

## Configuración

Todo es configurable en `.env`: servidores, IPs, puertos, usuarios, contraseñas y rutas de cada servicio (SFTP, API de empleados, SMTP, Graph, PostgreSQL y la propia app con `LISTEN_HOST`/`PORT`).  `.env.example` lista cada variable con su valor por defecto (patrón del nombre de archivo, carpetas SFTP, campos de la API, plantilla y asunto del correo, URLs de Graph, nombre de la tabla, etc.).

## Endpoints (header `x-api-key: <API_KEY>`)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/receipts/process` | Inicia el proceso en segundo plano (202). 409 si ya hay uno corriendo |
| GET | `/receipts/status` | Estado y resumen de la última ejecución |
| GET | `/receipts?status=&verified=&limit=` | Consulta la tabla de envíos |

También puede correr solo con `RECEIPTS_CRON` (6 campos, con segundos), por ejemplo `0 0 8 * * 1-5`.

## Comportamiento a tener en cuenta

- **Dos envíos al mes con el mismo nombre de archivo**: cada uno se envía como envío distinto (la clave incluye el hash del contenido) y se archiva en una subcarpeta por fecha con nombre único, así ninguno se pierde ni se sobrescribe. La ruta final queda en `processed_path`.
- **Sin duplicados**: la clave de un envío es nombre de archivo + hash del contenido. Un archivo ya enviado nunca se reenvía; uno con el mismo nombre pero otro contenido se trata como nuevo.
- **API de empleados**: `EMPLOYEES_API_URL` debe llevar `{code}` (p. ej. `https://api.ejemplo.com/empleados/{code}`). Una respuesta con un código distinto al pedido se descarta, para no enviar un recibo a otra persona. Si la API falla 5 veces seguidas (configurable) se aborta la ejecución.
- **Fallos**: empleado inexistente, sin correo, PDF inválido, API caída o error SMTP dejan el archivo en la carpeta y el registro en `failed`; se reintentan en la siguiente ejecución.
- **Límite de Office 365**: ~30 correos por minuto por buzón; `SEND_DELAY_MS` (2500 ms por defecto) espacia los envíos.
- **Verificación**: confirma que el mensaje aparece en Elementos enviados del remitente. No confirma que el destinatario lo recibió ni lo leyó. Requiere un registro de aplicación en Entra ID con permiso de aplicación `Mail.Read` (restringido al buzón con una Application Access Policy). Sin esas variables, los correos quedan `sent` con `verified = false`.
- **SMTP con contraseña**: si el tenant lo bloquea (error `535 5.7.139`), hay que cambiar `MailService` a Microsoft Graph `sendMail`.
- **Una sola instancia**: el control de ejecución simultánea es en memoria. No escales a varias réplicas sin agregar un lock en la base de datos.

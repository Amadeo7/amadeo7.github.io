// Punta a punta: servidor Temporal real + worker con las activities reales + PostgreSQL real.
// Se omite sin TEMPORAL_CLI_PATH y TEST_DATABASE_URL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { config, pdf } = require('./helpers');

const CLI = process.env.TEMPORAL_CLI_PATH;
const DB_URL = process.env.TEST_DATABASE_URL;
const opts = { skip: CLI && DB_URL ? false : 'define TEMPORAL_CLI_PATH y TEST_DATABASE_URL' };

let env, worker, workerDone, api, db, repo, client, files, sent, reports, cfg;

before(async () => {
  if (opts.skip) return;
  const { TestWorkflowEnvironment } = require('@temporalio/testing');
  const { Worker } = require('@temporalio/worker');
  const { DbService } = require('../dist/db/db.service');
  const { EmployeesService } = require('../dist/employees/employees.service');
  const { ReceiptsRepository } = require('../dist/receipts/receipts.repository');
  const { ReceiptsService } = require('../dist/receipts/receipts.service');
  const { ReportService } = require('../dist/receipts/report.service');
  const { ReceiptEmailTemplate } = require('../dist/mail/receipt-email.template');
  const { createActivities } = require('../dist/temporal/receipts.activities');
  const { TemporalClientService } = require('../dist/temporal/temporal.client.service');

  env = await TestWorkflowEnvironment.createLocal({ server: { executable: { type: 'existing-path', path: CLI } } });
  const DIR = { '00123': ['Ana Pérez', 'ana@x.com'], '456': ['Luis Gómez', 'luis@x.com'] };
  api = http.createServer((req, res) => {
    const code = decodeURIComponent(req.url.split('/empleados/')[1]);
    res.setHeader('content-type', 'application/json');
    if (!DIR[code]) { res.statusCode = 404; return res.end('{}'); }
    res.end(JSON.stringify({ codigo: code, nombre: DIR[code][0], correo: DIR[code][1] }));
  }).listen(0);
  await new Promise((r) => api.once('listening', r));

  cfg = config({
    DATABASE_URL: DB_URL, DB_TABLE: 'recibos_e2e', EMPLOYEES_API_URL: `http://127.0.0.1:${api.address().port}/empleados/{code}`,
    EMPLOYEES_API_RESPONSE_PATH: undefined, EMPLOYEES_API_AUTH_HEADER: undefined, EMPLOYEES_API_TOKEN: undefined,
    SEND_DELAY_MS: 0, COMPANY_NAME: 'Empresa SA', REPORT_TO: 'rh@empresa.com',
    TEMPORAL_ENABLED: 'true', TEMPORAL_ADDRESS: env.address ?? env.connection?.options?.address ?? '127.0.0.1:7233',
    TEMPORAL_TASK_QUEUE: 'e2e-queue', TEMPORAL_WORKFLOW_ID: 'e2e-run', TEMPORAL_SCHEDULE_ID: 'e2e-schedule', TEMPORAL_SCHEDULE_CRON: undefined,
    TEMPORAL_RETRY_INITIAL_SECONDS: 1, TEMPORAL_RETRY_MAX_SECONDS: 2, TZ: 'America/Mexico_City',
  });
  db = new DbService(cfg); await db.onModuleInit(); await db.pool.query('TRUNCATE recibos_e2e, recibos_e2e_runs');
  repo = new ReceiptsRepository(db);
  sent = []; reports = [];
  const mail = { domain: 'empresa.com', send: async (m) => { (m.attachment ? sent : reports).push(m); return { messageId: m.messageId, rejected: [] }; } };
  const verifier = { enabled: false };
  const sftp = { open: async () => ({
    listFiles: async () => Object.entries(files).map(([name, b]) => ({ name, size: b.length })),
    download: async (n) => files[n], archive: async (n, sha) => `/p/${n}_${sha.slice(0, 8)}`, close: async () => {},
  }) };
  const report = new ReportService(cfg, mail, verifier, repo);
  const svc = new ReceiptsService(cfg, sftp, new EmployeesService(cfg), mail, verifier, repo, new ReceiptEmailTemplate(cfg), report);
  worker = await Worker.create({ connection: env.nativeConnection, taskQueue: 'e2e-queue', workflowsPath: require.resolve('../dist/temporal/workflows'), activities: createActivities(svc, repo, report) });
  workerDone = worker.run();
  client = new TemporalClientService(cfg);
});
after(async () => {
  if (opts.skip) return;
  worker.shutdown(); await workerDone; await client.onModuleDestroy(); await db.onModuleDestroy(); api.close(); await env.teardown();
});

test('POST /receipts/process con Temporal: ejecuta, registra, reporta y el Workflow ID evita solapes', opts, async () => {
  files = { 'Recibo de pago 00123.pdf': pdf('a'), 'Recibo de pago 456.pdf': pdf('b'), 'Recibo de pago 999.pdf': pdf('c'), 'notas.txt': Buffer.from('x') };
  const { workflowId } = await client.startRun();
  assert.equal(workflowId, 'e2e-run');
  await assert.rejects(client.startRun(), /Ya hay un proceso en ejecución/);   // 409 mientras corre
  const result = await env.client.workflow.getHandle(workflowId).result();

  assert.equal(result.sent, 2); assert.equal(result.failed, 1); assert.deepEqual(result.ignoredNames, ['notas.txt']);
  assert.deepEqual(sent.map((m) => m.to), ['ana@x.com', 'luis@x.com']);
  const { rows } = await db.pool.query('select employee_name, status, run_id, processed_path from recibos_e2e order by id');
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'sent', 'failed']);
  assert.ok(rows.every((r) => r.run_id === result.runId));
  assert.match(rows[0].processed_path, /^\/p\/Recibo de pago 00123\.pdf_/);

  assert.equal(reports.length, 1);
  assert.ok(reports[0].html.includes('Ana Pérez') && reports[0].html.includes('Luis Gómez'));
  assert.equal(result.report, 'enviado');
  assert.equal((await repo.getRun(result.runId)).status, 'completed');
  assert.equal(await client.isRunning(), false);
});

test('se puede lanzar otra ejecución al terminar la anterior y no reenvía lo ya enviado', opts, async () => {
  const before = sent.length;
  const { workflowId } = await client.startRun();
  const result = await env.client.workflow.getHandle(workflowId).result();
  assert.equal(sent.length, before); assert.equal(result.skippedAlreadySent, 2);
});

test('Schedule: se crea desde el .env, se actualiza en el siguiente arranque y lanza el workflow con la configuración', opts, async () => {
  const { ScheduleOverlapPolicy } = require('@temporalio/client');
  const { TemporalClientService } = require('../dist/temporal/temporal.client.service');
  const mk = (cron) => new TemporalClientService(config({ TEMPORAL_SCHEDULE_CRON: cron }));

  const a = mk('0 8 1,16 * *'); await a.onApplicationBootstrap();
  const handle = env.client.schedule.getHandle('e2e-schedule');
  let d = await handle.describe();
  // El servidor devuelve el cron ya convertido a calendarios: día 1 y 16 del mes, 8:00
  const cal = d.spec.calendars[0];
  assert.deepEqual([cal.dayOfMonth, cal.hour, cal.minute].map((r) => r.map((x) => x.start)), [[1, 16], [8], [0]]);
  assert.equal(d.spec.timezone ?? d.spec.timezoneName, 'America/Mexico_City');
  assert.equal(d.policies.overlap, ScheduleOverlapPolicy.SKIP);
  assert.equal(d.action.workflowType, 'processReceiptsRun'); assert.equal(d.action.taskQueue, 'e2e-queue');
  assert.equal(d.action.args[0].config.batchSize, 500);

  const b = mk('30 7 * * 1-5'); await b.onApplicationBootstrap();        // segundo arranque: actualiza, no falla
  d = await handle.describe();
  assert.deepEqual([d.spec.calendars[0].hour, d.spec.calendars[0].minute].map((r) => r.map((x) => x.start)), [[7], [30]]);

  const before = sent.length;
  await handle.trigger(); await new Promise((r) => setTimeout(r, 2500));   // dispara ahora mismo
  d = await handle.describe();
  assert.equal(d.info.recentActions.length >= 1, true, 'el Schedule lanzó el workflow');
  const startedId = d.info.recentActions[0].action.workflow.workflowId;
  assert.match(startedId, /^e2e-run-scheduled/);
  await env.client.workflow.getHandle(startedId).result();
  assert.equal(sent.length, before, 'ya estaba todo enviado');
  await handle.delete(); await a.onModuleDestroy(); await b.onModuleDestroy();
});

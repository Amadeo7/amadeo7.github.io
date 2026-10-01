// Flujo completo con PostgreSQL real. Se omite si no hay TEST_DATABASE_URL.
//   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/recibos_test npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { config, pdf } = require('./helpers');
const { DbService } = require('../dist/db/db.service');
const { EmployeesService } = require('../dist/employees/employees.service');
const { ReceiptsRepository } = require('../dist/receipts/receipts.repository');
const { ReceiptsService } = require('../dist/receipts/receipts.service');
const { ReportService } = require('../dist/receipts/report.service');
const { ReceiptEmailTemplate } = require('../dist/mail/receipt-email.template');
const { stableMessageId } = require('../dist/mail/mail.service');

const DB_URL = process.env.TEST_DATABASE_URL;
const opts = { skip: DB_URL ? false : 'define TEST_DATABASE_URL para correr el flujo con PostgreSQL' };

let api, apiDown = false, calls = [], cfg, db, repo, files, sent, reports, sentItems, svc, mailBehavior, graphDown;

before(async () => {
  if (!DB_URL) return;
  const DIR = { '00123': ['Ana Pérez', 'ana@x.com'], '456': ['Luis Gómez', 'luis@x.com'], '789': ['Sin Correo', ''], '321': ['Rebota', 'rebota@x.com'] };
  api = http.createServer((req, res) => {
    calls.push(req.url);
    const code = decodeURIComponent(req.url.split('/empleados/')[1]);
    if (apiDown) { res.statusCode = 503; return res.end('x'); }
    res.setHeader('content-type', 'application/json');
    if (code === '555') return res.end(JSON.stringify({ data: { codigo: '999', nombre: 'OTRA PERSONA', correo: 'otra@x.com' } }));
    if (!DIR[code]) { res.statusCode = 404; return res.end('{}'); }
    res.end(JSON.stringify({ data: { codigo: code, nombre: DIR[code][0], correo: DIR[code][1] } }));
  }).listen(0);
  await new Promise((r) => api.once('listening', r));
  cfg = config({
    DATABASE_URL: DB_URL, DB_TABLE: 'recibos_test', EMPLOYEES_API_URL: `http://127.0.0.1:${api.address().port}/empleados/{code}`,
    EMPLOYEES_API_RESPONSE_PATH: 'data', EMPLOYEES_API_AUTH_HEADER: undefined, EMPLOYEES_API_TOKEN: undefined,
    EMPLOYEES_API_MAX_CONSECUTIVE_ERRORS: 3, SEND_DELAY_MS: 0, COMPANY_NAME: 'Empresa SA', MAIL_SUBJECT: 'Tu recibo de pago',
    REPORT_TO: 'rh@empresa.com, nomina@empresa.com', REPORT_CC: 'auditoria@empresa.com', UNCERTAIN_WINDOW_MIN: 10,
  });
  db = new DbService(cfg); await db.onModuleInit();
  await db.pool.query('TRUNCATE recibos_test, recibos_test_runs');
  repo = new ReceiptsRepository(db);
  const sftp = { open: async () => ({
    listFiles: async () => Object.entries(files).map(([name, b]) => ({ name, size: b.length })),
    download: async (n) => files[n],
    archive: async (n, sha) => `/p/2026-10-01/${n}_${sha.slice(0, 8)}`,
    close: async () => {},
  }) };
  mailBehavior = null;
  const mail = {
    domain: 'empresa.com',
    send: async (m) => {
      if (m.attachment) {   // recibo de un empleado
        if (mailBehavior) await mailBehavior(m);
        if (m.to === 'rebota@x.com') { const e = new Error('550 buzón no existe'); e.responseCode = 550; throw e; }
        sent.push(m);
      } else { reports.push(m); }   // reporte final
      return { messageId: m.messageId ?? `<id-${sent.length}@x.com>`, rejected: [] };
    },
  };
  graphDown = false;
  const verifier = { enabled: true, isInSentItems: async (id) => { if (graphDown) throw new Error('Graph caído'); return sentItems.has(id); } };
  const report = new ReportService(cfg, mail, verifier, repo);
  svc = new ReceiptsService(cfg, sftp, new EmployeesService(cfg), mail, verifier, repo, new ReceiptEmailTemplate(cfg), report);
  sent = []; reports = []; sentItems = new Set();
});
after(async () => { if (DB_URL) { await db.onModuleDestroy(); api.close(); } });

const rows = async (where = 'true') => (await db.pool.query(`select * from recibos_test where ${where} order by id`)).rows;
const reset = async () => { await db.pool.query('TRUNCATE recibos_test, recibos_test_runs'); sent = []; reports = []; sentItems = new Set(); mailBehavior = null; apiDown = false; calls = []; };

test('primera ejecución: envía a los válidos y registra los fallos', opts, async () => {
  await reset();
  files = {
    'Recibo de pago 00123.pdf': pdf('a'), 'Recibo de pago 456.pdf': pdf('b'), 'Recibo de pago 789.pdf': pdf('c'),
    'Recibo de pago 999.pdf': pdf('d'), 'Recibo de pago 555.pdf': pdf('e'), 'Recibo de pago 321.pdf': pdf('f'),
    'Recibo de pago 111.pdf': Buffer.from('no soy pdf'), 'notas.txt': Buffer.from('x'),
  };
  const s = await svc.run({ runId: 'run-1' });
  assert.equal(s.sent, 2); assert.equal(s.failed, 5); assert.deepEqual(s.ignoredNames, ['notas.txt']);
  assert.ok(calls.filter((u) => u.includes('/empleados/')).length >= 6, 'una consulta por código');
  assert.deepEqual(sent.map((m) => m.to), ['ana@x.com', 'luis@x.com']);
  assert.ok(sent[0].html.includes('Ana Pérez'));
  assert.ok(!sent.some((m) => m.to === 'otra@x.com'), 'jamás se envía a un empleado con código distinto');

  const ana = (await rows("file_name = 'Recibo de pago 00123.pdf'"))[0];
  assert.equal(ana.status, 'sent'); assert.equal(ana.attempts, 1); assert.equal(ana.verified, false); assert.equal(ana.run_id, 'run-1');
  assert.match(ana.message_id, /^<receipt-00123-[0-9a-f]{16}@empresa\.com>$/, 'Message-ID estable derivado del contenido');
  assert.match(ana.processed_path, /^\/p\/2026-10-01\/Recibo de pago 00123\.pdf_/);
  const nf = (await rows("employee_code = '999'"))[0];
  assert.equal(nf.status, 'failed'); assert.match(nf.error, /no encontrado/); assert.equal(nf.attempts, 0); assert.equal(nf.processed_path, null);
  assert.equal((await rows("employee_code = '321'"))[0].attempts, 1, 'un rechazo SMTP sí cuenta como intento');
  assert.equal((await rows("file_name = 'Recibo de pago 111.pdf'"))[0].error, 'El archivo no es un PDF válido', 'el PDF inválido ahora también queda registrado');
});

test('reporte final: un correo con los nombres de los empleados, una sola vez', opts, async () => {
  assert.equal(reports.length, 1);
  const r = reports[0];
  assert.deepEqual(r.to, ['rh@empresa.com', 'nomina@empresa.com']); assert.deepEqual(r.cc, ['auditoria@empresa.com']);
  assert.equal(r.attachment, undefined); assert.equal(r.messageId, stableMessageId('report', 'run-1', 'empresa.com'));
  assert.match(r.subject, /2 enviados, 5 con problemas/);
  for (const nombre of ['Ana Pérez', 'Luis Gómez']) assert.ok(r.html.includes(nombre) && r.text.includes(nombre), nombre);
  assert.ok(r.html.includes('Empleado 999 no encontrado en la API') && r.html.includes('notas.txt'));
  assert.ok(!r.html.includes('OTRA PERSONA'));
  const run = await repo.getRun('run-1');
  assert.ok(run.report_sent_at); assert.equal(run.status, 'completed'); assert.equal(run.summary.sent, 2);
  // reintentar el reporte no lo vuelve a enviar
  const again = await new ReportService(cfg, { domain: 'empresa.com', send: async () => assert.fail('no debe reenviar') }, { enabled: false }, repo).sendRunReport('run-1');
  assert.equal(again.sent, false);
});

test('segunda ejecución: no reenvía, verifica y el reporte nuevo no repite lo anterior', opts, async () => {
  sentItems = new Set(sent.map((_, i) => `<id-${i + 1}@x.com>`)); sent.forEach((m, i) => sentItems.add((m.messageId)));
  const before = sent.length;
  const s = await svc.run({ runId: 'run-2' });
  assert.equal(sent.length, before); assert.equal(s.skippedAlreadySent, 2); assert.equal(s.verified, 2);
  const ana = (await rows("employee_code = '00123'"))[0];
  assert.equal(ana.verified, true); assert.match(ana.verification_note, /Elementos enviados/);
  assert.equal(ana.run_id, 'run-1', 'lo ya enviado no se reasigna a la nueva ejecución');
  assert.equal(reports.length, 2); assert.ok(!reports[1].html.includes('Ana Pérez'));
});

test('mismo nombre y contenido nuevo (segundo recibo del mes) se envía como envío distinto', opts, async () => {
  files = { 'Recibo de pago 00123.pdf': pdf('segunda quincena') };
  const before = sent.length;
  const s = await svc.run({ runId: 'run-3' });
  assert.equal(s.sent, 1); assert.equal(sent.length, before + 1);
  const all = await rows("file_name = 'Recibo de pago 00123.pdf'");
  assert.equal(all.length, 2); assert.notEqual(all[0].processed_path, all[1].processed_path); assert.notEqual(all[0].message_id, all[1].message_id);
});

test('envío a medias: si el correo ya salió no se duplica; si no se sabe, queda por revisar; si pasó la ventana, se reenvía', opts, async () => {
  await reset();
  files = { 'Recibo de pago 456.pdf': pdf('crash') };
  // 1) el envío se corta a mitad (conexión caída durante DATA): resultado incierto, el estado queda "sending"
  mailBehavior = () => { const e = new Error('Connection closed unexpectedly'); e.code = 'ECONNECTION'; e.command = 'CONN'; throw e; };
  let s = await svc.run({ runId: 'r1' });
  assert.equal(s.uncertain, 1); assert.equal(s.sent, 0); assert.equal(sent.length, 0);
  let row = (await rows())[0]; assert.equal(row.status, 'uncertain'); assert.ok(row.attempt_started_at);
  const mid = row.message_id;

  // 2) siguiente ejecución: aún no aparece en Elementos enviados y es reciente => NO se reenvía
  mailBehavior = null;
  s = await svc.run({ runId: 'r2' });
  assert.equal(s.uncertain, 1); assert.equal(sent.length, 0, 'jamás reenvía a ciegas');
  assert.match(reports.at(-1).html, /Por revisar/);

  // 3) Graph ya lo muestra => se recupera sin reenviar y queda verificado
  sentItems = new Set([mid]);
  s = await svc.run({ runId: 'r3' });
  assert.equal(s.recovered, 1); assert.equal(sent.length, 0);
  row = (await rows())[0]; assert.equal(row.status, 'sent'); assert.equal(row.verified, true); assert.match(row.verification_note, /Recuperado/);
});

test('envío a medias sin rastro después de la ventana: se reenvía con el mismo Message-ID', opts, async () => {
  await reset();
  files = { 'Recibo de pago 456.pdf': pdf('crash2') };
  mailBehavior = () => { const e = new Error('Connection closed unexpectedly'); e.code = 'ECONNECTION'; e.command = 'CONN'; throw e; };
  await svc.run({ runId: 'r1' });
  const { message_id } = (await rows())[0];
  mailBehavior = null;
  await db.pool.query("update recibos_test set attempt_started_at = now() - interval '30 minutes'");
  const s = await svc.run({ runId: 'r2' });
  assert.equal(s.sent, 1); assert.equal(sent.length, 1); assert.equal(sent[0].messageId, message_id);
});

test('Graph caído o no configurado: lo incierto nunca se reenvía solo, y se resuelve a mano', opts, async () => {
  await reset();
  files = { 'Recibo de pago 456.pdf': pdf('x') };
  mailBehavior = () => { const e = new Error('Connection closed unexpectedly'); e.code = 'ECONNECTION'; throw e; };
  await svc.run({ runId: 'r1' });
  mailBehavior = null; graphDown = true;
  await db.pool.query("update recibos_test set attempt_started_at = now() - interval '2 hours'");
  let s = await svc.run({ runId: 'r2' });
  assert.equal(s.uncertain, 1); assert.equal(sent.length, 0, 'sin poder comprobar, no se reenvía aunque haya pasado mucho tiempo');
  graphDown = false;

  const id = (await rows())[0].id;
  assert.equal(await repo.resolve(id, 'resend'), true);
  assert.equal((await rows())[0].status, 'failed');
  s = await svc.run({ runId: 'r3' });
  assert.equal(s.sent, 1);
  assert.equal(await repo.resolve(id, 'resend'), false, 'ya no está en un estado resoluble');
});

test('fallos definitivos y transitorios del SMTP se distinguen', opts, async () => {
  await reset();
  files = { 'Recibo de pago 456.pdf': pdf('a'), 'Recibo de pago 321.pdf': pdf('b') };
  const s = await svc.run({ runId: 'r1' });     // 321 -> 550 permanente; 456 envía
  assert.equal(s.sent, 1); assert.equal(s.failed, 1);
  await reset();
  files = { 'Recibo de pago 456.pdf': pdf('a') };
  mailBehavior = () => { const e = new Error('451 intenta más tarde'); e.responseCode = 451; throw e; };
  const t = await svc.run({ runId: 'r2' });
  assert.equal(t.failed, 1); assert.equal(t.uncertain, 0);
  const row = (await rows())[0]; assert.equal(row.status, 'failed'); assert.equal(row.attempts, 1);
  mailBehavior = null;
  assert.equal((await svc.run({ runId: 'r3' })).sent, 1, 'un fallo transitorio se reintenta en la siguiente ejecución');
});

test('API de empleados caída: no cuenta intentos, aborta tras 3 fallos y el reporte lo avisa', opts, async () => {
  await reset();
  apiDown = true;
  files = {}; for (let n = 1; n <= 6; n++) files[`Recibo de pago 10${n}.pdf`] = pdf(`n${n}`);
  await assert.rejects(svc.run({ runId: 'r1' }), /503/);
  assert.equal(calls.length, 3);
  assert.ok((await rows()).every((r) => r.attempts === 0 && r.status === 'failed'));
  const run = await repo.getRun('r1'); assert.equal(run.status, 'aborted'); assert.match(run.summary.fatalError, /3 fallos consecutivos/);
  assert.match(reports.at(-1).html, /La ejecución se detuvo/);
  assert.equal(svc.isRunning, false);
  apiDown = false;
});

test('el reporte nunca invalida los envíos, aunque falle', opts, async () => {
  await reset();
  files = { 'Recibo de pago 456.pdf': pdf('r') };
  const boom = { domain: 'empresa.com', send: async (m) => { if (!m.attachment) throw new Error('SMTP caído'); return { messageId: m.messageId, rejected: [] }; } };
  const s2 = new ReceiptsService(cfg, { open: async () => ({ listFiles: async () => [{ name: 'Recibo de pago 456.pdf', size: 20 }], download: async () => pdf('r'), archive: async () => '/p/x', close: async () => {} }) },
    new EmployeesService(cfg), boom, { enabled: false }, repo, new ReceiptEmailTemplate(cfg), new ReportService(cfg, boom, { enabled: false }, repo));
  const s = await s2.run({ runId: 'r1' });
  assert.equal(s.sent, 1); assert.match(s.report, /^error: SMTP caído/);
  assert.equal((await rows())[0].status, 'sent');
  assert.match((await repo.getRun('r1')).report_error, /SMTP caído/);
});

test('sin REPORT_TO no se envía reporte; no permite dos ejecuciones simultáneas', opts, async () => {
  await reset();
  files = {};
  const s = await new ReceiptsService(config({ REPORT_TO: undefined }), { open: async () => ({ listFiles: async () => [], close: async () => {} }) },
    new EmployeesService(cfg), { domain: 'x.com' }, { enabled: false }, repo, new ReceiptEmailTemplate(cfg), new ReportService(config({ REPORT_TO: undefined }), { domain: 'x.com' }, { enabled: false }, repo)).run({ runId: 'r1' });
  assert.match(s.report, /desactivado/);
  config({ REPORT_TO: 'rh@empresa.com, nomina@empresa.com' });
  const first = svc.run({ runId: 'r2' });
  await assert.rejects(svc.run({ runId: 'r3' }), /en ejecución/);
  await first;
});

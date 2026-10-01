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
const { ReceiptEmailTemplate } = require('../dist/mail/receipt-email.template');

const DB_URL = process.env.TEST_DATABASE_URL;
const opts = { skip: DB_URL ? false : 'define TEST_DATABASE_URL para correr el flujo con PostgreSQL' };

let api, apiDown = false, calls = [], cfg, db, repo, files, sent, sentItems, svc;

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
  });
  db = new DbService(cfg); await db.onModuleInit(); await db.pool.query('TRUNCATE recibos_test');
  repo = new ReceiptsRepository(db);
  const sftp = { open: async () => ({
    listFiles: async () => Object.entries(files).map(([name, b]) => ({ name, size: b.length })),
    download: async (n) => files[n],
    archive: async (n, sha) => `/p/2026-10-01/${n}_${sha.slice(0, 8)}`,
    close: async () => {},
  }) };
  const mail = { send: async (m) => { if (m.to === 'rebota@x.com') throw new Error('550 buzón no existe'); sent.push(m); return { messageId: `<id-${sent.length}@x.com>` }; } };
  const verifier = { enabled: true, isInSentItems: async (id) => sentItems.has(id) };
  svc = new ReceiptsService(cfg, sftp, new EmployeesService(cfg), mail, verifier, repo, new ReceiptEmailTemplate(cfg));
});
after(async () => { if (DB_URL) { await db.onModuleDestroy(); api.close(); } });

const rows = async (where = 'true') => (await db.pool.query(`select * from recibos_test where ${where} order by id`)).rows;

test('primera ejecución: envía a los válidos y registra los fallos', opts, async () => {
  files = {
    'Recibo de pago 00123.pdf': pdf('a'), 'Recibo de pago 456.pdf': pdf('b'), 'Recibo de pago 789.pdf': pdf('c'),
    'Recibo de pago 999.pdf': pdf('d'), 'Recibo de pago 555.pdf': pdf('e'), 'Recibo de pago 321.pdf': pdf('f'),
    'Recibo de pago 111.pdf': Buffer.from('no soy pdf'), 'notas.txt': Buffer.from('x'),
  };
  sent = []; sentItems = new Set();
  const s = await svc.run();
  assert.equal(s.sent, 2); assert.equal(s.failed, 5); assert.deepEqual(s.ignoredNames, ['notas.txt']);
  assert.equal(calls.filter((u) => u.includes('/empleados/')).length >= 6, true, 'una consulta por código');
  assert.deepEqual(sent.map((m) => m.to), ['ana@x.com', 'luis@x.com']);
  assert.equal(sent[0].attachment.filename, 'Recibo de pago 00123.pdf');
  assert.ok(sent[0].html.includes('Ana Pérez'));
  assert.ok(!sent.some((m) => m.to === 'otra@x.com'), 'jamás se envía a un empleado con código distinto');

  const ana = (await rows("file_name = 'Recibo de pago 00123.pdf'"))[0];
  assert.equal(ana.status, 'sent'); assert.equal(ana.attempts, 1); assert.equal(ana.verified, false);
  assert.match(ana.processed_path, /^\/p\/2026-10-01\/Recibo de pago 00123\.pdf_/);
  const nf = (await rows("employee_code = '999'"))[0];
  assert.equal(nf.status, 'failed'); assert.match(nf.error, /no encontrado/); assert.equal(nf.attempts, 0); assert.equal(nf.processed_path, null);
  assert.equal((await rows("employee_code = '321'"))[0].attempts, 1, 'un rechazo SMTP sí cuenta como intento');
});

test('segunda ejecución: no reenvía y verifica en Elementos enviados', opts, async () => {
  sentItems = new Set(['<id-1@x.com>', '<id-2@x.com>']);
  const before = sent.length;
  const s = await svc.run();
  assert.equal(sent.length, before); assert.equal(s.skippedAlreadySent, 2); assert.equal(s.verified, 2);
  const ana = (await rows("employee_code = '00123'"))[0];
  assert.equal(ana.verified, true); assert.ok(ana.verified_at); assert.match(ana.verification_note, /Elementos enviados/);
});

test('mismo nombre y contenido nuevo (segundo recibo del mes) se envía como envío distinto', opts, async () => {
  files = { 'Recibo de pago 00123.pdf': pdf('segunda quincena') };
  const before = sent.length;
  const s = await svc.run();
  assert.equal(s.sent, 1); assert.equal(sent.length, before + 1);
  const all = await rows("file_name = 'Recibo de pago 00123.pdf'");
  assert.equal(all.length, 2); assert.notEqual(all[0].processed_path, all[1].processed_path);
});

test('API de empleados caída: no cuenta intentos, aborta tras 3 fallos y se recupera', opts, async () => {
  apiDown = true; calls = [];
  files = {}; for (let n = 1; n <= 6; n++) files[`Recibo de pago 10${n}.pdf`] = pdf(`n${n}`);
  await assert.rejects(svc.run(), /503/);
  assert.equal(calls.length, 3);
  assert.match(svc.lastRun.fatalError, /3 fallos consecutivos/);
  assert.equal(svc.isRunning, false);
  assert.ok((await rows("file_name like 'Recibo de pago 10%'")).every((r) => r.attempts === 0 && r.status === 'failed'));
  apiDown = false;
  files = { 'Recibo de pago 456.pdf': pdf('b') };
  assert.equal((await svc.run()).skippedAlreadySent, 1);
});

test('no permite dos ejecuciones simultáneas', opts, async () => {
  files = {};
  const first = svc.run();
  await assert.rejects(svc.run(), /en ejecución/);
  await first;
});

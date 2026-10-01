const { test } = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('./helpers');
const { compileReceiptRegex, parseReceiptFilename, DEFAULT_RECEIPT_FILENAME_REGEX } = require('../dist/receipts/parse-receipt-filename');
const { ReceiptEmailTemplate } = require('../dist/mail/receipt-email.template');
const { SftpSession } = require('../dist/sftp/sftp.service');
const { DbService } = require('../dist/db/db.service');
const { buildRunReport } = require('../dist/receipts/report.template');
const { temporalConnectionOptions } = require('../dist/temporal/temporal.client.service');

test('nombre de archivo: extrae el código y rechaza lo demás', () => {
  const re = compileReceiptRegex(DEFAULT_RECEIPT_FILENAME_REGEX);
  assert.equal(parseReceiptFilename('Recibo de pago 00123.pdf', re), '00123');
  assert.equal(parseReceiptFilename('recibo de pago 7.PDF', re), '7');
  for (const bad of ['Recibo de pago abc.pdf', 'Recibo de pago 12.pdf.exe', 'Recibo de pago .pdf', 'otro 12.pdf']) {
    assert.equal(parseReceiptFilename(bad, re), null, bad);
  }
});

test('nombre de archivo: el patrón es configurable y se valida', () => {
  assert.equal(parseReceiptFilename('Nomina_55.pdf', compileReceiptRegex('^Nomina_(\\d+)\\.pdf$')), '55');
  assert.throws(() => compileReceiptRegex('sin grupo'), /grupo de captura/);
  assert.throws(() => compileReceiptRegex('(['), /no es una expresión/);
});

test('plantilla: escapa HTML, usa nombre por defecto y admite plantilla propia', () => {
  const t = new ReceiptEmailTemplate(config({ COMPANY_NAME: 'Acme <S&A>', MAIL_TEMPLATE_HTML_PATH: undefined, MAIL_TEMPLATE_TEXT_PATH: undefined }));
  const out = t.render('<b>Ana</b>');
  assert.ok(out.html.includes('&lt;b&gt;Ana&lt;/b&gt;') && out.html.includes('Acme &lt;S&amp;A&gt;'));
  assert.ok(out.text.includes('Acme <S&A>'), 'el texto plano no se escapa');
  assert.ok(t.render('').text.startsWith('Hola colaborador'));

  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-')), 't.html');
  fs.writeFileSync(file, '<p>Hola {{nombre}} de {{empresa}}</p>');
  const custom = new ReceiptEmailTemplate(config({ MAIL_TEMPLATE_HTML_PATH: file }));
  assert.equal(custom.render('Luz').html, '<p>Hola Luz de Acme &lt;S&amp;A&gt;</p>');
  config({ MAIL_TEMPLATE_HTML_PATH: undefined, COMPANY_NAME: undefined });
});

test('archivado: dos archivos con el mismo nombre nunca se pisan', async () => {
  const files = new Set(['/r/Recibo de pago 123.pdf']);
  const dirs = new Set(['/r/procesados']);
  const client = {
    exists: async (p) => files.has(p) || dirs.has(p),
    mkdir: async (p) => dirs.add(p),
    rename: async (a, b) => { assert.ok(files.delete(a), 'el origen existe'); assert.ok(!files.has(b), 'no pisa el destino'); files.add(b); },
  };
  const s = new SftpSession(client, '/r', '/r/procesados');
  const p1 = await s.archive('Recibo de pago 123.pdf', 'aaaaaaaa1111');
  files.add('/r/Recibo de pago 123.pdf');               // segundo recibo del mes, mismo nombre
  const p2 = await s.archive('Recibo de pago 123.pdf', 'bbbbbbbb2222');
  files.add('/r/Recibo de pago 123.pdf');               // caso extremo: mismo hash y mismo segundo
  const p3 = await s.archive('Recibo de pago 123.pdf', 'aaaaaaaa1111');
  assert.equal(new Set([p1, p2, p3]).size, 3);
  assert.match(p1, /^\/r\/procesados\/\d{4}-\d{2}-\d{2}\/Recibo de pago 123_\d{8}-\d{6}_aaaaaaaa\.pdf$/);
});

test('DB_TABLE: solo acepta identificadores seguros', () => {
  const base = { DATABASE_URL: 'postgres://u@localhost/x' };
  assert.doesNotThrow(() => new DbService(config({ ...base, DB_TABLE: 'recibos_2026' })));
  for (const bad of ['Bad;DROP', 'a b', '1abc', 'x"y']) {
    assert.throws(() => new DbService(config({ ...base, DB_TABLE: bad })), /DB_TABLE/, bad);
  }
  config({ DB_TABLE: undefined });
});

test('BD: se configura por partes (host, puerto, usuario, contraseña) o por DATABASE_URL', async () => {
  const parts = new DbService(config({ DATABASE_URL: undefined, DB_HOST: '10.1.2.3', DB_PORT: 6543, DB_USER: 'u', DB_PASSWORD: 'p@ss/w:rd#!', DB_NAME: 'n', DB_TABLE: undefined }));
  assert.deepEqual([parts.pool.options.host, parts.pool.options.port, parts.pool.options.user, parts.pool.options.password, parts.pool.options.database],
    ['10.1.2.3', 6543, 'u', 'p@ss/w:rd#!', 'n']);
  const url = new DbService(config({ DATABASE_URL: 'postgres://a:b@h:1/d' }));
  assert.equal(url.pool.options.connectionString, 'postgres://a:b@h:1/d');
  assert.throws(() => new DbService(config({ DATABASE_URL: undefined, DB_USER: undefined, DB_NAME: undefined })), /DB_USER/);
  await parts.pool.end(); await url.pool.end();
  config({ DB_HOST: undefined, DB_PORT: undefined, DB_USER: undefined, DB_PASSWORD: undefined, DB_NAME: undefined, DATABASE_URL: undefined });
});

test('reporte: nombres de empleados, secciones, escape de HTML y correo omitible', () => {
  const row = (o) => ({ id: '1', file_name: 'Recibo de pago 1.pdf', employee_code: '1', employee_name: 'Ana', to_email: 'ana@x.com', status: 'sent', verified: true, error: null, ...o });
  const rows = [
    row({ employee_name: 'Ana <script>x</script>' }),
    row({ id: '2', employee_name: 'Luis', employee_code: '2', to_email: 'luis@x.com', verified: false }),
    row({ id: '3', employee_name: null, employee_code: '3', to_email: null, status: 'failed', error: 'no encontrado <b>' }),
    row({ id: '4', employee_name: 'Eva', employee_code: '4', status: 'sending' }),
  ];
  const base = { runId: 'r1', title: 'Reporte', startedAt: new Date('2026-10-01T14:00:00Z'), finishedAt: new Date('2026-10-01T14:05:00Z'), timeZone: 'America/Mexico_City',
    counters: { skippedAlreadySent: 3, ignoredNames: ['a&b.txt'], unrecorded: [{ file: 'x.pdf', error: 'excede' }] }, rows, includeEmail: true };
  const r = buildRunReport(base);
  assert.match(r.subject, /^Reporte .*: 2 enviados, 3 con problemas$/);
  assert.ok(r.html.includes('Ana &lt;script&gt;x&lt;/script&gt;') && !r.html.includes('<script>'), 'escapa HTML');
  assert.ok(r.html.includes('Luis') && r.html.includes('luis@x.com') && r.html.includes('Por revisar') && r.html.includes('Eva'));
  assert.ok(r.html.includes('no encontrado &lt;b&gt;') && r.html.includes('x.pdf') && r.html.includes('a&amp;b.txt'));
  assert.ok(r.text.includes('Ana <script>x</script> [1]') && r.text.includes('Luis') && r.text.includes('POR REVISAR'));
  const sinCorreo = buildRunReport({ ...base, includeEmail: false });
  assert.ok(!sinCorreo.html.includes('luis@x.com') && !sinCorreo.text.includes('luis@x.com'));
  assert.ok(buildRunReport({ ...base, counters: { fatalError: 'API caída' } }).html.includes('La ejecución se detuvo'));
  assert.equal(buildRunReport({ ...base, rows: [row({})], counters: {} }).subject.includes('con problemas'), false);
});

test('Temporal: opciones de conexión (TLS simple, CA propia, mTLS, API key) salen del entorno', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  for (const [n, c] of [['ca.pem', 'CA'], ['cert.pem', 'CERT'], ['key.pem', 'KEY']]) fs.writeFileSync(path.join(dir, n), c);
  const none = { TEMPORAL_ADDRESS: undefined, TEMPORAL_TLS: undefined, TEMPORAL_API_KEY: undefined, TEMPORAL_TLS_CA_PATH: undefined, TEMPORAL_TLS_CERT_PATH: undefined, TEMPORAL_TLS_KEY_PATH: undefined, TEMPORAL_TLS_SERVER_NAME: undefined };

  let o = temporalConnectionOptions(config(none));
  assert.deepEqual([o.address, o.tls, o.apiKey], ['localhost:7233', undefined, undefined], 'por defecto: local y sin TLS');

  o = temporalConnectionOptions(config({ ...none, TEMPORAL_ADDRESS: 'temporal.interno:7233', TEMPORAL_TLS: 'true' }));
  assert.equal(o.address, 'temporal.interno:7233'); assert.ok(o.tls); assert.equal(o.tls.clientCertPair, undefined);

  o = temporalConnectionOptions(config({ ...none, TEMPORAL_TLS_CA_PATH: path.join(dir, 'ca.pem'), TEMPORAL_TLS_SERVER_NAME: 'temporal.empresa.com' }));
  assert.equal(o.tls.serverRootCACertificate.toString(), 'CA'); assert.equal(o.tls.serverNameOverride, 'temporal.empresa.com');

  o = temporalConnectionOptions(config({ ...none, TEMPORAL_TLS_CERT_PATH: path.join(dir, 'cert.pem'), TEMPORAL_TLS_KEY_PATH: path.join(dir, 'key.pem') }));
  assert.deepEqual([o.tls.clientCertPair.crt.toString(), o.tls.clientCertPair.key.toString()], ['CERT', 'KEY'], 'mTLS: certificado y llave de cliente');

  o = temporalConnectionOptions(config({ ...none, TEMPORAL_API_KEY: 'k' }));
  assert.ok(o.tls, 'la API key activa TLS'); assert.equal(o.apiKey, 'k');

  assert.throws(() => temporalConnectionOptions(config({ ...none, TEMPORAL_TLS_CERT_PATH: path.join(dir, 'cert.pem') })), /juntas/);
  assert.throws(() => temporalConnectionOptions(config({ ...none, TEMPORAL_TLS_CA_PATH: '/no/existe.pem' })), /ENOENT/);
  config(none);
});

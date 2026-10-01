const { test } = require('node:test');
const assert = require('node:assert/strict');
const { config } = require('./helpers');
const { compileReceiptRegex, parseReceiptFilename, DEFAULT_RECEIPT_FILENAME_REGEX } = require('../dist/receipts/parse-receipt-filename');
const { ReceiptEmailTemplate } = require('../dist/mail/receipt-email.template');
const { SftpSession } = require('../dist/sftp/sftp.service');
const { DbService } = require('../dist/db/db.service');

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

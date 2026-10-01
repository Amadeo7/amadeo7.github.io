const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const { config, pdf } = require('./helpers');
const { MailService, classifySmtpError, stableMessageId } = require('../dist/mail/mail.service');
const { GraphVerifierService } = require('../dist/mail/graph-verifier.service');
const { ReceiptEmailTemplate } = require('../dist/mail/receipt-email.template');

let smtp, received = [], sawTls = false, port;
before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  smtp = new SMTPServer({
    key: fs.readFileSync(`${dir}/k.pem`), cert: fs.readFileSync(`${dir}/c.pem`),
    onSecure(_s, _sess, cb) { sawTls = true; cb(); },
    onAuth(a, _s, cb) { a.username === 'nomina@empresa.com' && a.password === 'secreto' ? cb(null, { user: a.username }) : cb(new Error('535 5.7.139 credenciales')); },
    onRcptTo(addr, _s, cb) {
      if (addr.address === 'rechazado@x.com') return cb(new Error('550 buzón inexistente'));
      if (addr.address === 'temporal@x.com') { const e = new Error('451 intenta más tarde'); e.responseCode = 451; return cb(e); }
      cb();
    },
    onData(stream, _s, cb) {
      simpleParser(stream).then((m) => {
        if (m.subject === 'CORTAR') { for (const c of smtp.connections) c._socket.destroy(); return; }   // se cae la conexión a mitad del envío
        if (m.subject === 'RECHAZAR-DATA') { const e = new Error('554 contenido rechazado'); e.responseCode = 554; return cb(e); }
        received.push(m); cb();
      });
    },
  });
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  port = smtp.server.address().port;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // solo pruebas: certificado autofirmado
});
after(() => smtp.close());

const mailer = (pass = 'secreto') => new MailService(config({ SMTP_HOST: '127.0.0.1', SMTP_PORT: port, SMTP_USER: 'nomina@empresa.com', SMTP_PASS: pass, MAIL_FROM: 'Nómina <nomina@empresa.com>', COMPANY_NAME: 'Empresa SA' }));
const send = (m, to = 'ana@x.com') => m.send({ to, subject: 'Tu recibo de pago', html: 'h', text: 't', attachment: { filename: 'a.pdf', content: pdf() } });

test('SMTP: STARTTLS, HTML + texto, adjunto idéntico y Message-ID conservado', async () => {
  const m = mailer();
  const tpl = new ReceiptEmailTemplate(config({})).render('Ana <Pérez>');
  const file = pdf('x'.repeat(5000));
  const { messageId } = await m.send({ to: 'ana@x.com', subject: 'Tu recibo de pago', html: tpl.html, text: tpl.text, attachment: { filename: 'Recibo de pago 00123.pdf', content: file } });
  const got = received.at(-1);
  assert.ok(sawTls);
  assert.equal(got.messageId, messageId);
  assert.match(messageId, /^<[0-9a-f-]{36}@empresa\.com>$/);
  assert.equal(got.from.value[0].address, 'nomina@empresa.com');
  assert.ok(got.html.includes('Hola Ana &lt;Pérez&gt;') && got.html.includes('Empresa SA'));
  assert.equal(got.attachments[0].filename, 'Recibo de pago 00123.pdf');
  assert.equal(got.attachments[0].contentType, 'application/pdf');
  assert.ok(got.attachments[0].content.equals(file));
});

test('SMTP: destinatario rechazado y credenciales malas producen error', async () => {
  await assert.rejects(send(mailer(), 'rechazado@x.com'), /550|rechaz/i);
  await assert.rejects(send(mailer('mala')), /535|credenciales|Invalid/i);
});

test('Graph: token cacheado, filtro por Message-ID escapado, carpeta y buzón configurables', async () => {
  const seen = []; const inSent = new Set(['<abc@empresa.com>']);
  const graph = http.createServer((req, res) => {
    seen.push(`${req.method} ${decodeURIComponent(req.url)}`);
    let body = ''; req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.includes('/oauth2/v2.0/token')) {
        assert.ok(body.includes('grant_type=client_credentials') && body.includes('client_secret=sec'));
        return res.end(JSON.stringify({ access_token: 'T1', expires_in: 3600 }));
      }
      assert.equal(req.headers.authorization, 'Bearer T1');
      const id = /internetMessageId eq '(.*)'/.exec(decodeURIComponent(req.url))?.[1].replace(/''/g, "'");
      res.end(JSON.stringify({ value: inSent.has(id) ? [{ id: 'AAA' }] : [] }));
    });
  }).listen(0);
  await new Promise((r) => graph.once('listening', r));
  const base = `http://127.0.0.1:${graph.address().port}`;
  const v = new GraphVerifierService(config({ AZURE_TENANT_ID: 'ten', AZURE_CLIENT_ID: 'cid', AZURE_CLIENT_SECRET: 'sec', AZURE_AUTH_URL: base, GRAPH_BASE_URL: base, GRAPH_MAILBOX: 'nomina@empresa.com', GRAPH_SENT_FOLDER: 'sentitems' }));
  assert.equal(v.enabled, true);
  assert.equal(await v.isInSentItems('<abc@empresa.com>'), true);
  assert.equal(await v.isInSentItems('<no-existe@empresa.com>'), false);
  await v.isInSentItems("<it's@x.com>");
  graph.close();
  assert.equal(seen.filter((s) => s.includes('/oauth2/')).length, 1);
  assert.ok(seen.some((s) => s.includes('/users/nomina@empresa.com/mailFolders/sentitems/messages')));
  assert.ok(seen.some((s) => s.includes("it''s@x.com")));
  assert.equal(new GraphVerifierService(config({ AZURE_CLIENT_SECRET: undefined })).enabled, false);
});

test('clasificación de fallos SMTP: se sabe cuándo es seguro reintentar y cuándo es incierto', async () => {
  const m = mailer();
  const kind = (to, subject = 's') => m.send({ to, subject, html: 'h', text: 't', attachment: { filename: 'a.pdf', content: pdf() } }).then(() => 'ok', classifySmtpError);
  assert.equal(await kind('ana@x.com'), 'ok');
  assert.equal(await kind('rechazado@x.com'), 'definite_permanent');          // 550 en RCPT
  assert.equal(await kind('temporal@x.com'), 'definite_transient');           // 451 en RCPT
  assert.equal(await kind('ana@x.com', 'RECHAZAR-DATA'), 'definite_permanent'); // 554 después del contenido: respondió, no salió
  assert.equal(await mailer('mala').send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' }).then(() => 'ok', classifySmtpError), 'definite_permanent'); // 535
  assert.equal(await kind('ana@x.com', 'CORTAR'), 'ambiguous');               // conexión cortada durante DATA: puede haber salido o no
  const down = new MailService(config({ SMTP_HOST: '127.0.0.1', SMTP_PORT: 1, SMTP_USER: 'nomina@empresa.com', SMTP_PASS: 'x' }));
  assert.equal(await down.send({ to: 'a@x.com', subject: 's', html: 'h', text: 't' }).then(() => 'ok', classifySmtpError), 'definite_transient'); // no conectó
});

test('Message-ID estable: mismo contenido, mismo identificador', () => {
  assert.equal(stableMessageId('receipt', '00123-ab12', 'empresa.com'), '<receipt-00123-ab12@empresa.com>');
  assert.equal(stableMessageId('report', 'run 1/2:3', 'x.com'), '<report-run123@x.com>');
});

test('varios destinatarios y copia: el reporte sale a todos', async () => {
  const m = mailer();
  await m.send({ to: ['a@x.com', 'b@x.com'], cc: ['c@x.com'], subject: 'Reporte', html: 'h', text: 't' });
  const got = received.at(-1);
  assert.deepEqual(got.to.value.map((v) => v.address), ['a@x.com', 'b@x.com']);
  assert.deepEqual(got.cc.value.map((v) => v.address), ['c@x.com']);
  assert.equal(got.attachments.length, 0);
});

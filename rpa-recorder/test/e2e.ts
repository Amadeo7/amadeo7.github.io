/**
 * Prueba de punta a punta: sirve un "banco" falso, graba una sesion automatizando el
 * navegador, guarda el flujo y lo reproduce en un navegador nuevo.
 */
import assert from 'assert';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { runFlow } from '../src/player';
import { startRecording } from '../src/recorder';

const LOGIN = `<form action="/home" method="get">
  <input type="text" name="user" placeholder="Usuario">
  <input type="password" id="pass" name="pass">
  <button type="submit">Ingresar</button>
</form>`;
const HOME = `<h1>Cuenta</h1>
<select id="acct"><option value="a1">Lempiras</option><option value="a2">Dolares</option></select>
<a href="/dep">Depositos</a>`;
const DEP = `<table><tr><td class="monto">L. 1,500.00</td></tr><tr><td class="monto">L. 320.50</td></tr></table>
<span id="saldo">L. 9,999.00</span>`;

async function main() {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    res.setHeader('content-type', 'text/html');
    res.end(path === '/home' ? HOME : path === '/dep' ? DEP : LOGIN);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const executablePath = process.env.CHROMIUM_PATH;

  // ---- 1) Grabar ----
  const rec = await startRecording({ name: 'demo', url: `${base}/`, headless: true, executablePath });
  const p = rec.page;
  await p.locator('input[name=user]').click();
  await p.keyboard.type('robot01');
  await p.locator('#pass').click();
  await p.keyboard.type('secreto-123');
  await p.getByRole('button', { name: 'Ingresar' }).click();
  await p.waitForURL('**/home*');
  await p.selectOption('#acct', 'a2');
  await p.getByText('Depositos').click();
  await p.waitForURL('**/dep');
  await p.locator('#saldo').click({ modifiers: ['Alt'] }); // marcar para extraer
  const flow = await rec.stop();

  console.log(flow.steps.map((s) => s.type + ('target' in s && s.target ? ' ' + s.target.candidates[0] : '')).join('\n'));
  const json = JSON.stringify(flow);
  assert(!json.includes('secreto-123'), 'la contrasena NO debe guardarse en el flujo');
  assert.deepStrictEqual(flow.requiredVars, ['PASS']);
  assert(flow.steps.some((s) => s.type === 'extract'), 'debe haber un paso extract');

  // el dato con "extract all" se agrega a mano en el JSON
  flow.steps.push({ type: 'extract', as: 'montos', all: true, target: { candidates: ['td.monto'] } });

  // ---- 2) Reproducir en un navegador nuevo ----
  const res = await runFlow(flow, { vars: { PASS: 'secreto-123' }, executablePath, typeDelayMs: 5 });
  console.log(res.outputs);
  assert.strictEqual(res.outputs.dato1, 'L. 9,999.00');
  assert.deepStrictEqual(res.outputs.montos, ['L. 1,500.00', 'L. 320.50']);

  // ---- 3) Falla controlada ----
  await assert.rejects(
    runFlow({ ...flow, steps: [{ type: 'goto', url: `${base}/` }, { type: 'click', target: { candidates: ['#no-existe'] } }] },
      { vars: { PASS: 'x' }, executablePath, timeoutMs: 1500, artifactsDir: 'artifacts' }),
    /Paso 2 \(click\) fallo/,
  );

  server.close();
  console.log('\nE2E OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

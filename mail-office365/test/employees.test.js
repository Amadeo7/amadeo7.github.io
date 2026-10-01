const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { config } = require('./helpers');
const { EmployeesService, EmployeeApiError } = require('../dist/employees/employees.service');

let server, base, calls = [];
const DB = { '00123': ['Ana Pérez', 'ana@x.com'], '456': ['Luis Gómez', 'luis@x.com'] };

before(async () => {
  server = http.createServer((req, res) => {
    calls.push(req.url);
    const url = new URL(req.url, 'http://x');
    const code = url.searchParams.get('codigo') ?? decodeURIComponent(url.pathname.split('/').pop());
    res.setHeader('content-type', 'application/json');
    const basic = 'Basic ' + Buffer.from('usr:p@ss:word').toString('base64');
    if (req.headers['x-token'] !== 'tok' && req.headers.authorization !== basic) { res.statusCode = 401; return res.end('{}'); }
    if (code === 'boom') { res.statusCode = 503; return res.end('x'); }
    if (code === '555') return res.end(JSON.stringify({ data: { codigo: '999', nombre: 'OTRA PERSONA', correo: 'otra@x.com' } }));
    if (code === 'lista') return res.end(JSON.stringify({ data: [{ codigo: '1', nombre: 'Otro', correo: 'o@x.com' }, { codigo: '00123', nombre: 'Ana Pérez', correo: 'ana@x.com' }] }));
    if (!DB[code]) { res.statusCode = 404; return res.end('{}'); }
    res.end(JSON.stringify({ data: { codigo: code, nombre: DB[code][0], correo: DB[code][1] } }));
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const svc = (extra = {}) => new EmployeesService(config({
  EMPLOYEES_API_URL: `${base}/empleados/{code}`, EMPLOYEES_API_TOKEN: 'tok', EMPLOYEES_API_AUTH_HEADER: 'X-Token',
  EMPLOYEES_API_AUTH_SCHEME: '', EMPLOYEES_API_RESPONSE_PATH: 'data', EMPLOYEES_API_STRIP_ZEROS: 'false', ...extra,
}));

test('exige el marcador {code} en la URL', () => {
  assert.throws(() => new EmployeesService(config({ EMPLOYEES_API_URL: `${base}/empleados` })), /\{code\}/);
});

test('consulta por código, con la cabecera configurada, y cachea dentro de la ejecución', async () => {
  calls = [];
  const lookup = svc().lookup();
  const e = await lookup.find('00123');
  assert.deepEqual(e, { code: '123', name: 'Ana Pérez', email: 'ana@x.com' });
  await lookup.find('00123'); await lookup.find('0123');   // mismo empleado, distinto relleno de ceros
  assert.equal(calls.filter((u) => u.includes('00123')).length, 1);
  assert.equal(calls[0], '/empleados/00123');
});

test('404 = no existe; otros errores = API no disponible', async () => {
  const lookup = svc().lookup();
  assert.equal(await lookup.find('999999'), null);
  await assert.rejects(lookup.find('boom'), EmployeeApiError);
  await assert.rejects(svc({ EMPLOYEES_API_TOKEN: 'mal' }).lookup().find('456'), (e) => e instanceof EmployeeApiError && /401/.test(e.message));
  await assert.rejects(new EmployeesService(config({ EMPLOYEES_API_URL: 'http://127.0.0.1:1/{code}' })).lookup().find('1'), EmployeeApiError);
});

test('nunca acepta a un empleado cuyo código no coincide con el pedido', async () => {
  assert.equal(await svc().lookup().find('555'), null);
});

test('acepta respuestas en arreglo y elige la que coincide; STRIP_ZEROS cambia lo que se envía', async () => {
  calls = [];
  const e = await svc({ EMPLOYEES_API_URL: `${base}/empleados?codigo={code}` }).lookup().find('lista');
  assert.equal(e, null, 'el arreglo no contiene al código "lista"');
  calls = [];
  await svc({ EMPLOYEES_API_STRIP_ZEROS: 'true' }).lookup().find('00123');
  assert.equal(calls[0], '/empleados/123');
});

test('autenticación con usuario y contraseña (Basic) cuando no hay token', async () => {
  const basic = svc({ EMPLOYEES_API_TOKEN: undefined, EMPLOYEES_API_USER: 'usr', EMPLOYEES_API_PASSWORD: 'p@ss:word' });
  assert.deepEqual(await basic.lookup().find('456'), { code: '456', name: 'Luis Gómez', email: 'luis@x.com' });
  await assert.rejects(svc({ EMPLOYEES_API_TOKEN: undefined, EMPLOYEES_API_USER: 'usr', EMPLOYEES_API_PASSWORD: 'mala' }).lookup().find('456'), EmployeeApiError);
  config({ EMPLOYEES_API_USER: undefined, EMPLOYEES_API_PASSWORD: undefined });
});

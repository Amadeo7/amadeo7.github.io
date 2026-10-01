// Comprueba la conexión con el servidor Temporal configurado en .env, sin ejecutar nada.
//   npm run temporal:check
require('reflect-metadata');
require('dotenv').config();
const { ConfigService } = require('@nestjs/config');
const { Connection, Client } = require('@temporalio/client');
const { temporalConnectionOptions } = require('../dist/temporal/temporal.client.service');

const config = new ConfigService();
const ns = config.get('TEMPORAL_NAMESPACE', 'default');
const queue = config.get('TEMPORAL_TASK_QUEUE', 'receipts-mail');
const ok = (m) => console.log(`  ✔ ${m}`);
const bad = (m) => console.log(`  ✘ ${m}`);

const HINTS = [
  [/UNAUTHENTICATED|unauthenticated|API key|authorization/i, 'El servidor rechazó las credenciales: revisa TEMPORAL_API_KEY o el certificado de cliente (mTLS).'],
  [/certificate|CERT|handshake|SSL|TLS/i, 'Falló TLS: revisa TEMPORAL_TLS, TEMPORAL_TLS_CA_PATH (CA propia) y TEMPORAL_TLS_SERVER_NAME si el nombre del certificado no coincide con el host.'],
  [/Namespace .* not found|NOT_FOUND|not found/i, `El namespace "${ns}" no existe en ese servidor: créalo (temporal operator namespace create ${ns}) o corrige TEMPORAL_NAMESPACE.`],
  [/ECONNREFUSED|UNAVAILABLE|connect|timed? ?out|deadline/i, 'No hay conexión: revisa TEMPORAL_ADDRESS (host:puerto del frontend, normalmente 7233), firewall y que esta máquina o contenedor alcance el servidor.'],
];

(async () => {
  let opts;
  try {
    opts = temporalConnectionOptions(config);
  } catch (e) {
    bad(e.message);
    process.exitCode = 1;
    return;
  }
  console.log(`Temporal: ${opts.address} · namespace "${ns}" · cola "${queue}"`);
  console.log(`  TLS: ${opts.tls ? `sí${opts.tls.clientCertPair ? ' (mTLS)' : ''}${opts.tls.serverRootCACertificate ? ' (CA propia)' : ''}` : 'no'} · API key: ${opts.apiKey ? 'sí' : 'no'}`);
  let connection;
  try {
    connection = await Connection.connect({ ...opts, connectTimeout: '10s' });
    ok('conexión establecida');
    const info = await connection.workflowService.getSystemInfo({});
    ok(`versión del servidor: ${info.serverVersion || 'desconocida'}`);
    const d = await connection.workflowService.describeNamespace({ namespace: ns });
    ok(`namespace "${ns}" disponible (estado ${d.namespaceInfo?.state}, retención ${d.config?.workflowExecutionRetentionTtl?.seconds ?? '?'} s)`);
    const client = new Client({ connection, namespace: ns });
    const schedule = config.get('TEMPORAL_SCHEDULE_ID', 'receipts-schedule');
    try {
      const s = await client.schedule.getHandle(schedule).describe();
      ok(`Schedule "${schedule}" existe (${s.state.paused ? 'pausado' : 'activo'})`);
    } catch {
      console.log(`  · Schedule "${schedule}" aún no existe (se crea al arrancar la app si defines TEMPORAL_SCHEDULE_CRON)`);
    }
    console.log('\nListo: la app puede usar este servidor (TEMPORAL_ENABLED=true).');
  } catch (e) {
    bad(String(e.message || e));
    const hint = HINTS.find(([re]) => re.test(String(e.message || e) + String(e.code || '')));
    if (hint) console.log(`\n  → ${hint[1]}`);
    if (opts.tls && /deadline|connect/i.test(String(e.message))) {
      console.log('  → Tienes TLS activo: si el servidor no usa TLS, quita TEMPORAL_TLS / TEMPORAL_TLS_* / TEMPORAL_API_KEY; si lo usa, revisa la CA (TEMPORAL_TLS_CA_PATH) y el nombre (TEMPORAL_TLS_SERVER_NAME).');
    }
    process.exitCode = 1;
  } finally {
    await connection?.close();
  }
})();

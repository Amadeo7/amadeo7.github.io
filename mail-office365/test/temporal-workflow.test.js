// Comportamiento del workflow contra un servidor Temporal real (dev server), con activities simuladas.
// Se omite si no hay binario del CLI de Temporal:
//   TEMPORAL_CLI_PATH=/ruta/a/temporal npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const CLI = process.env.TEMPORAL_CLI_PATH;
const opts = { skip: CLI ? false : 'define TEMPORAL_CLI_PATH (binario del CLI de Temporal) para probar el workflow' };

let TestWorkflowEnvironment, Worker, ApplicationFailure, env;
const WORKFLOWS = require.resolve('../dist/temporal/workflows');
const cfg = { delayMs: 0, maxApiErrors: 3, batchSize: 500, retryAttempts: 3, retryInitialSeconds: 1, retryMaxSeconds: 2, reportRetryAttempts: 2, reportRetryInitialSeconds: 1 };

before(async () => {
  if (!CLI) return;
  ({ TestWorkflowEnvironment } = require('@temporalio/testing'));
  ({ Worker } = require('@temporalio/worker'));
  ({ ApplicationFailure } = require('@temporalio/activity'));
  env = await TestWorkflowEnvironment.createLocal({ server: { executable: { type: 'existing-path', path: CLI } } });
});
after(async () => { await env?.teardown(); });

const names = (n) => Array.from({ length: n }, (_, i) => ({ name: `Recibo de pago ${i + 1}.pdf`, size: 100 }));
const sentOutcome = (f) => ({ file: f.name, status: 'sent', employeeName: 'X', sentNow: true });

/** Activities simuladas que registran lo que se les pide. */
function fakeActivities(over = {}) {
  const log = { start: [], list: 0, process: [], uncertain: [], verify: 0, save: [], report: [] };
  const acts = {
    startRun: async (id) => { log.start.push(id); },
    listFiles: async () => { log.list++; return { files: names(5), ignored: ['notas.txt'] }; },
    processReceipt: async (runId, f) => { log.process.push(f.name); return sentOutcome(f); },
    markUncertain: async (rowId, note) => { log.uncertain.push([rowId, note]); },
    verifyPending: async () => { log.verify++; return 3; },
    saveRun: async (runId, counters, aborted) => { log.save.push({ runId, counters, aborted }); },
    sendReport: async (runId) => { log.report.push(runId); return 'enviado'; },
    ...over,
  };
  return { acts, log };
}

async function run(acts, config = {}, id = `wf-${randomUUID()}`) {
  const taskQueue = `q-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: WORKFLOWS, activities: acts });
  const exec = () => env.client.workflow.execute('processReceiptsRun', { taskQueue, workflowId: id, args: [{ config: { ...cfg, ...config } }] });
  return { id, taskQueue, result: await worker.runUntil(exec()) };
}

test('recorre todos los archivos en lotes (continueAsNew) y cierra una sola vez', opts, async () => {
  const { acts, log } = fakeActivities();
  const { result, id, taskQueue } = await run(acts, { batchSize: 2 });
  assert.deepEqual(log.process, names(5).map((f) => f.name), 'todos, en orden, sin repetir al continuar');
  assert.equal(log.list, 1, 'el listado se hace una sola vez, no en cada lote');
  assert.equal(log.start.length, 1);
  assert.equal(log.verify, 1); assert.equal(log.report.length, 1); assert.equal(log.save.length, 1);
  assert.equal(result.sent, 5); assert.equal(result.filesFound, 6); assert.deepEqual(result.ignoredNames, ['notas.txt']);
  assert.equal(result.verified, 3); assert.equal(result.report, 'enviado');
  assert.equal(log.save[0].runId, result.runId); assert.equal(log.save[0].aborted, false);
  assert.equal(log.report[0], result.runId, 'el mismo runId en todos los lotes');

  // el historial se puede reproducir: el workflow es determinista
  const history = await env.client.workflow.getHandle(id).fetchHistory();
  await Worker.runReplayHistory({ workflowsPath: WORKFLOWS }, history, id);
  void taskQueue;
});

test('pausa durable entre envíos reales, y ninguna tras un archivo omitido', opts, async () => {
  const { acts, log } = fakeActivities({
    listFiles: async () => ({ files: names(3), ignored: [] }),
    processReceipt: async (_r, f) => (f.name.includes(' 2.') ? { file: f.name, status: 'skipped', sentNow: false } : sentOutcome(f)),
  });
  const t0 = Date.now();
  const { result } = await run(acts, { delayMs: 700 });
  const ms = Date.now() - t0;
  assert.equal(result.sent, 2); assert.equal(result.skippedAlreadySent, 1);
  assert.ok(ms >= 700, `esperó entre el 1 y el 3: ${ms} ms`);
  assert.ok(ms < 700 * 2 + 1500, `no esperó después del omitido: ${ms} ms`);
  void log;
});

test('un fallo transitorio se reintenta solo', opts, async () => {
  let calls = 0;
  const { acts } = fakeActivities({
    listFiles: async () => ({ files: names(1), ignored: [] }),
    processReceipt: async (_r, f) => {
      if (++calls < 3) throw ApplicationFailure.create({ message: '451 intenta más tarde', type: 'Transient:smtp', nonRetryable: false, details: [{ rowId: '1' }] });
      return sentOutcome(f);
    },
  });
  const { result } = await run(acts);
  assert.equal(calls, 3); assert.equal(result.sent, 1); assert.equal(result.failed, 0);
});

test('API de empleados caída: agota reintentos, aborta tras N fallos seguidos y aun así guarda y reporta', opts, async () => {
  const { acts, log } = fakeActivities({
    listFiles: async () => ({ files: names(6), ignored: [] }),
    processReceipt: async (_r, f) => { log.process.push(f.name); throw ApplicationFailure.create({ message: 'API de empleados respondió 503', type: 'Transient:api', nonRetryable: false, details: [{ rowId: '9' }] }); },
  });
  await assert.rejects(run(acts, { maxApiErrors: 3 }), (e) => /RunAborted|3 fallos consecutivos/.test(String(e.cause?.message ?? e.message) + String(e.cause?.type ?? '')));
  assert.equal(new Set(log.process).size, 3, 'solo se intentaron 3 archivos antes de abortar');
  assert.equal(log.process.length, 9, '3 archivos x 3 intentos');
  assert.equal(log.save.length, 1); assert.equal(log.save[0].aborted, true); assert.match(log.save[0].counters.fatalError, /3 fallos consecutivos/);
  assert.equal(log.report.length, 1, 'el reporte avisa que la ejecución se detuvo');
});

test('envío incierto tras agotar reintentos: queda por revisar y la ejecución continúa', opts, async () => {
  const { acts, log } = fakeActivities({
    listFiles: async () => ({ files: names(2), ignored: [] }),
    processReceipt: async (_r, f) => {
      if (f.name.includes(' 1.')) throw ApplicationFailure.create({ message: 'Resultado incierto: Connection closed unexpectedly', type: 'Transient:smtp:ambiguous', nonRetryable: false, details: [{ rowId: '42' }] });
      return sentOutcome(f);
    },
  });
  const { result } = await run(acts);
  assert.equal(result.uncertain, 1); assert.equal(result.sent, 1); assert.equal(log.uncertain.length, 1); assert.equal(log.uncertain[0][0], '42');
});

test('si el reporte o la verificación fallan, el workflow termina bien y los envíos quedan', opts, async () => {
  const { acts, log } = fakeActivities({
    verifyPending: async () => { throw new Error('Graph caído'); },
    sendReport: async () => { log.report.push('intento'); throw new Error('SMTP caído'); },
  });
  const { result } = await run(acts);
  assert.equal(result.sent, 5); assert.equal(result.verified, 0);
  assert.match(result.report, /^error:/); assert.equal(log.report.length, 2, 'reintentó el reporte según TEMPORAL_REPORT_RETRY_ATTEMPTS');
  assert.equal(log.save[0].aborted, false);
});

test('el Workflow ID fijo impide dos ejecuciones simultáneas', opts, async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { acts } = fakeActivities({ listFiles: async () => { await gate; return { files: [], ignored: [] }; } });
  const taskQueue = `q-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath: WORKFLOWS, activities: acts });
  await worker.runUntil(async () => {
    const start = () => env.client.workflow.start('processReceiptsRun', { taskQueue, workflowId: 'receipts-run-test', args: [{ config: cfg }] });
    const first = await start();
    await assert.rejects(start(), (e) => e.name === 'WorkflowExecutionAlreadyStartedError');
    release();
    await first.result();
  });
});

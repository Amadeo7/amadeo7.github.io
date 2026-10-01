// Este archivo se ejecuta dentro del sandbox determinista de Temporal:
// solo puede importar @temporalio/workflow y código puro (sin Node, sin Nest, sin I/O).
import { ActivityFailure, ApplicationFailure, continueAsNew, proxyActivities, sleep, uuid4 } from '@temporalio/workflow';
import { emptyCounters, RunCounters, tally } from '../../receipts/receipts.types';
import type { ReceiptsActivities, RunInput } from '../activities.types';
import { FAILURE } from '../activities.types';

const MAX_LISTED = 200; // tope de nombres que viajan en el historial; el detalle completo vive en PostgreSQL

/** Proxies de activities con la política de reintentos que llega por configuración (.env). */
function activitiesFor(cfg: RunInput['config']) {
  const backoff = {
    maximumAttempts: cfg.retryAttempts,
    initialInterval: `${cfg.retryInitialSeconds}s`,
    backoffCoefficient: 2,
    maximumInterval: `${cfg.retryMaxSeconds}s`,
  } as const;
  return {
    quick: proxyActivities<ReceiptsActivities>({ startToCloseTimeout: '2 minutes', retry: backoff }),
    // Un archivo = descarga + API + envío SMTP + mover. Es el que se reintenta ante fallos transitorios.
    perFile: proxyActivities<ReceiptsActivities>({ startToCloseTimeout: '3 minutes', retry: backoff }),
    verify: proxyActivities<ReceiptsActivities>({ startToCloseTimeout: '10 minutes', retry: backoff }),
    // El reporte espera más entre intentos: no es urgente y no debe duplicarse
    report: proxyActivities<ReceiptsActivities>({
      startToCloseTimeout: '2 minutes',
      retry: { maximumAttempts: cfg.reportRetryAttempts, initialInterval: `${cfg.reportRetryInitialSeconds}s`, backoffCoefficient: 2, maximumInterval: '10 minutes' },
    }),
  };
}

/** Extrae el tipo y los detalles del fallo que lanzó la activity. */
function describeFailure(err: unknown): { type: string; message: string; rowId?: string } {
  if (err instanceof ActivityFailure && err.cause instanceof ApplicationFailure) {
    const details = (err.cause.details?.[0] ?? {}) as { rowId?: string };
    return { type: err.cause.type ?? 'Error', message: err.cause.message, rowId: details.rowId };
  }
  return { type: 'Error', message: err instanceof Error ? err.message : String(err) };
}

/**
 * Una ejecución completa: un workflow, una activity por archivo (no un workflow por correo).
 * Recorre los archivos en serie, con una pausa durable entre envíos para respetar el límite
 * de Office 365, y cada `batchSize` archivos continúa como nuevo workflow para no acumular historial.
 */
export async function processReceiptsRun(input: RunInput): Promise<RunCounters & { runId: string; report?: string }> {
  const runId = input.runId ?? uuid4();
  const { delayMs, maxApiErrors, batchSize } = input.config;
  const { quick, perFile, verify, report } = activitiesFor(input.config);
  const counters: RunCounters = input.counters ?? emptyCounters();
  let queue = input.queue;
  let apiErrors = input.apiErrors ?? 0;
  let lastWasSend = input.lastWasSend ?? false;

  if (!queue) {
    await quick.startRun(runId);
    const listed = await quick.listFiles();
    queue = listed.files;
    counters.ignoredNames = listed.ignored.slice(0, MAX_LISTED);
    counters.filesFound = listed.files.length + listed.ignored.length;
  }

  let aborted: string | undefined;
  let i = 0;
  while (i < queue.length) {
    if (i >= batchSize) {
      // Historial acotado: sigue como un workflow nuevo con lo que falta
      return continueAsNew<typeof processReceiptsRun>({ ...input, runId, queue: queue.slice(i), counters, apiErrors, lastWasSend });
    }
    const file = queue[i++];
    if (lastWasSend && delayMs > 0) await sleep(delayMs);
    lastWasSend = false;

    try {
      const out = await perFile.processReceipt(runId, file);
      tally(counters, out);
      lastWasSend = out.sentNow;
      apiErrors = 0;
    } catch (err) {
      const f = describeFailure(err);
      if (f.type === FAILURE.smtpAmbiguous) {
        // Se agotaron los reintentos sin saber si salió: queda marcado para revisión humana
        if (f.rowId) await quick.markUncertain(f.rowId, f.message).catch(() => undefined);
        counters.uncertain++;
      } else {
        tally(counters, { file: file.name, status: 'failed', error: f.message, sentNow: false, unrecorded: !f.rowId });
      }
      if (counters.unrecorded.length > MAX_LISTED) counters.unrecorded.length = MAX_LISTED;
      if (f.type === FAILURE.api && ++apiErrors >= maxApiErrors) {
        aborted = `${f.message} (${apiErrors} fallos consecutivos)`;
        break;
      }
    }
  }

  if (aborted) counters.fatalError = aborted;
  try {
    counters.verified = await verify.verifyPending();
  } catch {
    // La verificación es opcional: si falla, no invalida los envíos
  }
  await quick.saveRun(runId, counters, !!aborted);

  let reportResult: string;
  try {
    reportResult = await report.sendReport(runId);
  } catch (err) {
    reportResult = `error: ${describeFailure(err).message}`; // el reporte nunca invalida los envíos
  }

  if (aborted) throw ApplicationFailure.nonRetryable(aborted, 'RunAborted');
  return { ...counters, runId, report: reportResult };
}

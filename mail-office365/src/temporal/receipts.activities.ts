import { ApplicationFailure } from '@temporalio/activity';
import { ReceiptsRepository } from '../receipts/receipts.repository';
import { ReceiptsService } from '../receipts/receipts.service';
import { TransientError } from '../receipts/receipts.types';
import { ReportService } from '../receipts/report.service';
import { FAILURE, ReceiptsActivities } from './activities.types';

/** Traduce nuestros errores transitorios a fallos que el workflow puede distinguir. */
function toFailure(e: unknown): unknown {
  if (!(e instanceof TransientError)) return e;
  const type = e.kind === 'smtp' && e.opts.ambiguous ? FAILURE.smtpAmbiguous : FAILURE[e.kind];
  return ApplicationFailure.create({ message: e.message, type, nonRetryable: false, details: [{ rowId: e.opts.rowId, file: e.opts.file }] });
}

/** Activities: aquí vive todo el I/O (SFTP, API, SMTP, PostgreSQL, Graph). */
export function createActivities(svc: ReceiptsService, repo: ReceiptsRepository, report: ReportService): ReceiptsActivities {
  return {
    startRun: (runId) => svc.startRun(runId),
    listFiles: async () => {
      try {
        return await svc.listFiles();
      } catch (e) {
        throw toFailure(e);
      }
    },
    processReceipt: async (runId, file) => {
      try {
        return await svc.processFile(runId, file);
      } catch (e) {
        throw toFailure(e);
      }
    },
    markUncertain: (rowId, note) => repo.markUncertain(rowId, note),
    verifyPending: () => svc.verifyPending(),
    saveRun: (runId, counters, aborted) => repo.finishRun(runId, aborted ? 'aborted' : 'completed', counters),
    sendReport: async (runId) => {
      const r = await report.sendRunReport(runId); // lanza si falla: Temporal reintenta
      return r.sent ? 'enviado' : r.reason;
    },
  };
}

import type { FileItem, FileOutcome, RunCounters } from '../receipts/receipts.types';

/** Contrato entre el workflow (determinista) y las activities (todo el I/O). Solo viajan datos pequeños, nunca PDFs. */
export interface ReceiptsActivities {
  startRun(runId: string): Promise<void>;
  listFiles(): Promise<{ files: FileItem[]; ignored: string[] }>;
  processReceipt(runId: string, file: FileItem): Promise<FileOutcome>;
  markUncertain(rowId: string, note: string): Promise<void>;
  verifyPending(): Promise<number>;
  saveRun(runId: string, counters: RunCounters, aborted: boolean): Promise<void>;
  sendReport(runId: string): Promise<string>;
}

/** Tipos de fallo que las activities devuelven al workflow en ApplicationFailure.type */
export const FAILURE = {
  api: 'Transient:api',
  sftp: 'Transient:sftp',
  smtp: 'Transient:smtp',
  smtpAmbiguous: 'Transient:smtp:ambiguous',
} as const;

export interface RunInput {
  /** Si se omite, el workflow genera uno. Se conserva entre continueAsNew. */
  runId?: string;
  /** Archivos pendientes (solo en continuaciones). */
  queue?: FileItem[];
  counters?: RunCounters;
  apiErrors?: number;
  lastWasSend?: boolean;
  /** Valores de configuración: el workflow no puede leer variables de entorno. */
  config: {
    delayMs: number;
    maxApiErrors: number;
    batchSize: number;
    /** Reintentos de cada activity ante fallos transitorios */
    retryAttempts: number;
    retryInitialSeconds: number;
    retryMaxSeconds: number;
    /** El reporte espera más entre intentos para no duplicarse */
    reportRetryAttempts: number;
    reportRetryInitialSeconds: number;
  };
}

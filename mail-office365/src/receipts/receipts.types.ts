export interface FileItem {
  name: string;
  size: number;
}

export type FileStatus = 'sent' | 'recovered' | 'skipped' | 'failed' | 'uncertain';

/** Resultado definitivo de procesar un archivo. */
export interface FileOutcome {
  file: string;
  status: FileStatus;
  employeeName?: string;
  error?: string;
  /** Se hizo un envío SMTP real en este intento (sirve para espaciar los envíos). */
  sentNow: boolean;
  /** No quedó registro en la base (p. ej. no se pudo ni descargar); se reporta aparte. */
  unrecorded?: boolean;
}

/** Fallo de infraestructura que conviene reintentar (SFTP, API de empleados, SMTP). */
export class TransientError extends Error {
  constructor(
    readonly kind: 'sftp' | 'api' | 'smtp',
    message: string,
    readonly opts: { ambiguous?: boolean; rowId?: string; file?: string } = {},
  ) {
    super(message);
    this.name = 'TransientError';
  }
}

export interface RunCounters {
  filesFound: number;
  sent: number;
  recovered: number;
  skippedAlreadySent: number;
  failed: number;
  uncertain: number;
  verified: number;
  ignoredNames: string[];
  /** Archivos que fallaron sin dejar registro en la base */
  unrecorded: { file: string; error: string }[];
  fatalError?: string;
}

export const emptyCounters = (): RunCounters => ({
  filesFound: 0,
  sent: 0,
  recovered: 0,
  skippedAlreadySent: 0,
  failed: 0,
  uncertain: 0,
  verified: 0,
  ignoredNames: [],
  unrecorded: [],
});

/** Suma el resultado de un archivo a los contadores de la ejecución. */
export function tally(c: RunCounters, o: FileOutcome) {
  if (o.status === 'sent') c.sent++;
  else if (o.status === 'recovered') c.recovered++;
  else if (o.status === 'skipped') c.skippedAlreadySent++;
  else if (o.status === 'uncertain') c.uncertain++;
  else c.failed++;
  if (o.unrecorded && o.error) c.unrecorded.push({ file: o.file, error: o.error });
}

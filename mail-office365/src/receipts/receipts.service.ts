import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { EmployeeApiError, EmployeeLookup, EmployeesService } from '../employees/employees.service';
import { GraphVerifierService } from '../mail/graph-verifier.service';
import { classifySmtpError, MailService, stableMessageId } from '../mail/mail.service';
import { ReceiptEmailTemplate } from '../mail/receipt-email.template';
import { SftpService, SftpSession } from '../sftp/sftp.service';
import { compileReceiptRegex, DEFAULT_RECEIPT_FILENAME_REGEX, parseReceiptFilename } from './parse-receipt-filename';
import { ReceiptRow, ReceiptsRepository } from './receipts.repository';
import { emptyCounters, FileItem, FileOutcome, RunCounters, tally, TransientError } from './receipts.types';
import { ReportService } from './report.service';

export interface RunSummary extends RunCounters {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  verificationEnabled: boolean;
  /** Qué pasó con el correo de reporte */
  report?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Detiene toda la ejecución (p. ej. la API de empleados está caída). */
class RunAborted extends Error {}

/**
 * Lógica de negocio. La usan dos orquestadores: el bucle en proceso (run) y, si TEMPORAL_ENABLED=true,
 * las activities de Temporal, que llaman a listFiles / processFile / verifyPending / finishRun.
 */
@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);
  private running = false;
  private readonly filenameRe: RegExp;

  constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly employees: EmployeesService,
    private readonly mail: MailService,
    private readonly verifier: GraphVerifierService,
    private readonly repo: ReceiptsRepository,
    private readonly template: ReceiptEmailTemplate,
    private readonly report: ReportService,
  ) {
    this.filenameRe = compileReceiptRegex(config.get('RECEIPT_FILENAME_REGEX', DEFAULT_RECEIPT_FILENAME_REGEX));
  }

  get isRunning() {
    return this.running;
  }

  // ===================================================================== listado

  /** Separa los archivos de la carpeta entre recibos válidos y archivos ajenos al formato. */
  async listFiles(session?: SftpSession): Promise<{ files: FileItem[]; ignored: string[] }> {
    const own = !session;
    const s = session ?? (await this.openSftp());
    try {
      const all = await s.listFiles();
      return {
        files: all.filter((f) => parseReceiptFilename(f.name, this.filenameRe)),
        ignored: all.filter((f) => !parseReceiptFilename(f.name, this.filenameRe)).map((f) => f.name),
      };
    } finally {
      if (own) await s.close();
    }
  }

  private async openSftp(): Promise<SftpSession> {
    try {
      return await this.sftp.open();
    } catch (e) {
      throw new TransientError('sftp', `No se pudo conectar al SFTP: ${msg(e)}`);
    }
  }

  // ================================================================ un archivo

  /**
   * Procesa un archivo de principio a fin. Devuelve su resultado definitivo o lanza TransientError
   * si el fallo es de infraestructura y conviene reintentar.
   */
  async processFile(runId: string, file: FileItem, ctx: { session?: SftpSession; lookup?: EmployeeLookup } = {}): Promise<FileOutcome> {
    const own = !ctx.session;
    const session = ctx.session ?? (await this.openSftp());
    try {
      return await this.processWith(runId, file, session, ctx.lookup ?? this.employees.lookup());
    } finally {
      if (own) await session.close();
    }
  }

  private async processWith(runId: string, file: FileItem, session: SftpSession, lookup: EmployeeLookup): Promise<FileOutcome> {
    const code = parseReceiptFilename(file.name, this.filenameRe);
    const fail = (error: string, unrecorded = false): FileOutcome => ({ file: file.name, status: 'failed', error, sentNow: false, unrecorded });
    if (!code) return fail('El nombre no cumple el formato', true);

    const maxBytes = Number(this.config.get('MAX_PDF_MB', 10)) * 1024 * 1024;
    if (file.size > maxBytes) return fail(`El PDF excede ${maxBytes / 1048576} MB`, true);

    let content: Buffer;
    try {
      content = await session.download(file.name);
    } catch (e) {
      throw new TransientError('sftp', `No se pudo descargar ${file.name}: ${msg(e)}`, { file: file.name });
    }

    const sha = createHash('sha256').update(content).digest('hex');
    const row = await this.repo.findOrCreate(file.name, sha, code);
    if (row.status === 'sent') {
      await this.archive(session, row.id, file.name, sha);
      return { file: file.name, status: 'skipped', employeeName: row.employee_name ?? undefined, sentNow: false };
    }
    await this.repo.claimForRun(row.id, runId);

    const reject = async (error: string, countAttempt = false): Promise<FileOutcome> => {
      await this.repo.markFailed(row.id, error, countAttempt);
      return { file: file.name, status: 'failed', employeeName: row.employee_name ?? undefined, error, sentNow: false };
    };

    if (content.subarray(0, 5).toString() !== '%PDF-') return reject('El archivo no es un PDF válido');

    // Un intento anterior quedó a medias: se averigua si el correo salió antes de decidir nada
    if (row.status === 'sending' || row.status === 'uncertain') {
      const verdict = await this.resolveInFlight(row);
      if (verdict === 'sent') {
        await this.repo.markRecovered(row.id);
        await this.archive(session, row.id, file.name, sha);
        return { file: file.name, status: 'recovered', employeeName: row.employee_name ?? undefined, sentNow: false };
      }
      if (verdict === 'uncertain') {
        const note = this.verifier.enabled
          ? 'No aparece en Elementos enviados todavía; puede haber salido. Revisa antes de reenviar.'
          : 'Un envío anterior quedó a medias y no se puede comprobar (Graph no configurado). Revisa antes de reenviar.';
        await this.repo.markUncertain(row.id, note);
        return { file: file.name, status: 'uncertain', employeeName: row.employee_name ?? undefined, error: note, sentNow: false };
      }
      // verdict === 'resend': pasó la ventana y no hay rastro del correo
    }

    let employee;
    try {
      employee = await lookup.find(code);
    } catch (e) {
      if (!(e instanceof EmployeeApiError)) throw e;
      // La API no respondió: no es culpa del empleado, se reintenta
      await this.repo.markFailed(row.id, e.message, false);
      throw new TransientError('api', e.message, { rowId: row.id, file: file.name });
    }
    if (!employee) return reject(`Empleado ${code} no encontrado en la API`);
    await this.repo.setEmployee(row.id, employee.name, employee.email);
    row.employee_name = employee.name;
    if (!EMAIL_RE.test(employee.email)) return reject(`Empleado ${code} sin correo válido`);

    // Se anota ANTES de enviar, con un Message-ID que no cambia entre reintentos
    const messageId = stableMessageId('receipt', `${code}-${sha.slice(0, 16)}`, this.mail.domain);
    await this.repo.markSending(row.id, messageId);
    const { html, text } = this.template.render(employee.name);
    try {
      await this.mail.send({
        to: employee.email,
        subject: this.config.get('MAIL_SUBJECT', 'Tu recibo de pago'),
        html,
        text,
        attachment: { filename: file.name, content },
        messageId,
      });
    } catch (e) {
      const kind = classifySmtpError(e);
      if (kind === 'ambiguous') {
        // Se cortó a mitad del envío: el estado queda en "sending" y el siguiente intento lo averigua
        throw new TransientError('smtp', `Resultado incierto: ${msg(e)}`, { ambiguous: true, rowId: row.id, file: file.name });
      }
      const failed = await reject(msg(e), true);
      if (kind === 'definite_transient') throw new TransientError('smtp', msg(e), { rowId: row.id, file: file.name });
      return failed;
    }

    await this.repo.markSent(row.id);
    await this.archive(session, row.id, file.name, sha);
    return { file: file.name, status: 'sent', employeeName: employee.name, sentNow: true };
  }

  /**
   * ¿Salió el correo de un intento que quedó a medias?
   * 'sent' = está en Elementos enviados | 'uncertain' = no se sabe (no se reenvía) | 'resend' = pasó la ventana sin rastro.
   */
  private async resolveInFlight(row: ReceiptRow): Promise<'sent' | 'uncertain' | 'resend'> {
    if (!this.verifier.enabled || !row.message_id) return 'uncertain';
    try {
      if (await this.verifier.isInSentItems(row.message_id)) return 'sent';
    } catch (e) {
      this.logger.warn(`No se pudo consultar Graph para ${row.file_name}: ${msg(e)}`);
      return 'uncertain';
    }
    const windowMin = Number(this.config.get('UNCERTAIN_WINDOW_MIN', 10));
    return Number(row.in_flight_minutes ?? 0) >= windowMin ? 'resend' : 'uncertain';
  }

  /** Mueve el PDF a la carpeta de procesados y guarda la ruta. Un fallo aquí no invalida el envío. */
  private async archive(session: SftpSession, id: string, name: string, sha: string) {
    try {
      await this.repo.setProcessedPath(id, await session.archive(name, sha));
    } catch (e) {
      this.logger.warn(`No se pudo mover ${name} a procesados: ${msg(e)}`);
    }
  }

  // ============================================================== verificación

  /** Revisa en "Elementos enviados" los correos enviados que aún no están verificados. */
  async verifyPending(): Promise<number> {
    if (!this.verifier.enabled) return 0;
    const maxAttempts = Number(this.config.get('VERIFY_MAX_ATTEMPTS', 5));
    const pending = await this.repo.listUnverified(maxAttempts, Number(this.config.get('VERIFY_BATCH_SIZE', 500)));
    let verified = 0;
    for (const row of pending) {
      try {
        if (await this.verifier.isInSentItems(row.message_id!)) {
          await this.repo.markVerified(row.id, 'Encontrado en Elementos enviados');
          verified++;
        } else {
          await this.repo.markVerifyAttempt(row.id, 'Aún no aparece en Elementos enviados');
        }
      } catch (e) {
        await this.repo.markVerifyAttempt(row.id, `Error al verificar: ${msg(e)}`);
        this.logger.warn(`Verificación ${row.file_name}: ${msg(e)}`);
      }
    }
    return verified;
  }

  // ================================================================== ejecución

  async startRun(runId: string) {
    await this.repo.startRun(runId);
  }

  /** Cierra la ejecución: guarda el resumen y envía el reporte. El reporte nunca invalida los envíos. */
  async finishRun(runId: string, counters: RunCounters, aborted: boolean): Promise<string> {
    await this.repo.finishRun(runId, aborted ? 'aborted' : 'completed', counters);
    try {
      const r = await this.report.sendRunReport(runId);
      return r.sent ? 'enviado' : r.reason;
    } catch (e) {
      this.logger.error(`No se pudo enviar el reporte: ${msg(e)}`);
      return `error: ${msg(e)}`;
    }
  }

  /** Orquestador en proceso: recorre todos los archivos en serie. */
  async run(opts: { runId?: string } = {}): Promise<RunSummary> {
    if (this.running) throw new ConflictException('Ya hay un proceso en ejecución');
    this.running = true;
    const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, '-');
    const counters = emptyCounters();
    const summary: RunSummary = Object.assign(counters, {
      runId,
      startedAt: new Date().toISOString(),
      verificationEnabled: this.verifier.enabled,
    }) as RunSummary;
    let fatal: unknown;

    try {
      await this.repo.startRun(runId);
      const lookup = this.employees.lookup();
      const maxApiErrors = Number(this.config.get('EMPLOYEES_API_MAX_CONSECUTIVE_ERRORS', 5));
      const delay = Number(this.config.get('SEND_DELAY_MS', 2500));
      let apiErrors = 0;
      let lastWasSend = false;

      const session = await this.openSftp();
      try {
        const { files, ignored } = await this.listFiles(session);
        counters.filesFound = files.length + ignored.length;
        counters.ignoredNames = ignored;

        for (const file of files) {
          if (lastWasSend && delay > 0) await sleep(delay); // Office 365 limita ~30 correos/min
          try {
            const out = await this.processFile(runId, file, { session, lookup });
            tally(counters, out);
            lastWasSend = out.sentNow;
            apiErrors = 0;
          } catch (e) {
            lastWasSend = false;
            if (!(e instanceof TransientError)) {
              // Error inesperado en un archivo: se registra y se sigue con el resto
              tally(counters, { file: file.name, status: 'failed', error: msg(e), sentNow: false, unrecorded: true });
              this.logger.error(`${file.name}: ${msg(e)}`);
              continue;
            }
            this.logger.error(`${file.name}: ${e.message}`);
            if (e.opts.ambiguous) {
              if (e.opts.rowId) await this.repo.markUncertain(e.opts.rowId, e.message);
              counters.uncertain++;
            } else {
              tally(counters, { file: file.name, status: 'failed', error: e.message, sentNow: false, unrecorded: !e.opts.rowId });
            }
            if (e.kind === 'api' && ++apiErrors >= maxApiErrors) {
              throw new RunAborted(`${e.message} (${apiErrors} fallos consecutivos)`);
            }
          }
        }
      } finally {
        await session.close();
      }
    } catch (e) {
      fatal = e;
      counters.fatalError = msg(e);
    }

    try {
      counters.verified = await this.verifyPending();
    } catch (e) {
      this.logger.warn(`Verificación fallida: ${msg(e)}`);
    }
    summary.finishedAt = new Date().toISOString();
    summary.report = await this.finishRun(runId, counters, !!fatal);
    this.running = false;
    if (fatal) throw fatal;
    return summary;
  }
}

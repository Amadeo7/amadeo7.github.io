import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { GraphVerifierService } from '../mail/graph-verifier.service';
import { MailService } from '../mail/mail.service';
import { ReceiptEmailTemplate } from '../mail/receipt-email.template';
import { EmployeesService } from '../employees/employees.service';
import { SftpService, SftpSession } from '../sftp/sftp.service';
import { compileReceiptRegex, DEFAULT_RECEIPT_FILENAME_REGEX, parseReceiptFilename } from './parse-receipt-filename';
import { ReceiptsRepository } from './receipts.repository';

export interface RunSummary {
  startedAt: string;
  finishedAt?: string;
  filesFound: number;
  sent: number;
  skippedAlreadySent: number;
  failed: number;
  ignoredNames: string[];
  errors: { file: string; error: string }[];
  verified: number;
  verificationEnabled: boolean;
  /** Error que abortó toda la ejecución (API de empleados, SFTP, etc.) */
  fatalError?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);
  private running = false;
  lastRun?: RunSummary;
  private readonly filenameRe: RegExp;

  constructor(
    private readonly config: ConfigService,
    private readonly sftp: SftpService,
    private readonly employees: EmployeesService,
    private readonly mail: MailService,
    private readonly verifier: GraphVerifierService,
    private readonly repo: ReceiptsRepository,
    private readonly template: ReceiptEmailTemplate,
  ) {
    this.filenameRe = compileReceiptRegex(config.get('RECEIPT_FILENAME_REGEX', DEFAULT_RECEIPT_FILENAME_REGEX));
  }

  get isRunning() {
    return this.running;
  }

  async run(): Promise<RunSummary> {
    if (this.running) throw new ConflictException('Ya hay un proceso en ejecución');
    this.running = true;
    const summary: RunSummary = {
      startedAt: new Date().toISOString(),
      filesFound: 0,
      sent: 0,
      skippedAlreadySent: 0,
      failed: 0,
      ignoredNames: [],
      errors: [],
      verified: 0,
      verificationEnabled: this.verifier.enabled,
    };
    this.lastRun = summary;

    try {
      // Si la API falla no se toca nada: no se envía ni se marca ningún archivo
      const directory = await this.employees.load();
      const session = await this.sftp.open();
      try {
        const files = await session.listFiles();
        summary.filesFound = files.length;
        const maxBytes = Number(this.config.get('MAX_PDF_MB', 10)) * 1024 * 1024;
        const delay = Number(this.config.get('SEND_DELAY_MS', 2500));
        const subject = this.config.get('MAIL_SUBJECT', 'Tu recibo de pago');

        let sentThisRun = 0;
        for (const file of files) {
          const code = parseReceiptFilename(file.name, this.filenameRe);
          if (!code) {
            summary.ignoredNames.push(file.name);
            continue;
          }

          let rowId: string | undefined;
          try {
            if (file.size > maxBytes) throw new Error(`El PDF excede ${maxBytes / 1048576} MB`);
            const content = await session.download(file.name);
            if (content.subarray(0, 5).toString() !== '%PDF-') throw new Error('El archivo no es un PDF válido');

            const sha = createHash('sha256').update(content).digest('hex');
            const row = await this.repo.findOrCreate(file.name, sha, code);
            rowId = row.id;
            if (row.status === 'sent') {
              summary.skippedAlreadySent++;
              await this.archive(session, row.id, file.name, sha);
              continue;
            }

            const employee = directory.find(code);
            if (!employee) throw new NoSend(`Empleado ${code} no encontrado en la API`);
            await this.repo.setEmployee(row.id, employee.name, employee.email);
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(employee.email)) {
              throw new NoSend(`Empleado ${code} sin correo válido`);
            }

            if (sentThisRun > 0 && delay > 0) await sleep(delay); // Office 365 limita ~30 correos/min
            const { html, text } = this.template.render(employee.name);
            const { messageId } = await this.mail.send({
              to: employee.email,
              subject,
              html,
              text,
              attachment: { filename: file.name, content },
            });
            sentThisRun++;
            await this.repo.markSent(row.id, messageId);
            summary.sent++;
            await this.archive(session, row.id, file.name, sha);
          } catch (e) {
            summary.failed++;
            summary.errors.push({ file: file.name, error: msg(e) });
            this.logger.error(`${file.name}: ${msg(e)}`);
            if (rowId) await this.repo.markFailed(rowId, msg(e), !(e instanceof NoSend)).catch(() => undefined);
          }
        }
      } finally {
        await session.close();
      }

      summary.verified = await this.verifyPending();
      return summary;
    } catch (e) {
      summary.fatalError = msg(e);
      throw e;
    } finally {
      summary.finishedAt = new Date().toISOString();
      this.running = false;
    }
  }

  /** Mueve el PDF a la carpeta de procesados y guarda la ruta. Un fallo aquí no invalida el envío. */
  private async archive(session: SftpSession, id: string, name: string, sha: string) {
    try {
      await this.repo.setProcessedPath(id, await session.archive(name, sha));
    } catch (e) {
      this.logger.warn(`No se pudo mover ${name} a procesados: ${msg(e)}`);
    }
  }

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
}

/** Fallo de datos (no se llegó a enviar): no cuenta como intento de envío. */
class NoSend extends Error {}

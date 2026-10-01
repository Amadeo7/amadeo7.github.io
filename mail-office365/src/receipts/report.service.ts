import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GraphVerifierService } from '../mail/graph-verifier.service';
import { MailService, stableMessageId } from '../mail/mail.service';
import { buildRunReport } from './report.template';
import { ReceiptsRepository } from './receipts.repository';

export type ReportResult = { sent: true; messageId: string } | { sent: false; reason: string };

const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Correo final con lo enviado (con nombres de empleados) y lo que falló. */
@Injectable()
export class ReportService {
  private readonly logger = new Logger(ReportService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly verifier: GraphVerifierService,
    private readonly repo: ReceiptsRepository,
  ) {}

  /** Envía el reporte de una ejecución, una sola vez. Lanza error si el envío falla (el llamador decide). */
  async sendRunReport(runId: string): Promise<ReportResult> {
    const to = list(this.config.get('REPORT_TO'));
    if (to.length === 0) return { sent: false, reason: 'REPORT_TO vacío: reporte desactivado' };

    const run = await this.repo.getRun(runId);
    if (run?.report_sent_at) return { sent: false, reason: 'El reporte de esta ejecución ya se envió' };

    const messageId = stableMessageId('report', runId, this.mail.domain);
    // Un intento anterior pudo haber salido sin que lo supiéramos: se comprueba antes de reenviar
    if (run?.report_error && this.verifier.enabled) {
      try {
        if (await this.verifier.isInSentItems(messageId)) {
          await this.repo.markReportSent(runId, messageId);
          return { sent: true, messageId };
        }
      } catch (e) {
        this.logger.warn(`No se pudo comprobar un reporte anterior: ${(e as Error).message}`);
      }
    }

    const { subject, html, text } = buildRunReport({
      runId,
      title: this.config.get('REPORT_SUBJECT', 'Reporte de envío de recibos'),
      company: this.config.get('COMPANY_NAME'),
      startedAt: run?.started_at ?? new Date(),
      finishedAt: run?.finished_at,
      timeZone: this.config.get('TZ'),
      counters: run?.summary ?? {},
      rows: await this.repo.rowsForRun(runId),
      includeEmail: this.config.get('REPORT_INCLUDE_EMAIL', 'true') === 'true',
    });

    try {
      await this.mail.send({ to, cc: list(this.config.get('REPORT_CC')), subject, html, text, messageId });
    } catch (e) {
      await this.repo.markReportError(runId, (e as Error).message);
      throw e;
    }
    await this.repo.markReportSent(runId, messageId);
    return { sent: true, messageId };
  }
}

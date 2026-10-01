import { Injectable } from '@nestjs/common';
import { QueryResultRow } from 'pg';
import { DbService } from '../db/db.service';
import { RunCounters } from './receipts.types';

export type ReceiptStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain';

export interface ReceiptRow {
  id: string;
  file_name: string;
  file_sha256: string;
  employee_code: string | null;
  employee_name: string | null;
  to_email: string | null;
  status: ReceiptStatus;
  attempts: number;
  message_id: string | null;
  sent_at: Date | null;
  verified: boolean;
  verified_at: Date | null;
  verify_attempts: number;
  verification_note: string | null;
  error: string | null;
  processed_path: string | null;
  run_id: string | null;
  attempt_started_at: Date | null;
  /** Minutos desde que se inició el último intento de envío (calculado en la base). */
  in_flight_minutes: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface RunRow {
  run_id: string;
  status: 'running' | 'completed' | 'aborted';
  started_at: Date;
  finished_at: Date | null;
  summary: Partial<RunCounters>;
  report_sent_at: Date | null;
  report_message_id: string | null;
  report_error: string | null;
}

@Injectable()
export class ReceiptsRepository {
  constructor(private readonly db: DbService) {}

  private get t() {
    return this.db.table;
  }
  private q<T extends QueryResultRow = any>(sql: string, params: unknown[] = []) {
    return this.db.pool.query<T>(sql, params);
  }

  // ---------------------------------------------------------------- recibos

  /** Devuelve el registro del archivo (nombre + contenido); lo crea como "pending" si no existe. */
  async findOrCreate(fileName: string, sha256: string, code: string): Promise<ReceiptRow> {
    const { rows } = await this.q<ReceiptRow>(
      `INSERT INTO ${this.t} (file_name, file_sha256, employee_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (file_name, file_sha256) DO UPDATE SET updated_at = now()
       RETURNING *, EXTRACT(EPOCH FROM (now() - attempt_started_at)) / 60 AS in_flight_minutes`,
      [fileName, sha256, code],
    );
    return rows[0];
  }

  /** Asocia el registro a la ejecución que lo está procesando (para el reporte). */
  async claimForRun(id: string, runId: string) {
    await this.q(`UPDATE ${this.t} SET run_id = $2, updated_at = now() WHERE id = $1`, [id, runId]);
  }

  async setEmployee(id: string, name: string, email: string) {
    await this.q(`UPDATE ${this.t} SET employee_name = $2, to_email = $3, updated_at = now() WHERE id = $1`, [id, name, email]);
  }

  /** Se anota ANTES de enviar. Si el proceso muere a mitad, queda constancia de que pudo haber salido. */
  async markSending(id: string, messageId: string) {
    await this.q(
      `UPDATE ${this.t}
          SET status = 'sending', message_id = $2, attempt_started_at = now(), error = NULL, updated_at = now()
        WHERE id = $1`,
      [id, messageId],
    );
  }

  async markSent(id: string) {
    await this.q(
      `UPDATE ${this.t}
          SET status = 'sent', sent_at = now(), error = NULL, attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  /** El correo ya estaba en Elementos enviados: se recupera sin reenviar y queda verificado. */
  async markRecovered(id: string) {
    await this.q(
      `UPDATE ${this.t}
          SET status = 'sent', sent_at = COALESCE(sent_at, now()), error = NULL, attempts = attempts + 1,
              verified = TRUE, verified_at = now(), verification_note = 'Recuperado: ya estaba en Elementos enviados',
              updated_at = now()
        WHERE id = $1`,
      [id],
    );
  }

  async markUncertain(id: string, note: string) {
    await this.q(`UPDATE ${this.t} SET status = 'uncertain', error = $2, updated_at = now() WHERE id = $1`, [id, note.slice(0, 1000)]);
  }

  async markFailed(id: string, error: string, countAttempt: boolean) {
    await this.q(
      `UPDATE ${this.t}
          SET status = 'failed', error = $2, attempts = attempts + $3, updated_at = now()
        WHERE id = $1`,
      [id, error.slice(0, 1000), countAttempt ? 1 : 0],
    );
  }

  async setProcessedPath(id: string, path: string) {
    await this.q(`UPDATE ${this.t} SET processed_path = $2, updated_at = now() WHERE id = $1`, [id, path]);
  }

  /** Resolución manual de un envío incierto. Devuelve false si no estaba en un estado que lo permita. */
  async resolve(id: string, action: 'resend' | 'mark_sent'): Promise<boolean> {
    const sql =
      action === 'resend'
        ? `UPDATE ${this.t} SET status = 'failed', error = 'Reenvío autorizado manualmente', attempt_started_at = NULL, updated_at = now()
            WHERE id = $1 AND status IN ('uncertain', 'sending')`
        : `UPDATE ${this.t} SET status = 'sent', sent_at = COALESCE(sent_at, now()), error = NULL, attempts = attempts + 1, updated_at = now()
            WHERE id = $1 AND status IN ('uncertain', 'sending')`;
    return ((await this.q(sql, [id])).rowCount ?? 0) > 0;
  }

  // ----------------------------------------------------------- verificación

  /** Correos enviados que aún no se han podido verificar. */
  async listUnverified(maxVerifyAttempts: number, limit: number): Promise<ReceiptRow[]> {
    const { rows } = await this.q<ReceiptRow>(
      `SELECT * FROM ${this.t}
        WHERE status = 'sent' AND verified = FALSE AND verify_attempts < $1 AND message_id IS NOT NULL
        ORDER BY sent_at LIMIT $2`,
      [maxVerifyAttempts, limit],
    );
    return rows;
  }

  async markVerified(id: string, note: string) {
    await this.q(
      `UPDATE ${this.t}
          SET verified = TRUE, verified_at = now(), verification_note = $2,
              verify_attempts = verify_attempts + 1, updated_at = now()
        WHERE id = $1`,
      [id, note],
    );
  }

  async markVerifyAttempt(id: string, note: string) {
    await this.q(
      `UPDATE ${this.t} SET verify_attempts = verify_attempts + 1, verification_note = $2, updated_at = now() WHERE id = $1`,
      [id, note.slice(0, 500)],
    );
  }

  // ---------------------------------------------------------------- consulta

  async list(filter: { status?: string; verified?: boolean; runId?: string }, limit: number): Promise<ReceiptRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (cond: string, v: unknown) => {
      params.push(v);
      where.push(cond.replace('$?', `$${params.length}`));
    };
    if (filter.status) add('status = $?', filter.status);
    if (filter.verified !== undefined) add('verified = $?', filter.verified);
    if (filter.runId) add('run_id = $?', filter.runId);
    params.push(limit);
    const { rows } = await this.q<ReceiptRow>(
      `SELECT id, file_name, employee_code, employee_name, to_email, status, attempts, message_id,
              sent_at, verified, verified_at, verify_attempts, verification_note, error, processed_path,
              run_id, created_at, updated_at
         FROM ${this.t}
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  }

  /** Todo lo que se tocó en una ejecución, para el reporte. */
  async rowsForRun(runId: string): Promise<ReceiptRow[]> {
    const { rows } = await this.q<ReceiptRow>(
      `SELECT * FROM ${this.t} WHERE run_id = $1 ORDER BY employee_name NULLS LAST, file_name, id`,
      [runId],
    );
    return rows;
  }

  // ------------------------------------------------------------- ejecuciones

  async startRun(runId: string) {
    await this.q(`INSERT INTO ${this.t}_runs (run_id) VALUES ($1) ON CONFLICT (run_id) DO NOTHING`, [runId]);
  }

  async finishRun(runId: string, status: 'completed' | 'aborted', summary: Partial<RunCounters>) {
    await this.q(
      `INSERT INTO ${this.t}_runs (run_id, status, finished_at, summary) VALUES ($1, $2, now(), $3)
       ON CONFLICT (run_id) DO UPDATE SET status = $2, finished_at = now(), summary = $3`,
      [runId, status, JSON.stringify(summary)],
    );
  }

  async getRun(runId: string): Promise<RunRow | null> {
    const { rows } = await this.q<RunRow>(`SELECT * FROM ${this.t}_runs WHERE run_id = $1`, [runId]);
    return rows[0] ?? null;
  }

  async lastRun(): Promise<RunRow | null> {
    const { rows } = await this.q<RunRow>(`SELECT * FROM ${this.t}_runs ORDER BY started_at DESC LIMIT 1`);
    return rows[0] ?? null;
  }

  async markReportSent(runId: string, messageId: string) {
    await this.q(`UPDATE ${this.t}_runs SET report_sent_at = now(), report_message_id = $2, report_error = NULL WHERE run_id = $1`, [runId, messageId]);
  }

  async markReportError(runId: string, error: string) {
    await this.q(`UPDATE ${this.t}_runs SET report_error = $2 WHERE run_id = $1`, [runId, error.slice(0, 500)]);
  }
}

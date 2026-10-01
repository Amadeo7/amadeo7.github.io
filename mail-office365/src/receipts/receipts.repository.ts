import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

export interface ReceiptRow {
  id: string;
  file_name: string;
  file_sha256: string;
  employee_code: string | null;
  employee_name: string | null;
  to_email: string | null;
  status: 'pending' | 'sent' | 'failed';
  attempts: number;
  message_id: string | null;
  sent_at: Date | null;
  verified: boolean;
  verified_at: Date | null;
  verify_attempts: number;
  verification_note: string | null;
  error: string | null;
  processed_path: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class ReceiptsRepository {
  constructor(private readonly db: DbService) {}

  /** Devuelve el registro del archivo (nombre + contenido); lo crea como "pending" si no existe. */
  async findOrCreate(fileName: string, sha256: string, code: string): Promise<ReceiptRow> {
    const { rows } = await this.db.pool.query<ReceiptRow>(
      `INSERT INTO ${this.db.table} (file_name, file_sha256, employee_code)
       VALUES ($1, $2, $3)
       ON CONFLICT (file_name, file_sha256) DO UPDATE SET updated_at = now()
       RETURNING *`,
      [fileName, sha256, code],
    );
    return rows[0];
  }

  async setEmployee(id: string, name: string, email: string) {
    await this.db.pool.query(
      `UPDATE ${this.db.table} SET employee_name = $2, to_email = $3, updated_at = now() WHERE id = $1`,
      [id, name, email],
    );
  }

  async markSent(id: string, messageId: string) {
    await this.db.pool.query(
      `UPDATE ${this.db.table}
          SET status = 'sent', message_id = $2, sent_at = now(), error = NULL,
              attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [id, messageId],
    );
  }

  async setProcessedPath(id: string, path: string) {
    await this.db.pool.query(
      `UPDATE ${this.db.table} SET processed_path = $2, updated_at = now() WHERE id = $1`,
      [id, path],
    );
  }

  async markFailed(id: string, error: string, countAttempt: boolean) {
    await this.db.pool.query(
      `UPDATE ${this.db.table}
          SET status = 'failed', error = $2,
              attempts = attempts + $3, updated_at = now()
        WHERE id = $1`,
      [id, error.slice(0, 1000), countAttempt ? 1 : 0],
    );
  }

  /** Correos enviados que aún no se han podido verificar. */
  async listUnverified(maxVerifyAttempts: number, limit: number): Promise<ReceiptRow[]> {
    const { rows } = await this.db.pool.query<ReceiptRow>(
      `SELECT * FROM ${this.db.table}
        WHERE status = 'sent' AND verified = FALSE AND verify_attempts < $1 AND message_id IS NOT NULL
        ORDER BY sent_at LIMIT $2`,
      [maxVerifyAttempts, limit],
    );
    return rows;
  }

  async markVerified(id: string, note: string) {
    await this.db.pool.query(
      `UPDATE ${this.db.table}
          SET verified = TRUE, verified_at = now(), verification_note = $2,
              verify_attempts = verify_attempts + 1, updated_at = now()
        WHERE id = $1`,
      [id, note],
    );
  }

  async markVerifyAttempt(id: string, note: string) {
    await this.db.pool.query(
      `UPDATE ${this.db.table}
          SET verify_attempts = verify_attempts + 1, verification_note = $2, updated_at = now()
        WHERE id = $1`,
      [id, note.slice(0, 500)],
    );
  }

  async list(filter: { status?: string; verified?: boolean }, limit: number): Promise<ReceiptRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    if (filter.verified !== undefined) {
      params.push(filter.verified);
      where.push(`verified = $${params.length}`);
    }
    params.push(limit);
    const { rows } = await this.db.pool.query<ReceiptRow>(
      `SELECT id, file_name, employee_code, employee_name, to_email, status, attempts, message_id,
              sent_at, verified, verified_at, verify_attempts, verification_note, error, processed_path, created_at, updated_at
         FROM ${this.db.table}
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC LIMIT $${params.length}`,
      params,
    );
    return rows;
  }
}

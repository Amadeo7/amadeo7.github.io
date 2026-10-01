import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

const schema = (t: string) => `
CREATE TABLE IF NOT EXISTS ${t} (
  id                BIGSERIAL PRIMARY KEY,
  file_name         TEXT        NOT NULL,
  file_sha256       TEXT        NOT NULL,
  employee_code     TEXT,
  employee_name     TEXT,
  to_email          TEXT,
  status            TEXT        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sent', 'failed')),
  attempts          INTEGER     NOT NULL DEFAULT 0,
  message_id        TEXT,
  sent_at           TIMESTAMPTZ,
  verified          BOOLEAN     NOT NULL DEFAULT FALSE,
  verified_at       TIMESTAMPTZ,
  verify_attempts   INTEGER     NOT NULL DEFAULT 0,
  verification_note TEXT,
  error             TEXT,
  processed_path    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_name, file_sha256)
);
ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS processed_path TEXT;
CREATE INDEX IF NOT EXISTS ${t}_status_idx ON ${t} (status, verified);
CREATE INDEX IF NOT EXISTS ${t}_employee_idx ON ${t} (employee_code);
`;

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  readonly pool: Pool;
  /** Nombre de la tabla (DB_TABLE). Se valida porque se interpola en el SQL. */
  readonly table: string;

  constructor(config: ConfigService) {
    this.table = config.get<string>('DB_TABLE', 'receipt_emails');
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(this.table)) {
      throw new Error('DB_TABLE solo admite minúsculas, dígitos y guion bajo (máx. 63 caracteres)');
    }
    this.pool = new Pool({
      connectionString: config.getOrThrow('DATABASE_URL'),
      ssl: config.get('DATABASE_SSL') === 'true' ? true : undefined,
    });
  }

  async onModuleInit() {
    await this.pool.query(schema(this.table));
    this.logger.log(`Tabla ${this.table} lista`);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

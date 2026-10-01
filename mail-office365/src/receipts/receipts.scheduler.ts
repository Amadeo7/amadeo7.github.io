import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { ReceiptsService } from './receipts.service';

/** Ejecución automática opcional: se activa con RECEIPTS_CRON (formato cron de 6 campos con segundos). */
@Injectable()
export class ReceiptsScheduler implements OnModuleInit {
  private readonly logger = new Logger(ReceiptsScheduler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
    private readonly service: ReceiptsService,
  ) {}

  onModuleInit() {
    const expr = this.config.get<string>('RECEIPTS_CRON');
    if (!expr) return;
    const job = new CronJob(
      expr,
      () => {
        if (this.service.isRunning) return;
        this.service.run().catch((e) => this.logger.error(`Proceso programado fallido: ${e?.message ?? e}`));
      },
      null,
      true,
      this.config.get('TZ', 'UTC'),
    );
    this.registry.addCronJob('receipts', job);
    this.logger.log(`Proceso programado: ${expr}`);
  }
}

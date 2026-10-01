import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { TemporalClientService } from '../temporal/temporal.client.service';
import { ReceiptsRepository } from './receipts.repository';
import { ReceiptsService } from './receipts.service';

/** Inicia ejecuciones con el orquestador activo: Temporal si TEMPORAL_ENABLED=true, o el bucle en proceso. */
@Injectable()
export class RunLauncherService {
  private readonly logger = new Logger(RunLauncherService.name);

  constructor(
    private readonly receipts: ReceiptsService,
    private readonly temporal: TemporalClientService,
    private readonly repo: ReceiptsRepository,
  ) {}

  get mode(): 'temporal' | 'process' {
    return this.temporal.enabled ? 'temporal' : 'process';
  }

  async start(): Promise<{ started: true; mode: string; workflowId?: string }> {
    if (this.temporal.enabled) {
      const { workflowId } = await this.temporal.startRun();
      return { started: true, mode: 'temporal', workflowId };
    }
    if (this.receipts.isRunning) throw new ConflictException('Ya hay un proceso en ejecución');
    this.receipts.run().catch((e) => this.logger.error(`Proceso fallido: ${e?.message ?? e}`));
    return { started: true, mode: 'process' };
  }

  async status() {
    return {
      mode: this.mode,
      running: this.temporal.enabled ? await this.temporal.isRunning() : this.receipts.isRunning,
      lastRun: (await this.repo.lastRun()) ?? null,
    };
  }
}

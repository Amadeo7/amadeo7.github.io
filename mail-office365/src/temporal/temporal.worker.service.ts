import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NativeConnection, Worker } from '@temporalio/worker';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { ReceiptsRepository } from '../receipts/receipts.repository';
import { ReceiptsService } from '../receipts/receipts.service';
import { ReportService } from '../receipts/report.service';
import { createActivities } from './receipts.activities';
import { temporalConnectionOptions } from './temporal.client.service';

/** Worker de Temporal: ejecuta workflows y activities. Va en este proceso o en uno aparte (src/worker.ts). */
@Injectable()
export class TemporalWorkerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TemporalWorkerService.name);
  private worker?: Worker;
  private connection?: NativeConnection;
  private running?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly receipts: ReceiptsService,
    private readonly repo: ReceiptsRepository,
    private readonly report: ReportService,
  ) {}

  async onApplicationBootstrap() {
    if (this.config.get('TEMPORAL_ENABLED', 'false') !== 'true') return;
    if (this.config.get('TEMPORAL_WORKER_ENABLED', 'true') !== 'true') return;

    const { address, tls, apiKey } = temporalConnectionOptions(this.config);
    this.connection = await NativeConnection.connect({ address, tls, apiKey });

    // Si el build generó dist/workflow-bundle.js se usa; si no, el worker empaqueta el workflow al arrancar
    const bundle = join(__dirname, '..', 'workflow-bundle.js');
    const rate = Number(this.config.get('TEMPORAL_ACTIVITIES_PER_SECOND', 0));
    this.worker = await Worker.create({
      connection: this.connection,
      namespace: this.config.get('TEMPORAL_NAMESPACE', 'default'),
      taskQueue: this.config.get('TEMPORAL_TASK_QUEUE', 'receipts-mail'),
      workflowBundle: existsSync(bundle) ? { code: readFileSync(bundle, 'utf8') } : undefined,
      workflowsPath: existsSync(bundle) ? undefined : require.resolve('./workflows'),
      activities: createActivities(this.receipts, this.repo, this.report),
      // Red de seguridad contra bugs o ejecuciones simultáneas. El ritmo real lo marca la pausa del workflow
      maxTaskQueueActivitiesPerSecond: rate > 0 ? rate : undefined,
      maxConcurrentActivityTaskExecutions: Number(this.config.get('TEMPORAL_MAX_CONCURRENT_ACTIVITIES', 1)),
    });
    this.running = this.worker.run().catch((e) => this.logger.error(`El worker de Temporal se detuvo: ${e?.message ?? e}`));
    this.logger.log(`Worker de Temporal activo (cola "${this.config.get('TEMPORAL_TASK_QUEUE', 'receipts-mail')}")`);
  }

  async onApplicationShutdown() {
    this.worker?.shutdown();
    await this.running;
    await this.connection?.close();
  }
}

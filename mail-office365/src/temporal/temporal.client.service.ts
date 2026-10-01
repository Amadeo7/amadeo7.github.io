import { ConflictException, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Client,
  Connection,
  ScheduleNotFoundError,
  ScheduleOverlapPolicy,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from '@temporalio/client';
import { WORKFLOW_NAME } from './temporal.constants';
import type { RunInput } from './activities.types';

/** Conexión de Temporal compartida por cliente y worker (dirección, namespace, TLS, API key). */
export function temporalConnectionOptions(config: ConfigService) {
  const apiKey = config.get<string>('TEMPORAL_API_KEY');
  return {
    address: config.get<string>('TEMPORAL_ADDRESS', 'localhost:7233'),
    tls: config.get('TEMPORAL_TLS', 'false') === 'true' || apiKey ? ({} as const) : undefined,
    apiKey: apiKey || undefined,
  };
}

/** Cliente de Temporal: lanza ejecuciones, consulta su estado y mantiene el Schedule. */
@Injectable()
export class TemporalClientService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TemporalClientService.name);
  private connection?: Connection;
  private client?: Client;

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.config.get('TEMPORAL_ENABLED', 'false') === 'true';
  }
  private get workflowId() {
    return this.config.get<string>('TEMPORAL_WORKFLOW_ID', 'receipts-run');
  }
  private get taskQueue() {
    return this.config.get<string>('TEMPORAL_TASK_QUEUE', 'receipts-mail');
  }

  /** Configuración que el workflow necesita (no puede leer el entorno). */
  private runConfig(): RunInput['config'] {
    return {
      delayMs: Number(this.config.get('SEND_DELAY_MS', 2500)),
      maxApiErrors: Number(this.config.get('EMPLOYEES_API_MAX_CONSECUTIVE_ERRORS', 5)),
      batchSize: Number(this.config.get('WORKFLOW_BATCH_SIZE', 500)),
      retryAttempts: Number(this.config.get('TEMPORAL_RETRY_ATTEMPTS', 3)),
      retryInitialSeconds: Number(this.config.get('TEMPORAL_RETRY_INITIAL_SECONDS', 5)),
      retryMaxSeconds: Number(this.config.get('TEMPORAL_RETRY_MAX_SECONDS', 60)),
      reportRetryAttempts: Number(this.config.get('TEMPORAL_REPORT_RETRY_ATTEMPTS', 5)),
      reportRetryInitialSeconds: Number(this.config.get('TEMPORAL_REPORT_RETRY_INITIAL_SECONDS', 30)),
    };
  }

  private async getClient(): Promise<Client> {
    if (!this.client) {
      this.connection = await Connection.connect(temporalConnectionOptions(this.config));
      this.client = new Client({ connection: this.connection, namespace: this.config.get('TEMPORAL_NAMESPACE', 'default') });
    }
    return this.client;
  }

  async onApplicationBootstrap() {
    const cron = this.config.get<string>('TEMPORAL_SCHEDULE_CRON');
    if (!this.enabled || !cron) return;
    await this.upsertSchedule(cron);
  }

  async onModuleDestroy() {
    await this.connection?.close();
  }

  /** Inicia una ejecución. El Workflow ID fijo impide dos ejecuciones a la vez (409). */
  async startRun(): Promise<{ workflowId: string; runId: string }> {
    const client = await this.getClient();
    try {
      const handle = await client.workflow.start(WORKFLOW_NAME, {
        taskQueue: this.taskQueue,
        workflowId: this.workflowId,
        workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        args: [{ config: this.runConfig() } satisfies RunInput],
      });
      return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
    } catch (e) {
      if (e instanceof WorkflowExecutionAlreadyStartedError) throw new ConflictException('Ya hay un proceso en ejecución');
      throw e;
    }
  }

  async isRunning(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const d = await client.workflow.getHandle(this.workflowId).describe();
      return d.status.name === 'RUNNING';
    } catch {
      return false;
    }
  }

  /** Crea o actualiza el Schedule (reemplaza al cron en proceso). Se ejecuta en cada arranque, así toma cambios del .env. */
  private async upsertSchedule(cron: string) {
    const client = await this.getClient();
    const id = this.config.get<string>('TEMPORAL_SCHEDULE_ID', 'receipts-schedule');
    const spec = { cronExpressions: [cron], timezone: this.config.get<string>('TZ', 'UTC') };
    const action = {
      type: 'startWorkflow' as const,
      workflowType: WORKFLOW_NAME,
      taskQueue: this.taskQueue,
      workflowId: `${this.workflowId}-scheduled`,
      args: [{ config: this.runConfig() } satisfies RunInput],
    };
    const policies = { overlap: ScheduleOverlapPolicy.SKIP }; // si la anterior sigue corriendo, se omite
    try {
      await client.schedule.getHandle(id).update((prev) => ({ ...prev, spec, action, policies: { ...prev.policies, ...policies } }));
      this.logger.log(`Schedule "${id}" actualizado: ${cron} (${spec.timezone})`);
    } catch (e) {
      if (!(e instanceof ScheduleNotFoundError)) throw e;
      await client.schedule.create({ scheduleId: id, spec, action, policies });
      this.logger.log(`Schedule "${id}" creado: ${cron} (${spec.timezone})`);
    }
  }
}

import { ConflictException, Controller, Get, HttpCode, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from '../common/api-key.guard';
import { ReceiptsRepository } from './receipts.repository';
import { ReceiptsService } from './receipts.service';

@Controller('receipts')
@UseGuards(ApiKeyGuard)
export class ReceiptsController {
  private readonly logger = new Logger(ReceiptsController.name);

  constructor(
    private readonly service: ReceiptsService,
    private readonly repo: ReceiptsRepository,
    private readonly config: ConfigService,
  ) {}

  /** Inicia el proceso en segundo plano y responde de inmediato. */
  @Post('process')
  @HttpCode(202)
  start() {
    if (this.service.isRunning) throw new ConflictException('Ya hay un proceso en ejecución');
    this.service.run().catch((e) => this.logger.error(`Proceso fallido: ${e?.message ?? e}`));
    return { started: true };
  }

  @Get('status')
  status() {
    return { running: this.service.isRunning, lastRun: this.service.lastRun ?? null };
  }

  // GET /receipts?status=sent|failed|pending&verified=true|false&limit=100
  @Get()
  list(@Query('status') status?: string, @Query('verified') verified?: string, @Query('limit') limit?: string) {
    return this.repo.list(
      {
        status: ['pending', 'sent', 'failed'].includes(status ?? '') ? status : undefined,
        verified: verified === undefined ? undefined : verified === 'true',
      },
      Math.min(
        Math.max(Number(limit) || Number(this.config.get('LIST_DEFAULT_LIMIT', 100)), 1),
        Number(this.config.get('LIST_MAX_LIMIT', 500)),
      ),
    );
  }
}

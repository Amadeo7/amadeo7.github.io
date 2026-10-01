import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard } from '../common/api-key.guard';
import { ReceiptsRepository } from './receipts.repository';
import { RunLauncherService } from './run-launcher.service';

@Controller('receipts')
@UseGuards(ApiKeyGuard)
export class ReceiptsController {
  constructor(
    private readonly launcher: RunLauncherService,
    private readonly repo: ReceiptsRepository,
    private readonly config: ConfigService,
  ) {}

  /** Inicia el proceso en segundo plano y responde de inmediato. */
  @Post('process')
  @HttpCode(202)
  start() {
    return this.launcher.start();
  }

  @Get('status')
  status() {
    return this.launcher.status();
  }

  // GET /receipts?status=sent|failed|pending|sending|uncertain&verified=true|false&runId=&limit=100
  @Get()
  list(@Query('status') status?: string, @Query('verified') verified?: string, @Query('runId') runId?: string, @Query('limit') limit?: string) {
    return this.repo.list(
      {
        status: ['pending', 'sending', 'sent', 'failed', 'uncertain'].includes(status ?? '') ? status : undefined,
        verified: verified === undefined ? undefined : verified === 'true',
        runId: runId || undefined,
      },
      Math.min(Math.max(Number(limit) || Number(this.config.get('LIST_DEFAULT_LIMIT', 100)), 1), Number(this.config.get('LIST_MAX_LIMIT', 500))),
    );
  }

  /** Resuelve a mano un envío incierto: `resend` lo reenvía en la siguiente ejecución, `mark_sent` lo da por enviado. */
  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(@Param('id', ParseIntPipe) id: number, @Body() body: { action?: string }) {
    if (body?.action !== 'resend' && body?.action !== 'mark_sent') {
      throw new BadRequestException('action debe ser "resend" o "mark_sent"');
    }
    if (!(await this.repo.resolve(String(id), body.action))) {
      throw new NotFoundException('No existe o no está en estado uncertain/sending');
    }
    return { ok: true, action: body.action };
  }
}

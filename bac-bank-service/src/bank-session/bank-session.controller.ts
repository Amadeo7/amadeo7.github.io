import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { BankSessionService } from './bank-session.service';

@Controller()
export class BankSessionController {
  constructor(private readonly session: BankSessionService) {}

  @Get('health')
  health() {
    return { ok: true };
  }

  @UseGuards(ApiKeyGuard)
  @Get('session/status')
  status() {
    return this.session.status();
  }

  @UseGuards(ApiKeyGuard)
  @Post('session/login')
  login() {
    return this.session.ensureLoggedIn();
  }

  @UseGuards(ApiKeyGuard)
  @Post('session/close')
  close() {
    return this.session.close();
  }
}

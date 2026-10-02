import { Module } from '@nestjs/common';
import { BankSessionController } from './bank-session.controller';
import { BankSessionService } from './bank-session.service';

@Module({
  controllers: [BankSessionController],
  providers: [BankSessionService],
  exports: [BankSessionService],
})
export class BankSessionModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BankSessionModule } from './bank-session/bank-session.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), BankSessionModule],
})
export class AppModule {}

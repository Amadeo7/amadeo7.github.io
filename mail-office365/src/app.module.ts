import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DbModule } from './db/db.module';
import { EmployeesModule } from './employees/employees.module';
import { MailModule } from './mail/mail.module';
import { ReceiptsModule } from './receipts/receipts.module';
import { SftpModule } from './sftp/sftp.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    DbModule,
    SftpModule,
    EmployeesModule,
    MailModule,
    ReceiptsModule,
  ],
})
export class AppModule {}

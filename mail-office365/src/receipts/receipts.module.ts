import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module';
import { MailModule } from '../mail/mail.module';
import { SftpModule } from '../sftp/sftp.module';
import { TemporalModule } from '../temporal/temporal.module';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsRepository } from './receipts.repository';
import { ReceiptsScheduler } from './receipts.scheduler';
import { ReceiptsService } from './receipts.service';
import { ReportService } from './report.service';
import { RunLauncherService } from './run-launcher.service';

@Module({
  imports: [SftpModule, EmployeesModule, MailModule, TemporalModule],
  controllers: [ReceiptsController],
  providers: [ReceiptsService, ReceiptsRepository, ReceiptsScheduler, ReportService, RunLauncherService],
  exports: [ReceiptsService, ReceiptsRepository, ReportService],
})
export class ReceiptsModule {}

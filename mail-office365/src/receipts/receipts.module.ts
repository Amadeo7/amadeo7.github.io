import { Module } from '@nestjs/common';
import { EmployeesModule } from '../employees/employees.module';
import { MailModule } from '../mail/mail.module';
import { SftpModule } from '../sftp/sftp.module';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsRepository } from './receipts.repository';
import { ReceiptsScheduler } from './receipts.scheduler';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [SftpModule, EmployeesModule, MailModule],
  controllers: [ReceiptsController],
  providers: [ReceiptsService, ReceiptsRepository, ReceiptsScheduler],
})
export class ReceiptsModule {}

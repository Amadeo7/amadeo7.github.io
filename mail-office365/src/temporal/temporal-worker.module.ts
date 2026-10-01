import { Module } from '@nestjs/common';
import { ReceiptsModule } from '../receipts/receipts.module';
import { TemporalWorkerService } from './temporal.worker.service';

@Module({ imports: [ReceiptsModule], providers: [TemporalWorkerService] })
export class TemporalWorkerModule {}

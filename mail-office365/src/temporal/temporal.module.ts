import { Module } from '@nestjs/common';
import { TemporalClientService } from './temporal.client.service';

/** Solo el cliente (lanzar y consultar). El worker está en TemporalWorkerModule. */
@Module({ providers: [TemporalClientService], exports: [TemporalClientService] })
export class TemporalModule {}

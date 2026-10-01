// Proceso solo-worker (sin servidor HTTP): `node dist/worker`.
// Úsalo cuando quieras que la API y el worker de Temporal vivan en procesos distintos
// (API con TEMPORAL_WORKER_ENABLED=false).
process.env.TEMPORAL_ENABLED = 'true';
process.env.TEMPORAL_WORKER_ENABLED = 'true';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}
bootstrap();

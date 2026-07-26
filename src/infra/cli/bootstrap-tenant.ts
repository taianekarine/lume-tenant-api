import 'dotenv/config';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { ProductionBootstrapService } from '../bootstrap/production-bootstrap.service';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const result = await app.get(ProductionBootstrapService).execute();
    process.stdout.write(
      `Bootstrap sincronizado para tenant ${result.tenantId}; channel=${result.channelId ?? 'disabled'}.\n`,
    );
  } finally {
    await app.close();
  }
}

void run();

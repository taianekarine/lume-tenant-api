import 'dotenv/config';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { BootstrapTenantUseCase } from '../../application/use-cases/tenant/bootstrap-tenant.use-case';

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const config = app.get(ConfigService);
    const result = await app.get(BootstrapTenantUseCase).execute({
      legalName: config.getOrThrow<string>('TENANT_LEGAL_NAME'),
      tradeName: config.get<string>('TENANT_TRADE_NAME'),
      taxId: config.getOrThrow<string>('TENANT_TAX_ID'),
      administrator: {
        name: config.getOrThrow<string>('TENANT_ADMIN_NAME'),
        username: config.getOrThrow<string>('TENANT_ADMIN_USERNAME'),
        email: config.getOrThrow<string>('TENANT_ADMIN_EMAIL'),
        cpf: config.get<string>('TENANT_ADMIN_CPF'),
        password: config.getOrThrow<string>('TENANT_ADMIN_PASSWORD'),
      },
    });
    process.stdout.write(
      `Tenant ${result.tenant.legalName} inicializado para ${result.installationId}.\n`,
    );
  } finally {
    await app.close();
  }
}

void run();

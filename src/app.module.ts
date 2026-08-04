import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import { validateEnvironment } from './infra/config/environment';
import { DatabaseModule } from './infra/database/database.module';
import { SecurityModule } from './infra/security.module';
import { AccessModule } from './modules/access/access.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { LicenseModule } from './modules/license/license.module';
import { SupportModule } from './modules/support/support.module';
import { TenantBootstrapModule } from './modules/tenant-bootstrap.module';
import { UsersModule } from './modules/users/users.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { DataExchangeModule } from './modules/data-exchange/data-exchange.module';
import { DocumentManagementModule } from './modules/documents/document-management.module';
import { AppErrorFilter } from './shared/http/filters/app-error.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.getOrThrow<number>('RATE_LIMIT_TTL_MS'),
            limit: config.getOrThrow<number>('RATE_LIMIT_MAX'),
          },
        ],
      }),
    }),
    DatabaseModule,
    SecurityModule,
    TenantBootstrapModule,
    AuthModule,
    UsersModule,
    AccessModule,
    LicenseModule,
    SupportModule,
    HealthModule,
    WhatsAppModule,
    DataExchangeModule,
    DocumentManagementModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AppErrorFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}

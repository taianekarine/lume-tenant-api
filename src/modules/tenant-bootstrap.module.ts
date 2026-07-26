import { Module } from '@nestjs/common';

import {
  OfflineLicenseVerifier,
  PasswordHasher,
} from '../application/contracts/cryptography';
import { TenantBootstrapRepository } from '../application/contracts/repositories';
import { BootstrapTenantUseCase } from '../application/use-cases/tenant/bootstrap-tenant.use-case';
import { ProductionBootstrapService } from '../infra/bootstrap/production-bootstrap.service';

@Module({
  providers: [
    ProductionBootstrapService,
    {
      provide: BootstrapTenantUseCase,
      useFactory: (
        tenants: TenantBootstrapRepository,
        hasher: PasswordHasher,
        license: OfflineLicenseVerifier,
      ) => new BootstrapTenantUseCase(tenants, hasher, license),
      inject: [
        TenantBootstrapRepository,
        PasswordHasher,
        OfflineLicenseVerifier,
      ],
    },
  ],
  exports: [BootstrapTenantUseCase, ProductionBootstrapService],
})
export class TenantBootstrapModule {}

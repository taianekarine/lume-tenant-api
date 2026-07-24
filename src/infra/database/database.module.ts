import { Global, Module } from '@nestjs/common';

import {
  RefreshTokensRepository,
  RolesRepository,
  TenantAuditLogsRepository,
  TenantBootstrapRepository,
  UsersRepository,
} from '../../application/contracts/repositories';
import { PrismaService } from './prisma/prisma.service';
import { PrismaRefreshTokensRepository } from './repositories/prisma-refresh-tokens.repository';
import { PrismaRolesRepository } from './repositories/prisma-roles.repository';
import { PrismaTenantAuditLogsRepository } from './repositories/prisma-tenant-audit-logs.repository';
import { PrismaTenantBootstrapRepository } from './repositories/prisma-tenant-bootstrap.repository';
import { PrismaUsersRepository } from './repositories/prisma-users.repository';

@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: TenantBootstrapRepository,
      useClass: PrismaTenantBootstrapRepository,
    },
    { provide: UsersRepository, useClass: PrismaUsersRepository },
    { provide: RolesRepository, useClass: PrismaRolesRepository },
    {
      provide: RefreshTokensRepository,
      useClass: PrismaRefreshTokensRepository,
    },
    {
      provide: TenantAuditLogsRepository,
      useClass: PrismaTenantAuditLogsRepository,
    },
  ],
  exports: [
    PrismaService,
    TenantBootstrapRepository,
    UsersRepository,
    RolesRepository,
    RefreshTokensRepository,
    TenantAuditLogsRepository,
  ],
})
export class DatabaseModule {}

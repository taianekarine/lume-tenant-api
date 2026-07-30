import { Global, Module } from '@nestjs/common';

import {
  RefreshTokensRepository,
  PasswordChangeChallengesRepository,
  TenantAuditLogsRepository,
  TenantBootstrapRepository,
  UsersRepository,
} from '../../application/contracts/repositories';
import { WhatsAppRepository } from '../../application/contracts/whatsapp.repository';
import { DataExchangeRepository } from '../../application/contracts/data-exchange.repository';
import { PrismaService } from './prisma/prisma.service';
import { PrismaRefreshTokensRepository } from './repositories/prisma-refresh-tokens.repository';
import { PrismaPasswordChangeChallengesRepository } from './repositories/prisma-password-change-challenges.repository';
import { PrismaTenantAuditLogsRepository } from './repositories/prisma-tenant-audit-logs.repository';
import { PrismaTenantBootstrapRepository } from './repositories/prisma-tenant-bootstrap.repository';
import { PrismaUsersRepository } from './repositories/prisma-users.repository';
import { PrismaWhatsAppRepository } from './repositories/prisma-whatsapp.repository';
import { PrismaDataExchangeRepository } from './repositories/prisma-data-exchange.repository';

@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: TenantBootstrapRepository,
      useClass: PrismaTenantBootstrapRepository,
    },
    { provide: UsersRepository, useClass: PrismaUsersRepository },
    {
      provide: RefreshTokensRepository,
      useClass: PrismaRefreshTokensRepository,
    },
    {
      provide: PasswordChangeChallengesRepository,
      useClass: PrismaPasswordChangeChallengesRepository,
    },
    {
      provide: TenantAuditLogsRepository,
      useClass: PrismaTenantAuditLogsRepository,
    },
    { provide: WhatsAppRepository, useClass: PrismaWhatsAppRepository },
    { provide: DataExchangeRepository, useClass: PrismaDataExchangeRepository },
  ],
  exports: [
    PrismaService,
    TenantBootstrapRepository,
    UsersRepository,
    RefreshTokensRepository,
    PasswordChangeChallengesRepository,
    TenantAuditLogsRepository,
    WhatsAppRepository,
    DataExchangeRepository,
  ],
})
export class DatabaseModule {}

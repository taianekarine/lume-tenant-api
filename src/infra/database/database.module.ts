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
import { RoutingRepository } from '../../application/contracts/routing.repository';
import { PrismaRoutingRepository } from './repositories/prisma-routing.repository';
import { PassengerRepository } from '../../application/contracts/passenger.repository';
import { PrismaPassengerRepository } from './repositories/prisma-passenger.repository';
import { ContractRepository } from '../../application/contracts/contract.repository';
import { PrismaContractRepository } from './repositories/prisma-contract.repository';
import { RouteRepository } from '../../application/contracts/route.repository';
import { PrismaRouteRepository } from './repositories/prisma-route.repository';

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
    { provide: RoutingRepository, useClass: PrismaRoutingRepository },
    { provide: PassengerRepository, useClass: PrismaPassengerRepository },
    { provide: ContractRepository, useClass: PrismaContractRepository },
    { provide: RouteRepository, useClass: PrismaRouteRepository },
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
    RoutingRepository,
    PassengerRepository,
    ContractRepository,
    RouteRepository,
  ],
})
export class DatabaseModule {}

import { Module } from '@nestjs/common';

import { SupportRequestNotifier } from '../../application/contracts/notifications';
import { TenantAuditLogsRepository } from '../../application/contracts/repositories';
import { CreateSupportRequestUseCase } from '../../application/use-cases/support/create-support-request.use-case';
import { SupportController } from './support.controller';

@Module({
  controllers: [SupportController],
  providers: [
    {
      provide: CreateSupportRequestUseCase,
      useFactory: (
        notifier: SupportRequestNotifier,
        auditLogs: TenantAuditLogsRepository,
      ) => new CreateSupportRequestUseCase(notifier, auditLogs),
      inject: [SupportRequestNotifier, TenantAuditLogsRepository],
    },
  ],
})
export class SupportModule {}

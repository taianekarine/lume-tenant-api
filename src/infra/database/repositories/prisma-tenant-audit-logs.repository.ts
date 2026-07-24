import { Injectable } from '@nestjs/common';

import { TenantAuditLogsRepository } from '../../../application/contracts/repositories';
import type { Prisma } from '../prisma/generated/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaTenantAuditLogsRepository implements TenantAuditLogsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    companyId: string;
    actorUserId?: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Readonly<Record<string, unknown>>;
  }) {
    await this.prisma.tenantAuditLog.create({
      data: {
        ...input,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
}

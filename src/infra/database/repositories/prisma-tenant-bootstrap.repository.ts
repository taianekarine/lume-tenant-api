import { Injectable } from '@nestjs/common';

import {
  TenantBootstrapRepository,
  type BootstrapTenantPersistenceInput,
} from '../../../application/contracts/repositories';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaTenantBootstrapRepository implements TenantBootstrapRepository {
  constructor(private readonly prisma: PrismaService) {}

  async isInitialized(): Promise<boolean> {
    return (await this.prisma.company.count()) > 0;
  }

  async createWithAdministrator(
    input: BootstrapTenantPersistenceInput,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.company.create({ data: input.company.props });
        await transaction.role.createMany({
          data: input.roles.map((role) => ({
            ...role.props,
            permissionCodes: [...role.props.permissionCodes],
          })),
        });
        await transaction.user.create({
          data: {
            ...input.administrator.props,
            departments: [...input.administrator.props.departments],
          },
        });
        await transaction.userRole.create({
          data: {
            companyId: input.company.id,
            userId: input.administrator.id,
            roleId: input.administratorRoleId,
          },
        });
        await transaction.tenantAuditLog.create({
          data: {
            companyId: input.company.id,
            actorUserId: input.administrator.id,
            action: 'TENANT_BOOTSTRAPPED',
            targetType: 'company',
            targetId: input.company.id,
            metadata: {},
          },
        });
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }
}

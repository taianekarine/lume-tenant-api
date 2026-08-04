import { Injectable } from '@nestjs/common';

import {
  TenantBootstrapRepository,
  type BootstrapTenantPersistenceInput,
} from '../../../application/contracts/repositories';
import type { UserDepartment } from '../../../domain/access/access.constants';
import {
  DepartmentCode,
  DocumentAccessMode,
  UserAccountStatus,
} from '../prisma/generated/client';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

const departmentPersistenceCodes: Readonly<
  Record<UserDepartment, DepartmentCode>
> = {
  'human-resources': DepartmentCode.HUMAN_RESOURCES,
  'personnel-department': DepartmentCode.PERSONNEL_DEPARTMENT,
  commercial: DepartmentCode.COMMERCIAL,
  purchasing: DepartmentCode.PURCHASING,
  controlling: DepartmentCode.CONTROLLING,
  maintenance: DepartmentCode.MAINTENANCE,
  monitoring: DepartmentCode.MONITORING,
  management: DepartmentCode.MANAGEMENT,
  operations: DepartmentCode.OPERATIONS,
  cleaning: DepartmentCode.CLEANING,
  financial: DepartmentCode.FINANCIAL,
  'information-technology': DepartmentCode.INFORMATION_TECHNOLOGY,
};

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
        await transaction.tenantDepartment.createMany({
          data: input.departments.map((department) => ({
            companyId: input.company.id,
            code: departmentPersistenceCodes[department.code],
            name: department.name,
            isDefault: department.isDefault,
          })),
        });
        await transaction.user.create({
          data: {
            ...input.administrator.props,
            documentAccessMode: DocumentAccessMode.STANDARD,
            departments: [...input.administrator.props.departments],
            permissionCodes: [...input.administrator.props.permissionCodes],
            status: UserAccountStatus.ACTIVE,
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

import { Injectable } from '@nestjs/common';

import { RolesRepository } from '../../../application/contracts/repositories';
import type { Role } from '../../../domain/entities/role';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { mapRole } from '../prisma/prisma.mappers';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaRolesRepository extends RolesRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async list(companyId: string): Promise<Role[]> {
    return (
      await this.prisma.role.findMany({
        where: { companyId },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      })
    ).map(mapRole);
  }

  async findById(companyId: string, roleId: string): Promise<Role | null> {
    const row = await this.prisma.role.findUnique({
      where: { id_companyId: { id: roleId, companyId } },
    });
    return row ? mapRole(row) : null;
  }

  async findByIds(
    companyId: string,
    roleIds: readonly string[],
  ): Promise<Role[]> {
    if (roleIds.length === 0) {
      return [];
    }

    return (
      await this.prisma.role.findMany({
        where: { companyId, id: { in: [...roleIds] } },
      })
    ).map(mapRole);
  }

  async findByCode(companyId: string, code: string): Promise<Role | null> {
    const row = await this.prisma.role.findUnique({
      where: { companyId_code: { companyId, code } },
    });
    return row ? mapRole(row) : null;
  }

  async codeExists(
    companyId: string,
    code: string,
    exceptRoleId?: string,
  ): Promise<boolean> {
    return Boolean(
      await this.prisma.role.findFirst({
        where: {
          companyId,
          code,
          ...(exceptRoleId ? { NOT: { id: exceptRoleId } } : {}),
        },
        select: { id: true },
      }),
    );
  }

  async create(role: Role): Promise<Role> {
    try {
      return mapRole(
        await this.prisma.role.create({
          data: { ...role.props, permissionCodes: [...role.permissionCodes] },
        }),
      );
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async update(role: Role): Promise<Role> {
    try {
      return mapRole(
        await this.prisma.role.update({
          where: { id_companyId: { id: role.id, companyId: role.companyId } },
          data: {
            code: role.code,
            name: role.name,
            description: role.description,
            permissionCodes: [...role.permissionCodes],
          },
        }),
      );
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async delete(companyId: string, roleId: string): Promise<void> {
    await this.prisma.role.delete({
      where: { id_companyId: { id: roleId, companyId } },
    });
  }

  countAssignments(companyId: string, roleId: string): Promise<number> {
    return this.prisma.userRole.count({ where: { companyId, roleId } });
  }
}

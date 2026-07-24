import type { Prisma, Role as PrismaRole } from './generated/client';

import type {
  Department,
  PermissionCode,
} from '../../../domain/access/access.constants';
import { Role } from '../../../domain/entities/role';
import { User } from '../../../domain/entities/user';
import type { UserWithRoles } from '../../../application/contracts/repositories';

export type PrismaUserWithRelations = Prisma.UserGetPayload<{
  include: { company: true; roles: { include: { role: true } } };
}>;

export function mapRole(row: PrismaRole): Role {
  return Role.restore({
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    description: row.description,
    permissionCodes: row.permissionCodes as PermissionCode[],
    isSystem: row.isSystem,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function mapUserWithRoles(row: PrismaUserWithRelations): UserWithRoles {
  return {
    user: User.restore({
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      username: row.username,
      usernameNormalized: row.usernameNormalized,
      email: row.email,
      emailNormalized: row.emailNormalized,
      cpfNormalized: row.cpfNormalized,
      passwordHash: row.passwordHash,
      departments: row.departments as Department[],
      isActive: row.isActive,
      tokenVersion: row.tokenVersion,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    roles: row.roles.map(({ role }) => mapRole(role)),
    companyIsActive: row.company.status === 'ACTIVE',
  };
}

export const userWithRelations = {
  company: true,
  roles: { include: { role: true } },
} as const;

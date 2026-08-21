import type { Prisma } from './generated/client';

import type {
  PermissionCode,
  UserDepartment,
} from '../../../domain/access/access.constants';
import { User } from '../../../domain/entities/user';
import type {
  MaritalStatus,
  MilitaryDocumentStatus,
  UserDependent,
} from '../../../domain/entities/user';
import type { UserRecord } from '../../../application/contracts/repositories';

export const userRecordSelect = {
  id: true,
  companyId: true,
  routingCompanyId: true,
  name: true,
  username: true,
  usernameNormalized: true,
  email: true,
  emailNormalized: true,
  cpfNormalized: true,
  passwordHash: true,
  mustChangePassword: true,
  profilePictureMime: true,
  isAdministrator: true,
  documentAccessMode: true,
  clientCategory: true,
  jobTitle: true,
  maritalStatus: true,
  militaryDocumentStatus: true,
  dependents: true,
  departments: true,
  permissionCodes: true,
  status: true,
  suspendedUntil: true,
  suspensionReason: true,
  isActive: true,
  tokenVersion: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  company: { select: { status: true } },
} as const satisfies Prisma.UserSelect;

export type PrismaUserRecord = Prisma.UserGetPayload<{
  select: typeof userRecordSelect;
}>;

export function mapUserRecord(row: PrismaUserRecord): UserRecord {
  return {
    user: User.restore({
      id: row.id,
      companyId: row.companyId,
      routingCompanyId: row.routingCompanyId,
      name: row.name,
      username: row.username,
      usernameNormalized: row.usernameNormalized,
      email: row.email,
      emailNormalized: row.emailNormalized,
      cpfNormalized: row.cpfNormalized,
      passwordHash: row.passwordHash,
      mustChangePassword: row.mustChangePassword,
      profilePicture: null,
      profilePictureMime: row.profilePictureMime,
      isAdministrator: row.isAdministrator,
      documentAccessMode:
        row.documentAccessMode === 'DOCUMENT_PORTAL'
          ? 'document-portal'
          : row.documentAccessMode === 'CLIENT'
            ? 'client'
            : 'standard',
      clientCategory: row.clientCategory
        ? (row.clientCategory.toLowerCase().replaceAll('_', '-') as
            'legal-entity' | 'individual')
        : null,
      jobTitle: row.jobTitle,
      maritalStatus: row.maritalStatus as MaritalStatus | null,
      militaryDocumentStatus:
        row.militaryDocumentStatus as MilitaryDocumentStatus,
      dependents: Array.isArray(row.dependents)
        ? (row.dependents as unknown as UserDependent[])
        : [],
      departments: row.departments as UserDepartment[],
      permissionCodes: row.permissionCodes as PermissionCode[],
      status: row.status.toLowerCase() as 'active' | 'inactive' | 'suspended',
      suspendedUntil: row.suspendedUntil,
      suspensionReason: row.suspensionReason,
      isActive: row.isActive,
      tokenVersion: row.tokenVersion,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    companyIsActive: row.company.status === 'ACTIVE',
  };
}

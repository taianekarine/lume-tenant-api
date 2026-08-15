import {
  ALL_PERMISSION_CODES,
  ASSIGNABLE_DEPARTMENTS,
  type PermissionCode,
  presentUserDepartment,
  type PresentedUserDepartment,
} from '../../domain/access/access.constants';
import {
  filterPermissionCodesForDepartments,
  resolveEffectivePermissions,
} from '../../domain/access/resolve-permissions';
import type { UserAccountStatus } from '../../domain/entities/user';
import type {
  MaritalStatus,
  MilitaryDocumentStatus,
  UserDependent,
} from '../../domain/entities/user';
import type { UserClientCategory } from '../../domain/entities/user';
import type { UserRecord } from '../contracts/repositories';

export interface UserOutput {
  id: string;
  routingCompanyId: string | null;
  name: string;
  username: string;
  email: string;
  cpf: string | null;
  type: 'employee' | 'candidate' | 'client';
  isAdministrator: boolean;
  documentAccessMode?: 'standard' | 'document-portal' | 'client';
  jobTitle: string | null;
  maritalStatus: MaritalStatus | null;
  militaryDocumentStatus: MilitaryDocumentStatus;
  dependents: UserDependent[];
  departments: PresentedUserDepartment[];
  permissionCodes: PermissionCode[];
  permissions: PermissionCode[];
  clientCategory: UserClientCategory | null;
  isActive: boolean;
  status: UserAccountStatus;
  suspendedUntil: string | null;
  suspensionReason: string | null;
  mustChangePassword: boolean;
  hasProfilePicture: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedPrincipal extends UserOutput {
  companyId: string;
  tokenVersion: number;
}

export function presentUser(record: UserRecord): UserOutput {
  const { user } = record;
  const permissionCodes = user.props.isAdministrator
    ? [...ALL_PERMISSION_CODES]
    : filterPermissionCodesForDepartments(
        user.props.departments,
        user.props.permissionCodes,
      );

  return {
    id: user.props.id,
    routingCompanyId: user.props.routingCompanyId,
    name: user.props.name,
    username: user.props.username,
    email: user.props.email,
    cpf: user.props.cpfNormalized,
    type:
      user.props.documentAccessMode === 'client'
        ? 'client'
        : user.props.documentAccessMode === 'document-portal'
          ? 'candidate'
          : 'employee',
    isAdministrator: user.props.isAdministrator,
    documentAccessMode: user.props.documentAccessMode ?? 'standard',
    jobTitle: user.props.jobTitle,
    maritalStatus: user.props.maritalStatus,
    militaryDocumentStatus: user.props.militaryDocumentStatus,
    dependents: user.props.dependents,
    departments: user.props.isAdministrator
      ? [...ASSIGNABLE_DEPARTMENTS]
      : user.props.departments.map(presentUserDepartment),
    permissionCodes,
    permissions: resolveEffectivePermissions(
      user.props.departments,
      permissionCodes,
      user.props.isAdministrator,
      user.props.documentAccessMode,
    ),
    clientCategory: user.props.clientCategory,
    isActive: user.props.isActive,
    status: user.props.status,
    suspendedUntil: user.props.suspendedUntil?.toISOString() ?? null,
    suspensionReason: user.props.suspensionReason,
    mustChangePassword: user.props.mustChangePassword,
    hasProfilePicture: Boolean(user.props.profilePictureMime),
    createdAt: user.props.createdAt.toISOString(),
    updatedAt: user.props.updatedAt.toISOString(),
  };
}

export function toAuthenticatedPrincipal(
  record: UserRecord,
): AuthenticatedPrincipal {
  return {
    ...presentUser(record),
    companyId: record.user.props.companyId,
    tokenVersion: record.user.props.tokenVersion,
  };
}

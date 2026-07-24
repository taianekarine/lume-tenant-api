import {
  type Department,
  type PermissionCode,
} from '../../domain/access/access.constants';
import { resolveEffectivePermissions } from '../../domain/access/resolve-permissions';
import type { Role } from '../../domain/entities/role';
import type { UserWithRoles } from '../contracts/repositories';

export interface UserOutput {
  id: string;
  name: string;
  username: string;
  email: string;
  cpf: string | null;
  type: 'employee';
  departments: Department[];
  roles: string[];
  permissions: PermissionCode[];
  clientCategory: null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedPrincipal extends UserOutput {
  companyId: string;
  tokenVersion: number;
}

function roleCodes(roles: readonly Role[]): string[] {
  return roles.map((role) => role.code).sort();
}

export function presentUser(record: UserWithRoles): UserOutput {
  const { user, roles } = record;

  return {
    id: user.props.id,
    name: user.props.name,
    username: user.props.username,
    email: user.props.email,
    cpf: user.props.cpfNormalized,
    type: 'employee',
    departments: [...user.props.departments],
    roles: roleCodes(roles),
    permissions: resolveEffectivePermissions(user.props.departments, roles),
    clientCategory: null,
    isActive: user.props.isActive,
    createdAt: user.props.createdAt.toISOString(),
    updatedAt: user.props.updatedAt.toISOString(),
  };
}

export function toAuthenticatedPrincipal(
  record: UserWithRoles,
): AuthenticatedPrincipal {
  return {
    ...presentUser(record),
    companyId: record.user.props.companyId,
    tokenVersion: record.user.props.tokenVersion,
  };
}

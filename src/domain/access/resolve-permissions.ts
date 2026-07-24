import {
  DEFAULT_DEPARTMENT_PERMISSIONS,
  type Department,
  type PermissionCode,
} from './access.constants';
import type { Role } from '../entities/role';

export function resolveEffectivePermissions(
  departments: readonly Department[],
  roles: readonly Role[],
): PermissionCode[] {
  const permissions = new Set<PermissionCode>();

  for (const department of departments) {
    for (const permission of DEFAULT_DEPARTMENT_PERMISSIONS[department]) {
      permissions.add(permission);
    }
  }

  for (const role of roles) {
    for (const permission of role.permissionCodes) {
      permissions.add(permission);
    }
  }

  return Array.from(permissions).sort();
}

import {
  ALL_PERMISSION_CODES,
  EMPLOYEE_SELF_SERVICE_PERMISSIONS,
  allowedPermissionsForDepartments,
  type PermissionCode,
  type SupportedUserDepartment,
} from './access.constants';

export function filterPermissionCodesForDepartments(
  departments: readonly SupportedUserDepartment[],
  permissionCodes: readonly PermissionCode[],
): PermissionCode[] {
  const ceiling = new Set(allowedPermissionsForDepartments(departments));

  return Array.from(
    new Set(permissionCodes.filter((permission) => ceiling.has(permission))),
  ).sort();
}

export function resolveEffectivePermissions(
  departments: readonly SupportedUserDepartment[],
  individualPermissions: readonly PermissionCode[] = [],
  isAdministrator = false,
  documentAccessMode: 'standard' | 'document-portal' = 'standard',
): PermissionCode[] {
  if (isAdministrator) {
    return [...ALL_PERMISSION_CODES];
  }

  if (documentAccessMode === 'document-portal') {
    return [
      'documents:view',
      'documents:create',
      'documents:update',
      'profile:view',
      'profile:update',
      'support:view',
      'support:create',
    ];
  }

  const permissions = new Set<PermissionCode>(
    EMPLOYEE_SELF_SERVICE_PERMISSIONS,
  );

  if (departments.includes('information-technology')) {
    permissions.add('users:view');
    permissions.add('users:create');
    permissions.add('users:update');
    permissions.add('users:manage');
  }

  for (const permission of filterPermissionCodesForDepartments(
    departments,
    individualPermissions,
  )) {
    permissions.add(permission);
  }

  return Array.from(permissions).sort();
}

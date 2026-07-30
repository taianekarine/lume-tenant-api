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
): PermissionCode[] {
  if (isAdministrator) {
    return [...ALL_PERMISSION_CODES];
  }

  const permissions = new Set<PermissionCode>(
    EMPLOYEE_SELF_SERVICE_PERMISSIONS,
  );

  for (const permission of filterPermissionCodesForDepartments(
    departments,
    individualPermissions,
  )) {
    permissions.add(permission);
  }

  return Array.from(permissions).sort();
}

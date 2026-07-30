import {
  ALL_PERMISSION_CODES,
  ASSIGNABLE_DEPARTMENTS,
  ASSIGNABLE_DEPARTMENT_LABELS,
  EMPLOYEE_SELF_SERVICE_PERMISSIONS,
  PERMISSION_ACTIONS,
  PERMISSION_ACTIONS_BY_RESOURCE,
  PERMISSION_RESOURCES,
  allowedPermissionsForDepartments,
} from '../../../domain/access/access.constants';

export class ListPermissionsUseCase {
  execute() {
    const permissionsByDepartment = Object.fromEntries(
      ASSIGNABLE_DEPARTMENTS.map((department) => [
        department,
        allowedPermissionsForDepartments([department]),
      ]),
    );

    return {
      resources: [...PERMISSION_RESOURCES],
      actions: [...PERMISSION_ACTIONS],
      actionsByResource: PERMISSION_ACTIONS_BY_RESOURCE,
      permissions: [...ALL_PERMISSION_CODES],
      implicitPermissions: [...EMPLOYEE_SELF_SERVICE_PERMISSIONS],
      permissionsByDepartment,
      departments: ASSIGNABLE_DEPARTMENTS.map((code) => ({
        code,
        name: ASSIGNABLE_DEPARTMENT_LABELS[code],
      })),
    };
  }
}

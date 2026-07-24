import type { Role } from '../../domain/entities/role';

export function presentRole(role: Role) {
  return {
    id: role.props.id,
    code: role.props.code,
    name: role.props.name,
    description: role.props.description,
    permissions: [...role.props.permissionCodes],
    isSystem: role.props.isSystem,
    createdAt: role.props.createdAt.toISOString(),
    updatedAt: role.props.updatedAt.toISOString(),
  };
}

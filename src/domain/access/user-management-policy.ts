import { forbidden } from '../../core/errors/app-error';
export interface UserManagementIdentity {
  readonly id: string;
  readonly isAdministrator: boolean;
  readonly departments: readonly string[];
}

export type UserManagementRole =
  'administrator' | 'information-technology' | 'people-operations' | 'none';

export function resolveUserManagementRole(
  actor: UserManagementIdentity,
): UserManagementRole {
  if (actor.isAdministrator) return 'administrator';
  if (actor.departments.includes('information-technology')) {
    return 'information-technology';
  }
  if (
    actor.departments.some((department) =>
      ['human-resources', 'personnel-department'].includes(department),
    )
  ) {
    return 'people-operations';
  }
  return 'none';
}

export function assertCanAccessUserCatalog(
  actor: UserManagementIdentity,
): UserManagementRole {
  const role = resolveUserManagementRole(actor);
  if (role === 'none') {
    throw forbidden(
      'Você não possui permissão para acessar a administração de usuários.',
    );
  }
  return role;
}

export function assertCanAccessUserTarget(
  actor: UserManagementIdentity,
  target: UserManagementIdentity,
): UserManagementRole {
  const role = assertCanAccessUserCatalog(actor);
  if (
    role === 'information-technology' &&
    (target.id === actor.id || target.isAdministrator)
  ) {
    throw forbidden(
      target.id === actor.id
        ? 'A equipe de TI não pode alterar a própria conta pela administração de usuários. Use Meu perfil para seus dados pessoais.'
        : 'Somente administradores podem gerenciar uma conta administradora.',
    );
  }
  return role;
}

export function assertCanManageUserTarget(
  actor: UserManagementIdentity,
  target: UserManagementIdentity,
): UserManagementRole {
  const role = assertCanAccessUserTarget(actor, target);
  if (role === 'people-operations') {
    throw forbidden(
      'RH e Departamento Pessoal podem criar o acesso documental inicial, mas não gerenciar acessos existentes.',
    );
  }
  return role;
}

import { conflict, notFound } from '../../../core/errors/app-error';
import {
  ALL_PERMISSION_CODES,
  PERMISSION_ACTIONS,
  PERMISSION_ACTIONS_BY_RESOURCE,
  PERMISSION_RESOURCES,
} from '../../../domain/access/access.constants';
import { Role } from '../../../domain/entities/role';
import { RolesRepository } from '../../contracts/repositories';
import { presentRole } from '../../presenters/role.presenter';

export class ListRolesUseCase {
  constructor(private readonly roles: RolesRepository) {}

  async execute(companyId: string) {
    return (await this.roles.list(companyId)).map(presentRole);
  }
}

export interface CreateRoleInput {
  companyId: string;
  code: string;
  name: string;
  description?: string;
  permissions: string[];
}

export class CreateRoleUseCase {
  constructor(private readonly roles: RolesRepository) {}

  async execute(input: CreateRoleInput) {
    if (
      await this.roles.codeExists(
        input.companyId,
        input.code.toLocaleLowerCase('pt-BR'),
      )
    ) {
      throw conflict('Já existe um papel com este código.', 'code');
    }

    return presentRole(
      await this.roles.create(
        Role.create({
          companyId: input.companyId,
          code: input.code,
          name: input.name,
          description: input.description,
          permissionCodes: input.permissions,
        }),
      ),
    );
  }
}

export interface UpdateRoleInput {
  companyId: string;
  roleId: string;
  code?: string;
  name?: string;
  description?: string | null;
  permissions?: string[];
}

export class UpdateRoleUseCase {
  constructor(private readonly roles: RolesRepository) {}

  async execute(input: UpdateRoleInput) {
    const current = await this.roles.findById(input.companyId, input.roleId);

    if (!current) {
      throw notFound('Papel');
    }

    if (current.isSystem) {
      throw conflict('Papéis padrão do sistema não podem ser alterados.');
    }

    const code = input.code?.toLocaleLowerCase('pt-BR') ?? current.code;

    if (await this.roles.codeExists(input.companyId, code, current.id)) {
      throw conflict('Já existe um papel com este código.', 'code');
    }

    const updated = Role.restore({
      ...current.props,
      code,
      name: input.name?.trim() ?? current.name,
      description:
        input.description === undefined
          ? current.description
          : input.description?.trim() || null,
      permissionCodes: input.permissions
        ? Role.create({
            companyId: input.companyId,
            code,
            name: input.name ?? current.name,
            permissionCodes: input.permissions,
          }).permissionCodes
        : current.permissionCodes,
      updatedAt: new Date(),
    });

    return presentRole(await this.roles.update(updated));
  }
}

export class DeleteRoleUseCase {
  constructor(private readonly roles: RolesRepository) {}

  async execute(companyId: string, roleId: string): Promise<void> {
    const role = await this.roles.findById(companyId, roleId);

    if (!role) {
      throw notFound('Papel');
    }

    if (role.isSystem) {
      throw conflict('Papéis padrão do sistema não podem ser excluídos.');
    }

    if ((await this.roles.countAssignments(companyId, roleId)) > 0) {
      throw conflict('Remova este papel dos usuários antes de excluí-lo.');
    }

    await this.roles.delete(companyId, roleId);
  }
}

export class ListPermissionsUseCase {
  execute() {
    return {
      resources: [...PERMISSION_RESOURCES],
      actions: [...PERMISSION_ACTIONS],
      actionsByResource: PERMISSION_ACTIONS_BY_RESOURCE,
      permissions: [...ALL_PERMISSION_CODES],
    };
  }
}

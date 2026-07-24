import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import type { Department } from '../../../domain/access/access.constants';
import { isValidCpf } from '../../../shared/utils/brazilian-documents';
import {
  normalizeCpf,
  normalizeEmail,
} from '../../../shared/utils/normalization';
import {
  RolesRepository,
  TenantAuditLogsRepository,
  UsersRepository,
} from '../../contracts/repositories';
import { presentUser } from '../../presenters/user.presenter';

export interface UpdateUserInput {
  companyId: string;
  currentUserId?: string;
  actorUserId?: string;
  userId: string;
  name?: string;
  email?: string;
  cpf?: string | null;
  departments?: Department[];
  roleIds?: string[];
  isActive?: boolean;
}

export class UpdateUserUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly roles: RolesRepository,
    private readonly auditLogs?: TenantAuditLogsRepository,
  ) {}

  async execute(input: UpdateUserInput) {
    const target = await this.users.findById(input.companyId, input.userId);

    if (!target) {
      throw notFound('Usuário');
    }

    if (
      input.currentUserId &&
      input.userId === input.currentUserId &&
      input.isActive === false
    ) {
      throw forbidden('Você não pode desativar o próprio usuário.');
    }

    const emailNormalized = input.email
      ? normalizeEmail(input.email)
      : undefined;
    const cpfNormalized =
      input.cpf !== undefined ? normalizeCpf(input.cpf) : undefined;

    if (cpfNormalized && !isValidCpf(cpfNormalized)) {
      throw validationError('Informe um CPF válido.');
    }

    const roleIds = input.roleIds
      ? Array.from(new Set(input.roleIds))
      : undefined;
    const departments = input.departments
      ? Array.from(new Set(input.departments))
      : undefined;

    const [identifierConflict, selectedRoles, administratorRole] =
      await Promise.all([
        this.users.loginIdentifierExists({
          emailNormalized,
          cpfNormalized,
          exceptUserId: input.userId,
        }),
        roleIds
          ? this.roles.findByIds(input.companyId, roleIds)
          : Promise.resolve([]),
        this.roles.findByCode(input.companyId, 'administrator'),
      ]);

    if (identifierConflict) {
      throw conflict(
        `Já existe um usuário cadastrado com este ${identifierConflict}.`,
        identifierConflict,
      );
    }

    if (roleIds && selectedRoles.length !== roleIds.length) {
      throw validationError(
        'Um ou mais papéis não pertencem à empresa autenticada.',
      );
    }

    const currentlyAdministrator = Boolean(
      administratorRole &&
      target.roles.some((role) => role.id === administratorRole.id),
    );
    const willRemainAdministrator = Boolean(
      administratorRole && (!roleIds || roleIds.includes(administratorRole.id)),
    );
    const removesLastAdministrator =
      currentlyAdministrator &&
      target.user.props.isActive &&
      (!willRemainAdministrator || input.isActive === false) &&
      administratorRole &&
      (await this.users.countActiveByRole(
        input.companyId,
        administratorRole.id,
      )) <= 1;

    if (removesLastAdministrator) {
      throw conflict('A empresa deve manter ao menos um administrador ativo.');
    }

    const finalRoleCount = roleIds?.length ?? target.roles.length;
    const finalDepartmentCount =
      departments?.length ?? target.user.props.departments.length;

    if (finalRoleCount === 0 && finalDepartmentCount === 0) {
      throw validationError(
        'Informe ao menos um departamento ou papel para o usuário.',
      );
    }

    const updated = await this.users.update(input.companyId, input.userId, {
      name: input.name?.trim(),
      email: input.email?.trim(),
      emailNormalized,
      cpfNormalized,
      departments,
      roleIds,
      isActive: input.isActive,
    });
    if (this.auditLogs) {
      await this.auditLogs.create({
        companyId: input.companyId,
        actorUserId: input.actorUserId,
        action: 'USER_UPDATED',
        targetType: 'user',
        targetId: input.userId,
        metadata: {
          changedFields: [
            'name',
            'email',
            'cpf',
            'departments',
            'roleIds',
            'isActive',
          ].filter(
            (field) => input[field as keyof UpdateUserInput] !== undefined,
          ),
        },
      });
    }
    return presentUser(updated);
  }
}

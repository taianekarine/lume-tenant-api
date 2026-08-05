import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import {
  allowedPermissionsForDepartments,
  isPermissionCode,
  normalizeUserDepartments,
  type PermissionCode,
  type SupportedUserDepartment,
} from '../../../domain/access/access.constants';
import { isValidCpf } from '../../../shared/utils/brazilian-documents';
import type {
  DocumentAccessMode,
  MaritalStatus,
  MilitaryDocumentStatus,
  UserDependent,
} from '../../../domain/entities/user';
import {
  normalizeCpf,
  normalizeEmail,
} from '../../../shared/utils/normalization';
import {
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
  isAdministrator?: boolean;
  documentAccessMode?: DocumentAccessMode;
  jobTitle?: string | null;
  maritalStatus?: MaritalStatus | null;
  militaryDocumentStatus?: MilitaryDocumentStatus;
  dependents?: UserDependent[];
  departments?: SupportedUserDepartment[];
  permissionCodes?: PermissionCode[];
}

export class UpdateUserUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly auditLogs?: TenantAuditLogsRepository,
  ) {}

  async execute(input: UpdateUserInput) {
    const target = await this.users.findById(input.companyId, input.userId);

    if (!target) {
      throw notFound('Usuário');
    }

    const emailNormalized = input.email
      ? normalizeEmail(input.email)
      : undefined;
    const cpfNormalized =
      input.cpf !== undefined ? normalizeCpf(input.cpf) : undefined;

    if (cpfNormalized && !isValidCpf(cpfNormalized)) {
      throw validationError('Informe um CPF válido.');
    }

    const departments = input.departments
      ? normalizeUserDepartments(input.departments)
      : undefined;
    const permissionCodes = input.permissionCodes
      ? Array.from(new Set(input.permissionCodes)).sort()
      : undefined;

    const identifierConflict = await this.users.loginIdentifierExists({
      emailNormalized,
      cpfNormalized,
      exceptUserId: input.userId,
    });

    if (identifierConflict) {
      throw conflict(
        `Já existe um usuário cadastrado com este ${identifierConflict}.`,
        identifierConflict,
      );
    }

    const finalIsAdministrator =
      input.isAdministrator ?? target.user.props.isAdministrator;
    const administratorChanged =
      finalIsAdministrator !== target.user.props.isAdministrator;

    if (target.user.props.isAdministrator || administratorChanged) {
      const actorId = input.actorUserId ?? input.currentUserId;
      const actor = actorId
        ? await this.users.findById(input.companyId, actorId)
        : null;
      if (!actor?.user.props.isAdministrator) {
        throw forbidden(
          'Somente outro administrador pode alterar uma conta administradora.',
        );
      }
      if (input.currentUserId === input.userId && !finalIsAdministrator) {
        throw forbidden(
          'Você não pode remover o próprio acesso de administrador.',
        );
      }
    }

    if (
      target.user.props.isAdministrator &&
      !finalIsAdministrator &&
      (input.departments === undefined || input.permissionCodes === undefined)
    ) {
      throw validationError(
        'Ao remover o acesso de administrador, informe departamentos e permissões diretas.',
      );
    }

    const finalDepartments = finalIsAdministrator
      ? []
      : (departments ?? target.user.props.departments);
    const finalPermissionCodes = finalIsAdministrator
      ? []
      : (permissionCodes ?? target.user.props.permissionCodes);

    if (!finalIsAdministrator && finalDepartments.length === 0) {
      throw validationError('Informe ao menos um departamento para o usuário.');
    }
    const allowedPermissions = new Set(
      allowedPermissionsForDepartments(finalDepartments),
    );
    if (
      !finalIsAdministrator &&
      finalPermissionCodes.some(
        (permission) =>
          !isPermissionCode(permission) || !allowedPermissions.has(permission),
      )
    ) {
      throw validationError(
        'Uma ou mais permissões não são permitidas para os departamentos selecionados.',
      );
    }

    const isActiveAdministrator =
      target.user.props.isActive &&
      target.user.props.status === 'active' &&
      target.user.props.isAdministrator;

    const persistenceInput = {
      name: input.name?.trim(),
      email: input.email?.trim(),
      emailNormalized,
      cpfNormalized,
      isAdministrator:
        input.isAdministrator === undefined ? undefined : finalIsAdministrator,
      documentAccessMode: input.documentAccessMode,
      jobTitle:
        input.jobTitle === undefined
          ? undefined
          : input.jobTitle?.trim() || null,
      maritalStatus: input.maritalStatus,
      militaryDocumentStatus: input.militaryDocumentStatus,
      dependents: input.dependents,
      departments: finalIsAdministrator ? [] : departments,
      permissionCodes: finalIsAdministrator ? [] : permissionCodes,
    };
    const updated =
      isActiveAdministrator && !finalIsAdministrator
        ? await this.users.updateWithAdministratorInvariant(
            input.companyId,
            input.userId,
            persistenceInput,
          )
        : await this.users.update(
            input.companyId,
            input.userId,
            persistenceInput,
          );
    if (!updated) {
      throw conflict('A empresa deve manter ao menos um administrador ativo.');
    }
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
            'isAdministrator',
            'documentAccessMode',
            'jobTitle',
            'maritalStatus',
            'militaryDocumentStatus',
            'dependents',
            'departments',
            'permissionCodes',
          ].filter(
            (field) => input[field as keyof UpdateUserInput] !== undefined,
          ),
        },
      });
    }
    return presentUser(updated);
  }
}

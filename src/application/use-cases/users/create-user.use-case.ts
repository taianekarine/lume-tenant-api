import {
  conflict,
  forbidden,
  validationError,
} from '../../../core/errors/app-error';
import {
  allowedPermissionsForDepartments,
  isPermissionCode,
  normalizeUserDepartments,
  type PermissionCode,
  type SupportedUserDepartment,
} from '../../../domain/access/access.constants';
import { isValidUsername, User } from '../../../domain/entities/user';
import { isValidCpf } from '../../../shared/utils/brazilian-documents';
import {
  normalizeCpf,
  normalizeEmail,
  normalizeUsername,
} from '../../../shared/utils/normalization';
import { PasswordHasher } from '../../contracts/cryptography';
import {
  TenantAuditLogsRepository,
  UsersRepository,
} from '../../contracts/repositories';
import { presentUser } from '../../presenters/user.presenter';

export interface CreateUserInput {
  companyId: string;
  actorUserId?: string;
  name: string;
  username: string;
  email: string;
  cpf?: string;
  password: string;
  isAdministrator?: boolean;
  departments: SupportedUserDepartment[];
  permissionCodes: PermissionCode[];
}

export class CreateUserUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly auditLogs?: TenantAuditLogsRepository,
  ) {}

  async execute(input: CreateUserInput) {
    const isAdministrator = input.isAdministrator === true;
    if (isAdministrator) {
      const actor = input.actorUserId
        ? await this.users.findById(input.companyId, input.actorUserId)
        : null;
      if (!actor?.user.props.isAdministrator) {
        throw forbidden(
          'Somente outro administrador pode criar uma conta administradora.',
        );
      }
    }
    const departments = isAdministrator
      ? []
      : normalizeUserDepartments(input.departments);

    if (!isAdministrator && departments.length === 0) {
      throw validationError('Informe ao menos um departamento para o usuário.');
    }
    const permissionCodes = isAdministrator
      ? []
      : Array.from(new Set(input.permissionCodes)).sort();
    const allowedPermissions = new Set(
      allowedPermissionsForDepartments(input.departments),
    );
    if (
      !isAdministrator &&
      permissionCodes.some(
        (permission) =>
          !isPermissionCode(permission) || !allowedPermissions.has(permission),
      )
    ) {
      throw validationError(
        'Uma ou mais permissões não são permitidas para os departamentos selecionados.',
      );
    }

    const usernameNormalized = normalizeUsername(input.username);
    if (!isValidUsername(usernameNormalized)) {
      throw validationError(
        'O usuário deve possuir entre 3 e 40 caracteres permitidos e ao menos uma letra.',
      );
    }
    const emailNormalized = normalizeEmail(input.email);
    const cpfNormalized = normalizeCpf(input.cpf);

    if (cpfNormalized && !isValidCpf(cpfNormalized)) {
      throw validationError('Informe um CPF válido.');
    }

    const identifierConflict = await this.users.loginIdentifierExists({
      usernameNormalized,
      emailNormalized,
      cpfNormalized,
    });

    if (identifierConflict) {
      throw conflict(
        `Já existe um usuário cadastrado com este ${identifierConflict}.`,
        identifierConflict,
      );
    }

    const user = User.create({
      companyId: input.companyId,
      name: input.name.trim(),
      username: input.username.trim(),
      usernameNormalized,
      email: input.email.trim(),
      emailNormalized,
      cpfNormalized,
      passwordHash: await this.passwordHasher.hash(input.password),
      mustChangePassword: true,
      isAdministrator,
      departments,
      permissionCodes,
    });

    const created = await this.users.create(user);
    if (this.auditLogs) {
      await this.auditLogs.create({
        companyId: input.companyId,
        actorUserId: input.actorUserId,
        action: 'USER_CREATED',
        targetType: 'user',
        targetId: user.id,
        metadata: { isAdministrator, departments, permissionCodes },
      });
    }
    return presentUser(created);
  }
}

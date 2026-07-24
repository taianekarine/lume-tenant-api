import { conflict, validationError } from '../../../core/errors/app-error';
import { type Department } from '../../../domain/access/access.constants';
import { User } from '../../../domain/entities/user';
import { isValidCpf } from '../../../shared/utils/brazilian-documents';
import {
  normalizeCpf,
  normalizeEmail,
  normalizeUsername,
} from '../../../shared/utils/normalization';
import { PasswordHasher } from '../../contracts/cryptography';
import {
  RolesRepository,
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
  departments: Department[];
  roleIds: string[];
}

export class CreateUserUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly roles: RolesRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly auditLogs?: TenantAuditLogsRepository,
  ) {}

  async execute(input: CreateUserInput) {
    const roleIds = Array.from(new Set(input.roleIds));
    const departments = Array.from(new Set(input.departments));

    if (roleIds.length === 0 && departments.length === 0) {
      throw validationError(
        'Informe ao menos um departamento ou papel para o usuário.',
      );
    }

    const usernameNormalized = normalizeUsername(input.username);
    const emailNormalized = normalizeEmail(input.email);
    const cpfNormalized = normalizeCpf(input.cpf);

    if (cpfNormalized && !isValidCpf(cpfNormalized)) {
      throw validationError('Informe um CPF válido.');
    }

    const [identifierConflict, selectedRoles] = await Promise.all([
      this.users.loginIdentifierExists({
        usernameNormalized,
        emailNormalized,
        cpfNormalized,
      }),
      this.roles.findByIds(input.companyId, roleIds),
    ]);

    if (identifierConflict) {
      throw conflict(
        `Já existe um usuário cadastrado com este ${identifierConflict}.`,
        identifierConflict,
      );
    }

    if (selectedRoles.length !== roleIds.length) {
      throw validationError(
        'Um ou mais papéis não pertencem à empresa autenticada.',
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
      departments,
    });

    const created = await this.users.create(user, roleIds);
    if (this.auditLogs) {
      await this.auditLogs.create({
        companyId: input.companyId,
        actorUserId: input.actorUserId,
        action: 'USER_CREATED',
        targetType: 'user',
        targetId: user.id,
        metadata: { roleIds, departments },
      });
    }
    return presentUser(created);
  }
}

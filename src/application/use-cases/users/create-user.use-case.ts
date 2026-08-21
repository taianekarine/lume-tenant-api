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
import { resolveUserManagementRole } from '../../../domain/access/user-management-policy';
import {
  isValidUsername,
  User,
  type DocumentAccessMode,
  type MaritalStatus,
  type MilitaryDocumentStatus,
  type UserClientCategory,
  type UserDependent,
} from '../../../domain/entities/user';
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
import { RoutingRepository } from '../../contracts/routing.repository';

export interface CreateUserInput {
  companyId: string;
  actorUserId?: string;
  routingCompanyId?: string;
  name: string;
  username: string;
  email: string;
  cpf?: string;
  password: string;
  isAdministrator?: boolean;
  documentAccessMode?: DocumentAccessMode;
  clientCategory?: UserClientCategory;
  jobTitle?: string;
  maritalStatus?: MaritalStatus;
  militaryDocumentStatus?: MilitaryDocumentStatus;
  dependents?: UserDependent[];
  departments: SupportedUserDepartment[];
  permissionCodes: PermissionCode[];
}

export class CreateUserUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly auditLogs?: TenantAuditLogsRepository,
    private readonly routing?: RoutingRepository,
  ) {}

  async execute(input: CreateUserInput) {
    const actor = input.actorUserId
      ? await this.users.findById(input.companyId, input.actorUserId)
      : null;
    if (input.actorUserId && !actor) {
      throw forbidden('O usuário responsável pela criação não foi encontrado.');
    }

    const actorRole = actor
      ? resolveUserManagementRole(actor.user.props)
      : null;
    const actorIsAdministrator = actorRole === 'administrator';
    const isAdministrator = input.isAdministrator === true;

    if (input.actorUserId && !actorIsAdministrator) {
      if (actorRole === 'none') {
        throw forbidden(
          'Somente administradores, TI, RH e Departamento Pessoal podem criar acessos.',
        );
      }
      if (actorRole === 'information-technology' && isAdministrator) {
        throw forbidden(
          'Somente administradores podem criar uma conta administradora.',
        );
      }
      if (actorRole === 'delegated' && isAdministrator) {
        throw forbidden(
          'Somente administradores podem criar uma conta administradora.',
        );
      }
      if (
        actorRole === 'delegated' &&
        input.permissionCodes.some(
          (permission) =>
            !actor?.user.props.permissionCodes.includes(permission),
        )
      ) {
        throw forbidden(
          'Um usuÃ¡rio delegado sÃ³ pode conceder permissÃµes que ele prÃ³prio possui.',
        );
      }
      if (
        actorRole === 'information-technology' &&
        input.permissionCodes.some((permission) =>
          permission.startsWith('license:'),
        )
      ) {
        throw forbidden(
          'Somente administradores podem conceder acesso à licença.',
        );
      }
      if (
        actorRole === 'people-operations' &&
        (isAdministrator ||
          input.documentAccessMode !== 'document-portal' ||
          input.departments.length > 0 ||
          input.permissionCodes.length > 0)
      ) {
        throw forbidden(
          'RH e Departamento Pessoal podem criar somente o acesso inicial ao portal de documentos, sem departamentos ou permissões adicionais.',
        );
      }
    }
    if (isAdministrator && !actorIsAdministrator) {
      throw forbidden(
        'Somente outro administrador pode criar uma conta administradora.',
      );
    }
    if (
      input.permissionCodes.includes('clients:history') &&
      !actorIsAdministrator
    ) {
      throw forbidden(
        'Somente administradores podem conceder a permissão de visualizar o histórico de clientes.',
      );
    }

    const documentAccessMode = input.documentAccessMode ?? 'standard';
    const departments = isAdministrator
      ? []
      : normalizeUserDepartments(input.departments);
    const clientCategory = isAdministrator
      ? null
      : (input.clientCategory ?? null);

    if (documentAccessMode === 'client') {
      if (
        isAdministrator ||
        departments.length !== 1 ||
        departments[0] !== 'client-company' ||
        !clientCategory
      ) {
        throw validationError(
          'O acesso Cliente deve informar o tipo PF ou PJ e usar exclusivamente o perfil Empresa cliente.',
        );
      }

      if (!input.routingCompanyId) {
        throw validationError(
          'Selecione o cliente PF ou PJ vinculado a este acesso.',
        );
      }
      const routingCompany = await this.routing?.findCompany(
        input.companyId,
        input.routingCompanyId,
      );
      if (!routingCompany || routingCompany.status !== 'active') {
        throw validationError('Selecione um cliente ativo.');
      }
    } else if (
      clientCategory ||
      input.routingCompanyId ||
      departments.includes('client-company')
    ) {
      throw validationError(
        'O perfil Empresa cliente e o vinculo com cliente atendido exigem o modo de acesso Cliente.',
      );
    }

    if (
      !isAdministrator &&
      documentAccessMode !== 'document-portal' &&
      departments.length === 0
    ) {
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
      routingCompanyId: input.routingCompanyId ?? null,
      name: input.name.trim(),
      username: input.username.trim(),
      usernameNormalized,
      email: input.email.trim(),
      emailNormalized,
      cpfNormalized,
      passwordHash: await this.passwordHasher.hash(input.password),
      mustChangePassword: true,
      isAdministrator,
      documentAccessMode,
      clientCategory,
      jobTitle: input.jobTitle?.trim() || null,
      maritalStatus: input.maritalStatus ?? null,
      militaryDocumentStatus:
        input.militaryDocumentStatus ?? 'pending-confirmation',
      dependents: input.dependents ?? [],
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
        metadata: {
          isAdministrator,
          documentAccessMode,
          clientCategory,
          jobTitle: input.jobTitle?.trim() || null,
          maritalStatus: input.maritalStatus ?? null,
          militaryDocumentStatus:
            input.militaryDocumentStatus ?? 'pending-confirmation',
          dependentCount: input.dependents?.length ?? 0,
          departments,
          permissionCodes,
          routingCompanyId: input.routingCompanyId ?? null,
        },
      });
    }
    return presentUser(created);
  }
}

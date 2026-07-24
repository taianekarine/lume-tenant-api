import { conflict, validationError } from '../../../core/errors/app-error';
import {
  ALL_PERMISSION_CODES,
  DEFAULT_ROLE_PERMISSIONS,
} from '../../../domain/access/access.constants';
import { Company } from '../../../domain/entities/company';
import { Role } from '../../../domain/entities/role';
import { User } from '../../../domain/entities/user';
import { isValidCpf } from '../../../shared/utils/brazilian-documents';
import {
  normalizeCpf,
  normalizeEmail,
  normalizeUsername,
} from '../../../shared/utils/normalization';
import {
  OfflineLicenseVerifier,
  PasswordHasher,
} from '../../contracts/cryptography';
import { TenantBootstrapRepository } from '../../contracts/repositories';

export interface BootstrapTenantInput {
  legalName: string;
  tradeName?: string;
  taxId: string;
  administrator: {
    name: string;
    username: string;
    email: string;
    cpf?: string;
    password: string;
  };
}

export class BootstrapTenantUseCase {
  constructor(
    private readonly tenants: TenantBootstrapRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly license: OfflineLicenseVerifier,
  ) {}

  async execute(input: BootstrapTenantInput) {
    if (await this.tenants.isInitialized()) {
      throw conflict('Esta instalação já possui um tenant configurado.');
    }
    const license = this.license.status().payload;
    const cpfNormalized = normalizeCpf(input.administrator.cpf);
    if (cpfNormalized && !isValidCpf(cpfNormalized)) {
      throw validationError('O CPF informado é inválido.');
    }
    const company = Company.create({
      id: license.tenantId,
      legalName: input.legalName,
      tradeName: input.tradeName,
      taxId: input.taxId,
    });
    const administrator = User.create({
      companyId: company.id,
      name: input.administrator.name.trim(),
      username: input.administrator.username.trim(),
      usernameNormalized: normalizeUsername(input.administrator.username),
      email: input.administrator.email.trim(),
      emailNormalized: normalizeEmail(input.administrator.email),
      cpfNormalized,
      passwordHash: await this.passwordHasher.hash(
        input.administrator.password,
      ),
      departments: [],
    });
    const roles = [
      Role.create({
        companyId: company.id,
        code: 'administrator',
        name: 'Administrador',
        description: 'Acesso completo à instalação.',
        permissionCodes: ALL_PERMISSION_CODES,
        isSystem: true,
      }),
      Role.create({
        companyId: company.id,
        code: 'director',
        name: 'Diretoria',
        permissionCodes: DEFAULT_ROLE_PERMISSIONS.director,
        isSystem: true,
      }),
      Role.create({
        companyId: company.id,
        code: 'manager',
        name: 'Gerência',
        permissionCodes: DEFAULT_ROLE_PERMISSIONS.manager,
        isSystem: true,
      }),
      Role.create({
        companyId: company.id,
        code: 'driver',
        name: 'Motorista',
        permissionCodes: DEFAULT_ROLE_PERMISSIONS.driver,
        isSystem: true,
      }),
    ];
    await this.tenants.createWithAdministrator({
      company,
      administrator,
      roles,
      administratorRoleId: roles[0].id,
    });
    return {
      tenant: {
        id: company.id,
        legalName: company.props.legalName,
        tradeName: company.props.tradeName,
        taxId: company.props.taxId,
      },
      installationId: license.installationId,
      administrator: {
        id: administrator.id,
        name: administrator.props.name,
        username: administrator.props.username,
        email: administrator.props.email,
      },
    };
  }
}

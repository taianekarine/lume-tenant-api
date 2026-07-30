import { conflict, validationError } from '../../../core/errors/app-error';
import {
  ASSIGNABLE_DEPARTMENTS,
  ASSIGNABLE_DEPARTMENT_LABELS,
  normalizeUserDepartment,
} from '../../../domain/access/access.constants';
import { Company } from '../../../domain/entities/company';
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
      mustChangePassword: true,
      isAdministrator: true,
      departments: [],
      permissionCodes: [],
    });
    await this.tenants.createWithAdministrator({
      company,
      administrator,
      departments: ASSIGNABLE_DEPARTMENTS.map((department) => ({
        code: normalizeUserDepartment(department),
        name: ASSIGNABLE_DEPARTMENT_LABELS[department],
        isDefault: department === 'commercial',
      })),
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

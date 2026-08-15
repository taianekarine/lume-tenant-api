import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  OfflineLicenseVerifier,
  PasswordHasher,
} from '../../application/contracts/cryptography';
import { conflict, validationError } from '../../core/errors/app-error';
import {
  ASSIGNABLE_DEPARTMENTS,
  ASSIGNABLE_DEPARTMENT_LABELS,
  type AssignableDepartment,
} from '../../domain/access/access.constants';
import { Company } from '../../domain/entities/company';
import { User } from '../../domain/entities/user';
import { isValidCpf } from '../../shared/utils/brazilian-documents';
import {
  normalizeCpf,
  normalizeEmail,
  normalizeUsername,
  normalizeWhatsAppPhone,
} from '../../shared/utils/normalization';
import {
  DepartmentCode,
  DocumentAccessMode,
  Prisma,
  UserAccountStatus,
  WhatsAppProviderType,
} from '../database/prisma/generated/client';
import { PrismaService } from '../database/prisma/prisma.service';
import { seedInitialDocumentCatalog } from './document-catalog.seed';

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function stillUsesBootstrapPassword(
  passwordHasher: PasswordHasher,
  bootstrapPassword: string,
  currentPasswordHash: string | null,
): Promise<boolean> {
  if (!bootstrapPassword || !currentPasswordHash) return false;
  return passwordHasher.compare(bootstrapPassword, currentPasswordHash);
}

const departmentPersistenceCodes: Readonly<
  Record<AssignableDepartment, DepartmentCode>
> = {
  'client-company': DepartmentCode.CLIENT_COMPANY,
  commercial: DepartmentCode.COMMERCIAL,
  purchasing: DepartmentCode.PURCHASING,
  controllership: DepartmentCode.CONTROLLING,
  'personnel-department': DepartmentCode.PERSONNEL_DEPARTMENT,
  financial: DepartmentCode.FINANCIAL,
  management: DepartmentCode.MANAGEMENT,
  maintenance: DepartmentCode.MAINTENANCE,
  monitoring: DepartmentCode.MONITORING,
  operations: DepartmentCode.OPERATIONS,
  'information-technology': DepartmentCode.INFORMATION_TECHNOLOGY,
};

const tenantDepartments = ASSIGNABLE_DEPARTMENTS.map((publicCode) => ({
  code: departmentPersistenceCodes[publicCode],
  name: ASSIGNABLE_DEPARTMENT_LABELS[publicCode],
  isDefault: publicCode === 'commercial',
}));

@Injectable()
export class ProductionBootstrapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHasher: PasswordHasher,
    private readonly license: OfflineLicenseVerifier,
    private readonly config: ConfigService,
  ) {}

  async execute() {
    const licensedTenantId = this.license.status().payload.tenantId;
    const company = Company.create({
      id: licensedTenantId,
      legalName: this.config.getOrThrow<string>('TENANT_LEGAL_NAME'),
      tradeName: this.config.get<string>('TENANT_TRADE_NAME'),
      taxId: this.config.getOrThrow<string>('TENANT_TAX_ID'),
    });
    const cpfNormalized = normalizeCpf(
      this.config.get<string>('TENANT_ADMIN_CPF'),
    );
    if (cpfNormalized && !isValidCpf(cpfNormalized)) {
      throw validationError('O CPF informado é inválido.');
    }

    const existingCompany = await this.prisma.company.findFirst();
    if (existingCompany && existingCompany.id !== licensedTenantId) {
      throw conflict(
        'A instalação contém um tenant diferente do tenant licenciado.',
      );
    }

    const username = this.config.getOrThrow<string>('TENANT_ADMIN_USERNAME');
    const usernameNormalized = normalizeUsername(username);
    const email = this.config.getOrThrow<string>('TENANT_ADMIN_EMAIL');
    const emailNormalized = normalizeEmail(email);
    const existingAdministrator = await this.prisma.user.findFirst({
      where: { companyId: licensedTenantId, usernameNormalized },
      select: { id: true, passwordHash: true },
    });
    const adminPassword =
      this.config.get<string>('TENANT_ADMIN_PASSWORD')?.trim() ?? '';
    if (!existingAdministrator && adminPassword.length < 12) {
      throw validationError(
        'TENANT_ADMIN_PASSWORD deve possuir ao menos 12 caracteres no primeiro bootstrap.',
      );
    }
    const passwordHash = existingAdministrator
      ? null
      : await this.passwordHasher.hash(adminPassword);
    const requireBootstrapPasswordChange = await stillUsesBootstrapPassword(
      this.passwordHasher,
      adminPassword,
      existingAdministrator?.passwordHash ?? null,
    );
    const now = new Date();
    const whatsappEnabled = this.config.getOrThrow<boolean>('WHATSAPP_ENABLED');

    return this.prisma.$transaction(async (transaction) => {
      await transaction.company.upsert({
        where: { id: licensedTenantId },
        create: company.props,
        update: {
          legalName: company.props.legalName,
          tradeName: company.props.tradeName,
        },
      });

      let administrator = await transaction.user.findFirst({
        where: { companyId: licensedTenantId, usernameNormalized },
      });
      if (!administrator) {
        if (!passwordHash) {
          throw validationError(
            'TENANT_ADMIN_PASSWORD é obrigatório para criar o administrador.',
          );
        }
        const newAdministrator = User.create({
          companyId: licensedTenantId,
          name: this.config.getOrThrow<string>('TENANT_ADMIN_NAME').trim(),
          username: username.trim(),
          usernameNormalized,
          email: email.trim(),
          emailNormalized,
          cpfNormalized,
          passwordHash,
          mustChangePassword: true,
          isAdministrator: true,
          departments: [],
          permissionCodes: [],
        });
        administrator = await transaction.user.create({
          data: {
            ...newAdministrator.props,
            documentAccessMode: DocumentAccessMode.STANDARD,
            clientCategory: null,
            isAdministrator: true,
            departments: [],
            permissionCodes: [],
            dependents: newAdministrator.props
              .dependents as unknown as Prisma.InputJsonValue,
            status: UserAccountStatus.ACTIVE,
          },
        });
      } else {
        administrator = await transaction.user.update({
          where: {
            id_companyId: {
              id: administrator.id,
              companyId: licensedTenantId,
            },
          },
          data: {
            name: this.config.getOrThrow<string>('TENANT_ADMIN_NAME').trim(),
            email: email.trim(),
            emailNormalized,
            cpfNormalized,
            isActive: true,
            status: UserAccountStatus.ACTIVE,
            suspendedUntil: null,
            suspensionReason: null,
            isAdministrator: true,
            departments: [],
            permissionCodes: [],
            ...(requireBootstrapPasswordChange
              ? { mustChangePassword: true }
              : {}),
          },
        });
      }
      let defaultDepartmentId = '';
      for (const department of tenantDepartments) {
        const persistedDepartment = await transaction.tenantDepartment.upsert({
          where: {
            companyId_code: {
              companyId: licensedTenantId,
              code: department.code,
            },
          },
          create: {
            companyId: licensedTenantId,
            ...department,
          },
          update: {
            name: department.name,
            isDefault: department.isDefault,
          },
        });
        if (department.isDefault) {
          defaultDepartmentId = persistedDepartment.id;
        }
      }

      let providerId: string | null = null;
      let channelId: string | null = null;
      if (whatsappEnabled) {
        const provider = await transaction.whatsAppProvider.upsert({
          where: {
            companyId_name: {
              companyId: licensedTenantId,
              name: this.config.getOrThrow<string>('EVOLUTION_PROVIDER_NAME'),
            },
          },
          create: {
            companyId: licensedTenantId,
            name: this.config.getOrThrow<string>('EVOLUTION_PROVIDER_NAME'),
            type: WhatsAppProviderType.EVOLUTION,
            baseUrl: this.config.getOrThrow<string>('EVOLUTION_BASE_URL'),
            apiKeyHash: hashSecret(
              this.config.getOrThrow<string>('EVOLUTION_API_KEY'),
            ),
          },
          update: {
            baseUrl: this.config.getOrThrow<string>('EVOLUTION_BASE_URL'),
            apiKeyHash: hashSecret(
              this.config.getOrThrow<string>('EVOLUTION_API_KEY'),
            ),
            enabled: true,
          },
        });
        providerId = provider.id;
        const configuredChannelId = this.config.getOrThrow<string>(
          'WHATSAPP_CHANNEL_ID',
        );
        const conflictingChannel = await transaction.whatsAppChannel.findUnique(
          {
            where: { id: configuredChannelId },
          },
        );
        if (
          conflictingChannel &&
          conflictingChannel.companyId !== licensedTenantId
        ) {
          throw conflict('WHATSAPP_CHANNEL_ID pertence a outro tenant.');
        }
        const channel = await transaction.whatsAppChannel.upsert({
          where: { id: configuredChannelId },
          create: {
            id: configuredChannelId,
            companyId: licensedTenantId,
            providerId: provider.id,
            name: this.config.getOrThrow<string>('WHATSAPP_CHANNEL_NAME'),
            phoneNumber: normalizeWhatsAppPhone(
              this.config.getOrThrow<string>('WHATSAPP_PHONE_NUMBER'),
            ),
            instanceName: this.config.getOrThrow<string>(
              'EVOLUTION_INSTANCE_NAME',
            ),
            webhookSecretHash: hashSecret(
              this.config.getOrThrow<string>('EVOLUTION_WEBHOOK_SECRET'),
            ),
            ignoreGroups: this.config.getOrThrow<boolean>(
              'WHATSAPP_IGNORE_GROUPS',
            ),
            ignoreFromMe: this.config.getOrThrow<boolean>(
              'WHATSAPP_IGNORE_FROM_ME',
            ),
          },
          update: {
            providerId: provider.id,
            name: this.config.getOrThrow<string>('WHATSAPP_CHANNEL_NAME'),
            phoneNumber: normalizeWhatsAppPhone(
              this.config.getOrThrow<string>('WHATSAPP_PHONE_NUMBER'),
            ),
            instanceName: this.config.getOrThrow<string>(
              'EVOLUTION_INSTANCE_NAME',
            ),
            webhookSecretHash: hashSecret(
              this.config.getOrThrow<string>('EVOLUTION_WEBHOOK_SECRET'),
            ),
            ignoreGroups: this.config.getOrThrow<boolean>(
              'WHATSAPP_IGNORE_GROUPS',
            ),
            ignoreFromMe: this.config.getOrThrow<boolean>(
              'WHATSAPP_IGNORE_FROM_ME',
            ),
            enabled: true,
          },
        });
        channelId = channel.id;
      }

      await seedInitialDocumentCatalog(
        transaction,
        licensedTenantId,
        administrator.id,
      );

      await transaction.tenantAuditLog.create({
        data: {
          companyId: licensedTenantId,
          actorUserId: administrator.id,
          action: 'PRODUCTION_BOOTSTRAP_SYNCED',
          targetType: 'company',
          targetId: licensedTenantId,
          metadata: {
            whatsappEnabled,
            channelId,
            providerId,
            synchronizedAt: now.toISOString(),
          },
        },
      });

      return {
        tenantId: licensedTenantId,
        administratorId: administrator.id,
        departmentId: defaultDepartmentId,
        providerId,
        channelId,
        whatsappEnabled,
      };
    });
  }
}

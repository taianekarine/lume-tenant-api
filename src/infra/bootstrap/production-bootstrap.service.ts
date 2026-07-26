import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  OfflineLicenseVerifier,
  PasswordHasher,
} from '../../application/contracts/cryptography';
import { conflict, validationError } from '../../core/errors/app-error';
import {
  ALL_PERMISSION_CODES,
  DEFAULT_ROLE_PERMISSIONS,
} from '../../domain/access/access.constants';
import { Company } from '../../domain/entities/company';
import { Role } from '../../domain/entities/role';
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
  ServiceIdentityType,
  WhatsAppProviderType,
} from '../database/prisma/generated/client';
import { PrismaService } from '../database/prisma/prisma.service';

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

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
      select: { id: true },
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
    const now = new Date();
    const roles = [
      Role.create({
        companyId: licensedTenantId,
        code: 'administrator',
        name: 'Administrador',
        description: 'Acesso completo à instalação.',
        permissionCodes: ALL_PERMISSION_CODES,
        isSystem: true,
      }),
      Role.create({
        companyId: licensedTenantId,
        code: 'director',
        name: 'Diretoria',
        permissionCodes: DEFAULT_ROLE_PERMISSIONS.director,
        isSystem: true,
      }),
      Role.create({
        companyId: licensedTenantId,
        code: 'manager',
        name: 'Gerência',
        permissionCodes: DEFAULT_ROLE_PERMISSIONS.manager,
        isSystem: true,
      }),
      Role.create({
        companyId: licensedTenantId,
        code: 'driver',
        name: 'Motorista',
        permissionCodes: DEFAULT_ROLE_PERMISSIONS.driver,
        isSystem: true,
      }),
    ];
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

      for (const role of roles) {
        await transaction.role.upsert({
          where: {
            companyId_code: {
              companyId: licensedTenantId,
              code: role.code,
            },
          },
          create: {
            ...role.props,
            permissionCodes: [...role.permissionCodes],
          },
          update: {
            name: role.name,
            description: role.description,
            permissionCodes: [...role.permissionCodes],
            isSystem: true,
          },
        });
      }

      const administratorRole = await transaction.role.findUniqueOrThrow({
        where: {
          companyId_code: {
            companyId: licensedTenantId,
            code: 'administrator',
          },
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
          departments: [],
        });
        administrator = await transaction.user.create({
          data: {
            ...newAdministrator.props,
            departments: [],
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
          },
        });
      }
      await transaction.userRole.upsert({
        where: {
          userId_roleId: {
            userId: administrator.id,
            roleId: administratorRole.id,
          },
        },
        create: {
          companyId: licensedTenantId,
          userId: administrator.id,
          roleId: administratorRole.id,
        },
        update: { companyId: licensedTenantId },
      });

      const department = await transaction.tenantDepartment.upsert({
        where: {
          companyId_code: {
            companyId: licensedTenantId,
            code: DepartmentCode.COMMERCIAL,
          },
        },
        create: {
          companyId: licensedTenantId,
          code: DepartmentCode.COMMERCIAL,
          name: 'Comercial',
          isDefault: true,
        },
        update: { name: 'Comercial', isDefault: true },
      });

      let providerId: string | null = null;
      let channelId: string | null = null;
      let serviceIdentityId: string | null = null;
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

        const keyId = this.config.getOrThrow<string>('N8N_SERVICE_KEY_ID');
        const fullServiceToken = `${keyId}.${this.config.getOrThrow<string>(
          'N8N_SERVICE_SECRET',
        )}`;
        const identity = await transaction.serviceIdentity.upsert({
          where: { keyId },
          create: {
            companyId: licensedTenantId,
            type: ServiceIdentityType.N8N,
            name: this.config.getOrThrow<string>('N8N_SERVICE_NAME'),
            keyId,
            secretHash: hashSecret(fullServiceToken),
          },
          update: {
            name: this.config.getOrThrow<string>('N8N_SERVICE_NAME'),
            secretHash: hashSecret(fullServiceToken),
            enabled: true,
          },
        });
        serviceIdentityId = identity.id;
      }

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
            serviceIdentityId,
            synchronizedAt: now.toISOString(),
          },
        },
      });

      return {
        tenantId: licensedTenantId,
        administratorId: administrator.id,
        departmentId: department.id,
        providerId,
        channelId,
        serviceIdentityId,
        whatsappEnabled,
      };
    });
  }
}

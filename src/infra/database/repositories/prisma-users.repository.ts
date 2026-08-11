import { Injectable } from '@nestjs/common';

import {
  UsersRepository,
  type UpdateUserPersistenceInput,
  type UpdateUserStatusPersistenceInput,
  type UserListQuery,
  type UserListResult,
  type UserProfileRecord,
  type UserRecord,
} from '../../../application/contracts/repositories';
import type { User } from '../../../domain/entities/user';
import {
  departmentsAllowingPermission,
  isImplicitPermissionCode,
} from '../../../domain/access/access.constants';
import {
  DocumentAccessMode as PrismaDocumentAccessMode,
  UserAccountStatus as PrismaUserAccountStatus,
  type Prisma,
} from '../prisma/generated/client';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { mapUserRecord, userRecordSelect } from '../prisma/prisma.mappers';
import { PrismaService } from '../prisma/prisma.service';

const userProfileSelect = {
  id: true,
  name: true,
  username: true,
  email: true,
  profilePicture: true,
  profilePictureMime: true,
} as const satisfies Prisma.UserSelect;

function mapUserProfile(
  row: Prisma.UserGetPayload<{ select: typeof userProfileSelect }>,
): UserProfileRecord {
  return {
    ...row,
    profilePicture: row.profilePicture
      ? new Uint8Array(row.profilePicture)
      : null,
  };
}

function userUpdateData(
  input: UpdateUserPersistenceInput,
): Prisma.UserUncheckedUpdateInput {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.email === undefined ? {} : { email: input.email }),
    ...(input.emailNormalized === undefined
      ? {}
      : { emailNormalized: input.emailNormalized }),
    ...(input.cpfNormalized === undefined
      ? {}
      : { cpfNormalized: input.cpfNormalized }),
    ...(input.isAdministrator === undefined
      ? {}
      : { isAdministrator: input.isAdministrator }),
    ...(input.documentAccessMode === undefined
      ? {}
      : {
          documentAccessMode:
            input.documentAccessMode === 'document-portal'
              ? PrismaDocumentAccessMode.DOCUMENT_PORTAL
              : PrismaDocumentAccessMode.STANDARD,
        }),
    ...(input.jobTitle === undefined ? {} : { jobTitle: input.jobTitle }),
    ...(input.maritalStatus === undefined
      ? {}
      : { maritalStatus: input.maritalStatus }),
    ...(input.militaryDocumentStatus === undefined
      ? {}
      : { militaryDocumentStatus: input.militaryDocumentStatus }),
    ...(input.dependents === undefined
      ? {}
      : { dependents: input.dependents as unknown as Prisma.InputJsonValue }),
    ...(input.departments === undefined
      ? {}
      : { departments: [...input.departments] }),
    ...(input.permissionCodes === undefined
      ? {}
      : { permissionCodes: [...input.permissionCodes] }),
  };
}

function isSerializationConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === 'P2034') return true;
  if (!('cause' in error)) return false;
  const cause = error.cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'kind' in cause &&
    cause.kind === 'TransactionWriteConflict'
  );
}

@Injectable()
export class PrismaUsersRepository extends UsersRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private async retrySerializable<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isSerializationConflict(error) || attempt >= 2) {
          throw error;
        }
      }
    }
  }

  private async reactivateExpiredSuspensions(
    companyId?: string,
    userId?: string,
  ): Promise<void> {
    await this.prisma.user.updateMany({
      where: {
        ...(companyId ? { companyId } : {}),
        ...(userId ? { id: userId } : {}),
        status: PrismaUserAccountStatus.SUSPENDED,
        suspendedUntil: { lte: new Date() },
      },
      data: {
        status: PrismaUserAccountStatus.ACTIVE,
        isActive: true,
        suspendedUntil: null,
        suspensionReason: null,
        tokenVersion: { increment: 1 },
      },
    });
  }

  async loginIdentifierExists(input: {
    usernameNormalized?: string;
    emailNormalized?: string;
    cpfNormalized?: string | null;
    exceptUserId?: string;
  }): Promise<'username' | 'email' | 'cpf' | null> {
    const alternatives: Prisma.UserWhereInput[] = [];

    if (input.usernameNormalized) {
      alternatives.push({ usernameNormalized: input.usernameNormalized });
    }
    if (input.emailNormalized) {
      alternatives.push({ emailNormalized: input.emailNormalized });
    }
    if (input.cpfNormalized) {
      alternatives.push({ cpfNormalized: input.cpfNormalized });
    }
    if (alternatives.length === 0) {
      return null;
    }

    const match = await this.prisma.user.findFirst({
      where: {
        OR: alternatives,
        ...(input.exceptUserId ? { NOT: { id: input.exceptUserId } } : {}),
      },
      select: {
        usernameNormalized: true,
        emailNormalized: true,
        cpfNormalized: true,
      },
    });

    if (!match) {
      return null;
    }
    if (input.usernameNormalized === match.usernameNormalized) {
      return 'username';
    }
    if (input.emailNormalized === match.emailNormalized) {
      return 'email';
    }
    return 'cpf';
  }

  async findByLoginIdentifier(identifier: string): Promise<UserRecord | null> {
    let row = await this.prisma.user.findFirst({
      where: {
        OR: [
          { usernameNormalized: identifier },
          { emailNormalized: identifier },
        ],
      },
      select: userRecordSelect,
    });
    if (
      row?.status === PrismaUserAccountStatus.SUSPENDED &&
      row.suspendedUntil &&
      row.suspendedUntil <= new Date()
    ) {
      await this.reactivateExpiredSuspensions(row.companyId, row.id);
      row = await this.prisma.user.findUnique({
        where: { id_companyId: { id: row.id, companyId: row.companyId } },
        select: userRecordSelect,
      });
    }

    return row ? mapUserRecord(row) : null;
  }

  async findById(
    companyId: string,
    userId: string,
  ): Promise<UserRecord | null> {
    await this.reactivateExpiredSuspensions(companyId, userId);
    const row = await this.prisma.user.findUnique({
      where: { id_companyId: { id: userId, companyId } },
      select: userRecordSelect,
    });

    return row ? mapUserRecord(row) : null;
  }

  async findProfileById(
    companyId: string,
    userId: string,
  ): Promise<UserProfileRecord | null> {
    const row = await this.prisma.user.findUnique({
      where: { id_companyId: { id: userId, companyId } },
      select: userProfileSelect,
    });

    return row ? mapUserProfile(row) : null;
  }

  async create(user: User): Promise<UserRecord> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.user.create({
          data: {
            ...user.props,
            departments: [...user.props.departments],
            permissionCodes: [...user.props.permissionCodes],
            status: PrismaUserAccountStatus.ACTIVE,
            documentAccessMode:
              user.props.documentAccessMode === 'document-portal'
                ? PrismaDocumentAccessMode.DOCUMENT_PORTAL
                : PrismaDocumentAccessMode.STANDARD,
            dependents: user.props
              .dependents as unknown as Prisma.InputJsonValue,
            suspendedUntil: null,
            suspensionReason: null,
          },
        });

        const row = await transaction.user.findUniqueOrThrow({
          where: { id_companyId: { id: user.id, companyId: user.companyId } },
          select: userRecordSelect,
        });

        return mapUserRecord(row);
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async list(companyId: string, query: UserListQuery): Promise<UserListResult> {
    await this.reactivateExpiredSuspensions(companyId);
    const search = query.search?.trim();
    const accessFilters: Prisma.UserWhereInput[] = [];
    if (query.department) {
      accessFilters.push({
        OR: [
          { isAdministrator: true },
          { departments: { has: query.department } },
        ],
      });
    }
    if (query.permission && !isImplicitPermissionCode(query.permission)) {
      accessFilters.push({
        OR: [
          { isAdministrator: true },
          {
            AND: [
              { permissionCodes: { has: query.permission } },
              {
                departments: {
                  hasSome: departmentsAllowingPermission(query.permission),
                },
              },
            ],
          },
        ],
      });
    }
    const where: Prisma.UserWhereInput = {
      companyId,
      ...(query.excludeUserId ? { id: { not: query.excludeUserId } } : {}),
      ...(query.excludeAdministrators ? { isAdministrator: false } : {}),
      ...(accessFilters.length > 0 ? { AND: accessFilters } : {}),
      ...(query.status
        ? {
            status:
              query.status === 'active'
                ? PrismaUserAccountStatus.ACTIVE
                : query.status === 'inactive'
                  ? PrismaUserAccountStatus.INACTIVE
                  : PrismaUserAccountStatus.SUSPENDED,
          }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { username: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: userRecordSelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items: rows.map(mapUserRecord), total };
  }

  async update(
    companyId: string,
    userId: string,
    input: UpdateUserPersistenceInput,
  ): Promise<UserRecord> {
    const data = userUpdateData(input);

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.user.update({
          where: { id_companyId: { id: userId, companyId } },
          data,
        });

        const row = await transaction.user.findUniqueOrThrow({
          where: { id_companyId: { id: userId, companyId } },
          select: userRecordSelect,
        });
        return mapUserRecord(row);
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async updateWithAdministratorInvariant(
    companyId: string,
    userId: string,
    input: UpdateUserPersistenceInput,
  ): Promise<UserRecord | null> {
    const data = userUpdateData(input);
    try {
      return await this.retrySerializable(() =>
        this.prisma.$transaction(
          async (transaction) => {
            const activeAdministrators = await transaction.user.count({
              where: {
                companyId,
                isAdministrator: true,
                isActive: true,
                status: PrismaUserAccountStatus.ACTIVE,
              },
            });
            if (activeAdministrators <= 1) return null;

            const changed = await transaction.user.updateMany({
              where: {
                id: userId,
                companyId,
                isAdministrator: true,
                isActive: true,
                status: PrismaUserAccountStatus.ACTIVE,
              },
              data,
            });
            if (changed.count !== 1) return null;

            const row = await transaction.user.findUniqueOrThrow({
              where: { id_companyId: { id: userId, companyId } },
              select: userRecordSelect,
            });
            return mapUserRecord(row);
          },
          { isolationLevel: 'Serializable' },
        ),
      );
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async updateStatus(
    companyId: string,
    userId: string,
    input: UpdateUserStatusPersistenceInput,
  ): Promise<UserRecord> {
    const status =
      input.status === 'active'
        ? PrismaUserAccountStatus.ACTIVE
        : input.status === 'inactive'
          ? PrismaUserAccountStatus.INACTIVE
          : PrismaUserAccountStatus.SUSPENDED;

    return this.prisma.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id_companyId: { id: userId, companyId } },
        data: {
          status,
          isActive: input.status === 'active',
          suspendedUntil: input.suspendedUntil,
          suspensionReason: input.suspensionReason,
          tokenVersion: { increment: 1 },
        },
      });
      await transaction.refreshToken.updateMany({
        where: { companyId, userId, revokedAt: null },
        data: { revokedAt: input.changedAt },
      });
      const row = await transaction.user.findUniqueOrThrow({
        where: { id_companyId: { id: userId, companyId } },
        select: userRecordSelect,
      });
      return mapUserRecord(row);
    });
  }

  async updateStatusWithAdministratorInvariant(
    companyId: string,
    userId: string,
    input: UpdateUserStatusPersistenceInput,
  ): Promise<UserRecord | null> {
    const status =
      input.status === 'active'
        ? PrismaUserAccountStatus.ACTIVE
        : input.status === 'inactive'
          ? PrismaUserAccountStatus.INACTIVE
          : PrismaUserAccountStatus.SUSPENDED;

    return this.retrySerializable(() =>
      this.prisma.$transaction(
        async (transaction) => {
          const activeAdministrators = await transaction.user.count({
            where: {
              companyId,
              isAdministrator: true,
              isActive: true,
              status: PrismaUserAccountStatus.ACTIVE,
            },
          });
          if (activeAdministrators <= 1) return null;

          const changed = await transaction.user.updateMany({
            where: {
              id: userId,
              companyId,
              isAdministrator: true,
              isActive: true,
              status: PrismaUserAccountStatus.ACTIVE,
            },
            data: {
              status,
              isActive: input.status === 'active',
              suspendedUntil: input.suspendedUntil,
              suspensionReason: input.suspensionReason,
              tokenVersion: { increment: 1 },
            },
          });
          if (changed.count !== 1) return null;

          await transaction.refreshToken.updateMany({
            where: { companyId, userId, revokedAt: null },
            data: { revokedAt: input.changedAt },
          });
          const row = await transaction.user.findUniqueOrThrow({
            where: { id_companyId: { id: userId, companyId } },
            select: userRecordSelect,
          });
          return mapUserRecord(row);
        },
        { isolationLevel: 'Serializable' },
      ),
    );
  }

  async markLastLogin(
    companyId: string,
    userId: string,
    date: Date,
  ): Promise<void> {
    await this.prisma.user.update({
      where: { id_companyId: { id: userId, companyId } },
      data: { lastLoginAt: date },
    });
  }

  countActiveAdministrators(companyId: string): Promise<number> {
    return this.prisma.user.count({
      where: {
        companyId,
        isActive: true,
        status: PrismaUserAccountStatus.ACTIVE,
        isAdministrator: true,
      },
    });
  }

  async listPasswordHashes(
    companyId: string,
    userId: string,
    limit: number,
  ): Promise<string[]> {
    const [current, history] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id_companyId: { id: userId, companyId } },
        select: { passwordHash: true },
      }),
      this.prisma.userPasswordHistory.findMany({
        where: { companyId, userId },
        orderBy: { createdAt: 'desc' },
        take: Math.max(0, limit - 1),
        select: { passwordHash: true },
      }),
    ]);

    return current
      ? [current.passwordHash, ...history.map((entry) => entry.passwordHash)]
      : [];
  }

  async changePassword(
    companyId: string,
    userId: string,
    passwordHash: string,
    changedAt: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const current = await transaction.user.findUniqueOrThrow({
        where: { id_companyId: { id: userId, companyId } },
        select: { passwordHash: true },
      });

      await transaction.userPasswordHistory.create({
        data: {
          companyId,
          userId,
          passwordHash: current.passwordHash,
          createdAt: changedAt,
        },
      });
      await transaction.user.update({
        where: { id_companyId: { id: userId, companyId } },
        data: {
          passwordHash,
          mustChangePassword: false,
          tokenVersion: { increment: 1 },
        },
      });
      await transaction.refreshToken.updateMany({
        where: { companyId, userId, revokedAt: null },
        data: { revokedAt: changedAt },
      });
    });
  }

  async requirePasswordChange(
    companyId: string,
    userId: string,
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id_companyId: { id: userId, companyId } },
        data: {
          mustChangePassword: true,
          tokenVersion: { increment: 1 },
        },
      }),
      this.prisma.refreshToken.updateMany({
        where: { companyId, userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
  }

  async updateProfilePicture(
    companyId: string,
    userId: string,
    picture: Uint8Array<ArrayBuffer> | null,
    mimeType: string | null,
  ): Promise<UserProfileRecord> {
    const row = await this.prisma.user.update({
      where: { id_companyId: { id: userId, companyId } },
      data: {
        profilePicture: picture,
        profilePictureMime: mimeType,
      },
      select: userProfileSelect,
    });
    return mapUserProfile(row);
  }
}

import { Injectable } from '@nestjs/common';

import {
  UsersRepository,
  type UpdateUserPersistenceInput,
  type UserListQuery,
  type UserListResult,
  type UserWithRoles,
} from '../../../application/contracts/repositories';
import type { User } from '../../../domain/entities/user';
import type { Prisma } from '../prisma/generated/client';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { mapUserWithRoles, userWithRelations } from '../prisma/prisma.mappers';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PrismaUsersRepository extends UsersRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
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

  async findByLoginIdentifier(
    identifier: string,
  ): Promise<UserWithRoles | null> {
    const row = await this.prisma.user.findFirst({
      where: {
        OR: [
          { usernameNormalized: identifier },
          { emailNormalized: identifier },
          { cpfNormalized: identifier },
        ],
      },
      include: userWithRelations,
    });

    return row ? mapUserWithRoles(row) : null;
  }

  async findById(
    companyId: string,
    userId: string,
  ): Promise<UserWithRoles | null> {
    const row = await this.prisma.user.findUnique({
      where: { id_companyId: { id: userId, companyId } },
      include: userWithRelations,
    });

    return row ? mapUserWithRoles(row) : null;
  }

  async create(user: User, roleIds: readonly string[]): Promise<UserWithRoles> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.user.create({
          data: {
            ...user.props,
            departments: [...user.props.departments],
          },
        });

        if (roleIds.length > 0) {
          await transaction.userRole.createMany({
            data: roleIds.map((roleId) => ({
              companyId: user.companyId,
              userId: user.id,
              roleId,
            })),
          });
        }

        const row = await transaction.user.findUniqueOrThrow({
          where: { id_companyId: { id: user.id, companyId: user.companyId } },
          include: userWithRelations,
        });

        return mapUserWithRoles(row);
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async list(companyId: string, query: UserListQuery): Promise<UserListResult> {
    const search = query.search?.trim();
    const where: Prisma.UserWhereInput = {
      companyId,
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
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
        include: userWithRelations,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { items: rows.map(mapUserWithRoles), total };
  }

  async update(
    companyId: string,
    userId: string,
    input: UpdateUserPersistenceInput,
  ): Promise<UserWithRoles> {
    const data: Prisma.UserUncheckedUpdateInput = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.emailNormalized === undefined
        ? {}
        : { emailNormalized: input.emailNormalized }),
      ...(input.cpfNormalized === undefined
        ? {}
        : { cpfNormalized: input.cpfNormalized }),
      ...(input.departments === undefined
        ? {}
        : { departments: [...input.departments] }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    };

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.user.update({
          where: { id_companyId: { id: userId, companyId } },
          data,
        });

        if (input.roleIds) {
          await transaction.userRole.deleteMany({
            where: { companyId, userId },
          });
          if (input.roleIds.length > 0) {
            await transaction.userRole.createMany({
              data: input.roleIds.map((roleId) => ({
                companyId,
                userId,
                roleId,
              })),
            });
          }
        }

        const row = await transaction.user.findUniqueOrThrow({
          where: { id_companyId: { id: userId, companyId } },
          include: userWithRelations,
        });
        return mapUserWithRoles(row);
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
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

  countActiveByRole(companyId: string, roleId: string): Promise<number> {
    return this.prisma.user.count({
      where: {
        companyId,
        isActive: true,
        roles: { some: { companyId, roleId } },
      },
    });
  }
}

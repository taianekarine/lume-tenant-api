import { Injectable } from '@nestjs/common';

import {
  RoutingRepository,
  type RoutingCompanyHistoryRecord,
  type RoutingCompanyListQuery,
  type RoutingCompanyListResult,
  type UpdateRoutingCompanyPersistenceInput,
} from '../../../application/contracts/routing.repository';
import type {
  RoutingCompanyProps,
  RoutingClientType,
  RoutingPhone,
  RoutingCompanyStatus,
} from '../../../domain/routing/routing-company';
import {
  RoutingClientType as PrismaRoutingClientType,
  RoutingCompanyStatus as PrismaRoutingCompanyStatus,
} from '../prisma/generated/client';
import type { Prisma } from '../prisma/generated/client';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

function toPrismaStatus(status: RoutingCompanyStatus) {
  return status.toUpperCase() as PrismaRoutingCompanyStatus;
}

function mapCompany(row: {
  id: string;
  companyId: string;
  taxId: string;
  legalName: string;
  tradeName: string | null;
  costCenter: string | null;
  clientType: PrismaRoutingClientType;
  individualName: string | null;
  cpf: string | null;
  individualEmail: string | null;
  individualWhatsapp: string | null;
  individualPhones: Prisma.JsonValue;
  cnpj: string | null;
  legalEmail: string | null;
  legalWhatsapp: string | null;
  legalPhones: Prisma.JsonValue;
  status: PrismaRoutingCompanyStatus;
  avicExternalId: string | null;
  avicLastSyncedAt: Date | null;
  version: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): RoutingCompanyProps {
  return {
    ...row,
    status: row.status.toLowerCase() as RoutingCompanyStatus,
    clientType: row.clientType.toLowerCase() as RoutingClientType,
    individualPhones: row.individualPhones as unknown as RoutingPhone[],
    legalPhones: row.legalPhones as unknown as RoutingPhone[],
  };
}

function companySnapshot(company: RoutingCompanyProps): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      id: company.id,
      taxId: company.taxId,
      legalName: company.legalName,
      tradeName: company.tradeName,
      costCenter: company.costCenter,
      clientType: company.clientType,
      individualName: company.individualName,
      cpf: company.cpf,
      individualEmail: company.individualEmail,
      individualWhatsapp: company.individualWhatsapp,
      individualPhones: company.individualPhones,
      cnpj: company.cnpj,
      legalEmail: company.legalEmail,
      legalWhatsapp: company.legalWhatsapp,
      legalPhones: company.legalPhones,
      status: company.status,
      avicExternalId: company.avicExternalId,
      avicLastSyncedAt: company.avicLastSyncedAt?.toISOString() ?? null,
      version: company.version,
    }),
  ) as Prisma.InputJsonValue;
}

@Injectable()
export class PrismaRoutingRepository extends RoutingRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async createCompany(input: RoutingCompanyProps, commandId: string) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.routingCompanyHistory.findUnique({
          where: {
            companyId_commandId: { companyId: input.companyId, commandId },
          },
          select: { routingCompanyId: true },
        });
        if (repeated) {
          const existing = await transaction.routingCompany.findUniqueOrThrow({
            where: {
              id_companyId: {
                id: repeated.routingCompanyId,
                companyId: input.companyId,
              },
            },
          });
          return mapCompany(existing);
        }
        const row = await transaction.routingCompany.create({
          data: {
            ...input,
            status: toPrismaStatus(input.status),
            clientType:
              input.clientType.toUpperCase() as PrismaRoutingClientType,
            individualPhones:
              input.individualPhones as unknown as Prisma.InputJsonValue,
            legalPhones: input.legalPhones as unknown as Prisma.InputJsonValue,
          },
        });
        const mapped = mapCompany(row);
        await transaction.routingCompanyHistory.create({
          data: {
            companyId: input.companyId,
            routingCompanyId: row.id,
            actorUserId: input.createdByUserId,
            commandId,
            action: 'ROUTING_COMPANY_CREATED',
            afterSnapshot: companySnapshot(mapped),
          },
        });
        return mapped;
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async listCompanies(
    companyId: string,
    query: RoutingCompanyListQuery,
  ): Promise<RoutingCompanyListResult> {
    const search = query.search?.trim();
    const where = {
      companyId,
      ...(query.status ? { status: toPrismaStatus(query.status) } : {}),
      ...(query.clientType
        ? {
            clientType:
              query.clientType.toUpperCase() as PrismaRoutingClientType,
          }
        : {}),
      ...(search
        ? {
            OR: [
              { legalName: { contains: search, mode: 'insensitive' as const } },
              { tradeName: { contains: search, mode: 'insensitive' as const } },
              { taxId: { contains: search } },
              { cpf: { contains: search.replace(/\D/g, '') } },
              { cnpj: { contains: search.replace(/\D/g, '') } },
              {
                individualName: {
                  contains: search,
                  mode: 'insensitive' as const,
                },
              },
              { individualWhatsapp: { contains: search.replace(/\D/g, '') } },
              { legalWhatsapp: { contains: search.replace(/\D/g, '') } },
              {
                avicExternalId: {
                  contains: search,
                  mode: 'insensitive' as const,
                },
              },
              {
                costCenter: { contains: search, mode: 'insensitive' as const },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.routingCompany.findMany({
        where,
        orderBy:
          query.sort === 'status'
            ? [{ status: 'asc' }, { legalName: 'asc' }]
            : query.sort === 'avic'
              ? [{ avicExternalId: 'asc' }, { legalName: 'asc' }]
              : [{ legalName: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.routingCompany.count({ where }),
    ]);
    return { items: rows.map(mapCompany), total };
  }

  async findCompany(companyId: string, routingCompanyId: string) {
    const row = await this.prisma.routingCompany.findUnique({
      where: {
        id_companyId: { id: routingCompanyId, companyId },
      },
    });
    return row ? mapCompany(row) : null;
  }

  async findCompanyByTaxId(companyId: string, taxId: string) {
    const row = await this.prisma.routingCompany.findUnique({
      where: { companyId_taxId: { companyId, taxId } },
    });
    return row ? mapCompany(row) : null;
  }

  async findCompanyByUniqueValue(
    companyId: string,
    field: 'cpf' | 'cnpj' | 'avicExternalId',
    value: string,
    exceptId?: string,
  ) {
    const row = await this.prisma.routingCompany.findFirst({
      where: {
        companyId,
        [field]: value,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    });
    return row ? mapCompany(row) : null;
  }

  async listCompanyHistory(
    companyId: string,
    routingCompanyId: string,
  ): Promise<RoutingCompanyHistoryRecord[]> {
    const rows = await this.prisma.routingCompanyHistory.findMany({
      where: { companyId, routingCompanyId },
      include: { actor: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(({ actor, ...row }) => ({
      ...row,
      actorName: actor?.name ?? null,
      beforeSnapshot: row.beforeSnapshot as Readonly<
        Record<string, unknown>
      > | null,
      afterSnapshot: row.afterSnapshot as Readonly<Record<string, unknown>>,
    }));
  }

  async updateCompany(
    companyId: string,
    routingCompanyId: string,
    input: UpdateRoutingCompanyPersistenceInput & {
      actorUserId: string;
      commandId: string;
    },
  ) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.routingCompanyHistory.findUnique({
          where: {
            companyId_commandId: { companyId, commandId: input.commandId },
          },
          select: { routingCompanyId: true },
        });
        if (repeated) {
          if (repeated.routingCompanyId !== routingCompanyId) return null;
          const existing = await transaction.routingCompany.findUnique({
            where: { id_companyId: { id: routingCompanyId, companyId } },
          });
          return existing ? mapCompany(existing) : null;
        }
        const before = await transaction.routingCompany.findUnique({
          where: { id_companyId: { id: routingCompanyId, companyId } },
        });
        if (!before || before.version !== input.expectedVersion) return null;
        const row = await transaction.routingCompany.update({
          where: { id_companyId: { id: routingCompanyId, companyId } },
          data: {
            ...(input.taxId === undefined ? {} : { taxId: input.taxId }),
            ...(input.legalName === undefined
              ? {}
              : { legalName: input.legalName }),
            ...(input.tradeName === undefined
              ? {}
              : { tradeName: input.tradeName }),
            ...(input.costCenter === undefined
              ? {}
              : { costCenter: input.costCenter }),
            ...(input.status === undefined
              ? {}
              : { status: toPrismaStatus(input.status) }),
            ...(input.clientType === undefined
              ? {}
              : {
                  clientType:
                    input.clientType.toUpperCase() as PrismaRoutingClientType,
                }),
            ...(input.avicExternalId === undefined
              ? {}
              : { avicExternalId: input.avicExternalId }),
            ...(input.individualName === undefined
              ? {}
              : { individualName: input.individualName }),
            ...(input.cpf === undefined ? {} : { cpf: input.cpf }),
            ...(input.individualEmail === undefined
              ? {}
              : { individualEmail: input.individualEmail }),
            ...(input.individualWhatsapp === undefined
              ? {}
              : { individualWhatsapp: input.individualWhatsapp }),
            ...(input.individualPhones === undefined
              ? {}
              : {
                  individualPhones:
                    input.individualPhones as unknown as Prisma.InputJsonValue,
                }),
            ...(input.cnpj === undefined ? {} : { cnpj: input.cnpj }),
            ...(input.legalEmail === undefined
              ? {}
              : { legalEmail: input.legalEmail }),
            ...(input.legalWhatsapp === undefined
              ? {}
              : { legalWhatsapp: input.legalWhatsapp }),
            ...(input.legalPhones === undefined
              ? {}
              : {
                  legalPhones:
                    input.legalPhones as unknown as Prisma.InputJsonValue,
                }),
            version: { increment: 1 },
          },
        });
        const mappedBefore = mapCompany(before);
        const mappedAfter = mapCompany(row);
        await transaction.routingCompanyHistory.create({
          data: {
            companyId,
            routingCompanyId,
            actorUserId: input.actorUserId,
            commandId: input.commandId,
            action:
              mappedBefore.status === mappedAfter.status
                ? 'ROUTING_COMPANY_UPDATED'
                : 'ROUTING_COMPANY_STATUS_CHANGED',
            beforeSnapshot: companySnapshot(mappedBefore),
            afterSnapshot: companySnapshot(mappedAfter),
          },
        });
        return mappedAfter;
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async listCompanyComments(companyId: string, routingCompanyId: string) {
    const rows = await this.prisma.routingCompanyComment.findMany({
      where: { companyId, routingCompanyId },
      include: { createdBy: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(({ createdBy, ...row }) => ({
      ...row,
      authorName: createdBy.name,
    }));
  }

  async createCompanyComment(input: {
    companyId: string;
    routingCompanyId: string;
    actorUserId: string;
    commandId: string;
    comment: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.routingCompanyComment.create({
        data: {
          companyId: input.companyId,
          routingCompanyId: input.routingCompanyId,
          comment: input.comment,
          createdByUserId: input.actorUserId,
          updatedByUserId: input.actorUserId,
        },
        include: { createdBy: { select: { name: true } } },
      });
      await tx.routingCompanyHistory.create({
        data: {
          companyId: input.companyId,
          routingCompanyId: input.routingCompanyId,
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          action: 'CLIENT_PROFILE_COMMENT_CREATED',
          afterSnapshot: { commentId: row.id, comment: row.comment },
        },
      });
      const { createdBy, ...comment } = row;
      return { ...comment, authorName: createdBy.name };
    });
  }

  async updateCompanyComment(input: {
    companyId: string;
    routingCompanyId: string;
    commentId: string;
    actorUserId: string;
    commandId: string;
    comment: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.routingCompanyComment.findFirst({
        where: {
          id: input.commentId,
          companyId: input.companyId,
          routingCompanyId: input.routingCompanyId,
        },
      });
      if (!before) return null;
      const row = await tx.routingCompanyComment.update({
        where: {
          id_companyId: { id: input.commentId, companyId: input.companyId },
        },
        data: { comment: input.comment, updatedByUserId: input.actorUserId },
        include: { createdBy: { select: { name: true } } },
      });
      await tx.routingCompanyHistory.create({
        data: {
          companyId: input.companyId,
          routingCompanyId: input.routingCompanyId,
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          action: 'CLIENT_PROFILE_COMMENT_UPDATED',
          beforeSnapshot: { commentId: before.id, comment: before.comment },
          afterSnapshot: { commentId: row.id, comment: row.comment },
        },
      });
      const { createdBy, ...comment } = row;
      return { ...comment, authorName: createdBy.name };
    });
  }

  async deleteCompanyComment(input: {
    companyId: string;
    routingCompanyId: string;
    commentId: string;
    actorUserId: string;
    commandId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.routingCompanyComment.findFirst({
        where: {
          id: input.commentId,
          companyId: input.companyId,
          routingCompanyId: input.routingCompanyId,
        },
      });
      if (!before) return false;
      await tx.routingCompanyComment.delete({
        where: {
          id_companyId: { id: input.commentId, companyId: input.companyId },
        },
      });
      await tx.routingCompanyHistory.create({
        data: {
          companyId: input.companyId,
          routingCompanyId: input.routingCompanyId,
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          action: 'CLIENT_PROFILE_COMMENT_REMOVED',
          beforeSnapshot: { commentId: before.id, comment: before.comment },
          afterSnapshot: { commentId: before.id, removed: true },
        },
      });
      return true;
    });
  }
}

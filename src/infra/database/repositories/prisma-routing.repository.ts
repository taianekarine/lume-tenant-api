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
  RoutingCompanyStatus,
} from '../../../domain/routing/routing-company';
import { RoutingCompanyStatus as PrismaRoutingCompanyStatus } from '../prisma/generated/client';
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
  };
}

function companySnapshot(company: RoutingCompanyProps): Prisma.InputJsonValue {
  return {
    id: company.id,
    taxId: company.taxId,
    legalName: company.legalName,
    tradeName: company.tradeName,
    costCenter: company.costCenter,
    status: company.status,
    avicExternalId: company.avicExternalId,
    avicLastSyncedAt: company.avicLastSyncedAt?.toISOString() ?? null,
    version: company.version,
  };
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
      ...(search
        ? {
            OR: [
              { legalName: { contains: search, mode: 'insensitive' as const } },
              { tradeName: { contains: search, mode: 'insensitive' as const } },
              { taxId: { contains: search } },
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
        orderBy: [{ legalName: 'asc' }, { id: 'asc' }],
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

  async listCompanyHistory(
    companyId: string,
    routingCompanyId: string,
  ): Promise<RoutingCompanyHistoryRecord[]> {
    const rows = await this.prisma.routingCompanyHistory.findMany({
      where: { companyId, routingCompanyId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map((row) => ({
      ...row,
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
}

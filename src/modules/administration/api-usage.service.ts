import { Injectable } from '@nestjs/common';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { forbidden, validationError } from '../../core/errors/app-error';
import { Prisma } from '../../infra/database/prisma/generated/client';
import { PrismaService } from '../../infra/database/prisma/prisma.service';
import { humanizeApiAction } from './api-usage-labels';

interface UsagePeriod {
  from: Date;
  to: Date;
}

interface DailyUsageRow {
  day: string;
  requests: number;
  bytes: bigint;
}

function assertAdministrator(principal: AuthenticatedPrincipal): void {
  if (!principal.isAdministrator) {
    throw forbidden(
      'Somente administradores podem consultar o uso da plataforma.',
    );
  }
}

function resolvePeriod(from?: string, to?: string): UsagePeriod {
  const end = to ? new Date(to) : new Date();
  const start = from
    ? new Date(from)
    : new Date(end.getTime() - 6 * 86_400_000);
  start.setHours(0, 0, 0, 0);
  if (to) end.setHours(23, 59, 59, 999);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start > end ||
    end.getTime() - start.getTime() > 90 * 86_400_000
  ) {
    throw validationError('Selecione um período válido de até 90 dias.');
  }
  return { from: start, to: end };
}

function statusFilter(status?: 'success' | 'client-error' | 'server-error') {
  if (status === 'success') return { lt: 400 };
  if (status === 'client-error') return { gte: 400, lt: 500 };
  if (status === 'server-error') return { gte: 500 };
  return undefined;
}

@Injectable()
export class ApiUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(
    principal: AuthenticatedPrincipal,
    query: { from?: string; to?: string },
  ) {
    assertAdministrator(principal);
    const period = resolvePeriod(query.from, query.to);
    const where = {
      companyId: principal.companyId,
      createdAt: { gte: period.from, lte: period.to },
    } satisfies Prisma.ApiRequestMetricWhereInput;
    const [aggregate, errors, userGroups, actionGroups, daily] =
      await Promise.all([
        this.prisma.apiRequestMetric.aggregate({
          where,
          _count: { _all: true },
          _sum: { requestBytes: true, responseBytes: true },
          _avg: { durationMs: true },
        }),
        this.prisma.apiRequestMetric.count({
          where: { ...where, statusCode: { gte: 400 } },
        }),
        this.prisma.apiRequestMetric.groupBy({
          by: ['userId'],
          where,
          _count: { _all: true },
          _sum: { requestBytes: true, responseBytes: true },
          _avg: { durationMs: true },
        }),
        this.prisma.apiRequestMetric.groupBy({
          by: ['method', 'route'],
          where,
          _count: { _all: true },
          _sum: { requestBytes: true, responseBytes: true },
          _avg: { durationMs: true },
        }),
        this.prisma.$queryRaw<DailyUsageRow[]>(Prisma.sql`
          SELECT
            to_char("created_at" AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS "day",
            COUNT(*)::int AS "requests",
            COALESCE(SUM("request_bytes" + "response_bytes"), 0)::bigint AS "bytes"
          FROM "api_request_metrics"
          WHERE "company_id" = ${principal.companyId}::uuid
            AND "created_at" >= ${period.from}
            AND "created_at" <= ${period.to}
          GROUP BY 1
          ORDER BY 1 ASC
        `),
      ]);
    const topUserGroups = [...userGroups]
      .sort((first, second) => second._count._all - first._count._all)
      .slice(0, 10);
    const users = await this.prisma.user.findMany({
      where: {
        companyId: principal.companyId,
        id: { in: topUserGroups.map((group) => group.userId) },
      },
      select: { id: true, name: true, email: true, deletedAt: true },
    });
    const userById = new Map(users.map((user) => [user.id, user]));
    return {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      totals: {
        requests: aggregate._count._all,
        requestBytes: aggregate._sum.requestBytes ?? 0,
        responseBytes: aggregate._sum.responseBytes ?? 0,
        averageDurationMs: Math.round(aggregate._avg.durationMs ?? 0),
        errors,
        activeUsers: userGroups.length,
      },
      daily: daily.map((row) => ({ ...row, bytes: Number(row.bytes) })),
      users: topUserGroups.map((group) => {
        const user = userById.get(group.userId);
        return {
          id: group.userId,
          name: user?.deletedAt
            ? 'Usuário excluído'
            : (user?.name ?? 'Usuário indisponível'),
          email: user?.deletedAt ? null : (user?.email ?? null),
          requests: group._count._all,
          bytes:
            (group._sum.requestBytes ?? 0) + (group._sum.responseBytes ?? 0),
          averageDurationMs: Math.round(group._avg.durationMs ?? 0),
        };
      }),
      actions: [...actionGroups]
        .sort((first, second) => second._count._all - first._count._all)
        .slice(0, 10)
        .map((group) => ({
          action: humanizeApiAction(group.method, group.route),
          requests: group._count._all,
          bytes:
            (group._sum.requestBytes ?? 0) + (group._sum.responseBytes ?? 0),
          averageDurationMs: Math.round(group._avg.durationMs ?? 0),
        })),
    };
  }

  async list(
    principal: AuthenticatedPrincipal,
    query: {
      from?: string;
      to?: string;
      page: number;
      pageSize: number;
      userId?: string;
      status?: 'success' | 'client-error' | 'server-error';
    },
  ) {
    assertAdministrator(principal);
    const period = resolvePeriod(query.from, query.to);
    const where = {
      companyId: principal.companyId,
      createdAt: { gte: period.from, lte: period.to },
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.status ? { statusCode: statusFilter(query.status) } : {}),
    } satisfies Prisma.ApiRequestMetricWhereInput;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.apiRequestMetric.findMany({
        where,
        include: {
          user: {
            select: { id: true, name: true, email: true, deletedAt: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.apiRequestMetric.count({ where }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        action: humanizeApiAction(row.method, row.route),
        result:
          row.statusCode >= 500
            ? 'Falha no serviço'
            : row.statusCode >= 400
              ? 'Solicitação não concluída'
              : 'Concluída',
        statusCode: row.statusCode,
        requestBytes: row.requestBytes,
        responseBytes: row.responseBytes,
        durationMs: row.durationMs,
        createdAt: row.createdAt.toISOString(),
        user: {
          id: row.user.id,
          name: row.user.deletedAt ? 'Usuário excluído' : row.user.name,
          email: row.user.deletedAt ? null : row.user.email,
        },
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }
}

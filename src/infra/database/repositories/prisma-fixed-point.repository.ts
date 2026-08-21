import { Injectable } from '@nestjs/common';

import {
  FixedPointRepository,
  type FixedPointListQuery,
} from '../../../application/contracts/fixed-point.repository';
import type {
  RoutingFixedPointProps,
  RoutingFixedPointStatus,
} from '../../../domain/routing/fixed-point';
import {
  RoutingFixedPointStatus as PrismaFixedPointStatus,
  type Prisma,
} from '../prisma/generated/client';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

function status(value: RoutingFixedPointStatus): PrismaFixedPointStatus {
  return value.toUpperCase() as PrismaFixedPointStatus;
}

function mapPoint(row: {
  id: string;
  companyId: string;
  routingCompanyId: string | null;
  code: string;
  name: string;
  status: PrismaFixedPointStatus;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  postalCode: string;
  city: string;
  state: string;
  latitude: Prisma.Decimal | null;
  longitude: Prisma.Decimal | null;
  version: number;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}): RoutingFixedPointProps {
  return {
    id: row.id,
    companyId: row.companyId,
    routingCompanyId: row.routingCompanyId,
    code: row.code,
    name: row.name,
    status: row.status.toLowerCase() as RoutingFixedPointStatus,
    address: {
      label: row.name,
      street: row.street,
      number: row.number,
      complement: row.complement,
      district: row.district,
      postalCode: row.postalCode,
      city: row.city,
      state: row.state,
      latitude: row.latitude === null ? null : Number(row.latitude),
      longitude: row.longitude === null ? null : Number(row.longitude),
    },
    version: row.version,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

@Injectable()
export class PrismaFixedPointRepository extends FixedPointRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(point: RoutingFixedPointProps, commandId: string) {
    try {
      const row = await this.prisma.routingFixedPoint.create({
        data: {
          id: point.id,
          companyId: point.companyId,
          routingCompanyId: point.routingCompanyId,
          code: point.code,
          name: point.name,
          status: status(point.status),
          street: point.address.street,
          number: point.address.number,
          complement: point.address.complement,
          district: point.address.district,
          postalCode: point.address.postalCode,
          city: point.address.city,
          state: point.address.state,
          latitude: point.address.latitude,
          longitude: point.address.longitude,
          createdByUserId: point.createdByUserId,
        },
      });
      void commandId;
      return mapPoint(row);
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async list(companyId: string, query: FixedPointListQuery) {
    const search = query.search?.trim();
    const where: Prisma.RoutingFixedPointWhereInput = {
      companyId,
      ...(query.status ? { status: status(query.status) } : {}),
      ...(query.routingCompanyId
        ? {
            OR: [
              { routingCompanyId: null },
              { routingCompanyId: query.routingCompanyId },
            ],
          }
        : {}),
      ...(query.routeId
        ? {
            OR: [
              {
                originContracts: {
                  some: { routes: { some: { id: query.routeId } } },
                },
              },
              {
                destinationContracts: {
                  some: { routes: { some: { id: query.routeId } } },
                },
              },
              { routePoints: { some: { routeId: query.routeId } } },
            ],
          }
        : {}),
      ...(search
        ? {
            AND: [
              {
                OR: [
                  { name: { contains: search, mode: 'insensitive' } },
                  { code: { contains: search, mode: 'insensitive' } },
                  { city: { contains: search, mode: 'insensitive' } },
                ],
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.routingFixedPoint.findMany({
        where,
        orderBy: [{ name: 'asc' }, { code: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.routingFixedPoint.count({ where }),
    ]);
    return { items: rows.map(mapPoint), total };
  }

  async find(companyId: string, fixedPointId: string) {
    const row = await this.prisma.routingFixedPoint.findUnique({
      where: { id_companyId: { id: fixedPointId, companyId } },
    });
    return row ? mapPoint(row) : null;
  }

  async findByCode(companyId: string, code: string) {
    const row = await this.prisma.routingFixedPoint.findUnique({
      where: { companyId_code: { companyId, code: code.trim().toUpperCase() } },
    });
    return row ? mapPoint(row) : null;
  }
}

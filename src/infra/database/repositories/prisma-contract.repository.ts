import { Injectable } from '@nestjs/common';

import {
  ContractRepository,
  type ContractHistoryRecord,
  type ContractListQuery,
  type ContractListResult,
} from '../../../application/contracts/contract.repository';
import type {
  ContractData,
  ContractPeriodicity,
  ContractProps,
  ContractStatus,
} from '../../../domain/routing/contract';
import type { RouteAddress, RouteType } from '../../../domain/routing/route';
import {
  RoutingContractPeriodicity,
  RoutingContractStatus,
  RoutingRouteType,
  type Prisma,
} from '../prisma/generated/client';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

const contractInclude = {
  costCenters: { orderBy: [{ code: 'asc' }] },
  shifts: { orderBy: [{ requiredArrivalTime: 'asc' }, { name: 'asc' }] },
} satisfies Prisma.RoutingContractInclude;

type ContractRow = Prisma.RoutingContractGetPayload<{
  include: typeof contractInclude;
}>;

function address(
  row: ContractRow,
  prefix: 'origin' | 'destination',
): RouteAddress {
  return {
    label: row[`${prefix}Label`],
    street: row[`${prefix}Street`],
    number: row[`${prefix}Number`],
    complement: row[`${prefix}Complement`],
    district: row[`${prefix}District`],
    postalCode: row[`${prefix}PostalCode`],
    city: row[`${prefix}City`],
    state: row[`${prefix}State`],
    latitude:
      row[`${prefix}Latitude`] === null
        ? null
        : Number(row[`${prefix}Latitude`]),
    longitude:
      row[`${prefix}Longitude`] === null
        ? null
        : Number(row[`${prefix}Longitude`]),
  };
}

function mapContract(row: ContractRow): ContractProps {
  return {
    id: row.id,
    companyId: row.companyId,
    routingCompanyId: row.routingCompanyId,
    code: row.code,
    name: row.name,
    operationType: row.operationType,
    routeType: row.routeType.toLowerCase() as RouteType,
    status: row.status.toLowerCase() as ContractStatus,
    periodicity: row.periodicity
      .toLowerCase()
      .replaceAll('_', '-') as ContractPeriodicity,
    contractedVehicleCount: row.contractedVehicleCount,
    predictedVehicleName: row.predictedVehicleName,
    predictedVehicleReference: row.predictedVehicleReference,
    predictedVehicleCapacity: row.predictedVehicleCapacity,
    contractedKm: row.contractedKm === null ? null : Number(row.contractedKm),
    plannedKm: row.plannedKm === null ? null : Number(row.plannedKm),
    maxWalkingDistanceMeters: row.maxWalkingDistanceMeters,
    requiresDocumentation: row.requiresDocumentation,
    requiredDocumentTypeCodes: row.requiredDocumentTypeCodes,
    unitName: row.unitName,
    origin: address(row, 'origin'),
    destination: address(row, 'destination'),
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    notes: row.notes,
    costCenters: row.costCenters.map((costCenter) => ({
      id: costCenter.id,
      code: costCenter.code,
      name: costCenter.name,
    })),
    shifts: row.shifts.map((shift) => ({
      id: shift.id,
      name: shift.name,
      requiredArrivalTime: shift.requiredArrivalTime,
      vehicleCount: shift.vehicleCount,
      vehicleCapacity: shift.vehicleCapacity,
      activeWeekdays: shift.activeWeekdays,
    })),
    version: row.version,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function contractData(input: ContractData) {
  return {
    routingCompanyId: input.routingCompanyId,
    code: input.code,
    name: input.name,
    operationType: input.operationType,
    routeType: input.routeType.toUpperCase() as RoutingRouteType,
    status: input.status.toUpperCase() as RoutingContractStatus,
    periodicity: input.periodicity
      .toUpperCase()
      .replaceAll('-', '_') as RoutingContractPeriodicity,
    contractedVehicleCount: input.contractedVehicleCount,
    predictedVehicleName: input.predictedVehicleName,
    predictedVehicleReference: input.predictedVehicleReference,
    predictedVehicleCapacity: input.predictedVehicleCapacity,
    contractedKm: input.contractedKm,
    plannedKm: input.plannedKm,
    maxWalkingDistanceMeters: input.maxWalkingDistanceMeters,
    requiresDocumentation: input.requiresDocumentation,
    requiredDocumentTypeCodes: input.requiredDocumentTypeCodes,
    unitName: input.unitName,
    originLabel: input.origin.label,
    originStreet: input.origin.street,
    originNumber: input.origin.number,
    originComplement: input.origin.complement,
    originDistrict: input.origin.district,
    originPostalCode: input.origin.postalCode,
    originCity: input.origin.city,
    originState: input.origin.state,
    originLatitude: input.origin.latitude,
    originLongitude: input.origin.longitude,
    destinationLabel: input.destination.label,
    destinationStreet: input.destination.street,
    destinationNumber: input.destination.number,
    destinationComplement: input.destination.complement,
    destinationDistrict: input.destination.district,
    destinationPostalCode: input.destination.postalCode,
    destinationCity: input.destination.city,
    destinationState: input.destination.state,
    destinationLatitude: input.destination.latitude,
    destinationLongitude: input.destination.longitude,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    notes: input.notes,
  };
}

function snapshot(contract: ContractProps): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      ...contract,
      validFrom: contract.validFrom.toISOString().slice(0, 10),
      validUntil: contract.validUntil?.toISOString().slice(0, 10) ?? null,
      createdAt: contract.createdAt.toISOString(),
      updatedAt: contract.updatedAt.toISOString(),
    }),
  ) as Prisma.InputJsonValue;
}

@Injectable()
export class PrismaContractRepository extends ContractRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(input: {
    contract: ContractProps;
    actorUserId: string;
    commandId: string;
  }) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.routingContractHistory.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.contract.companyId,
              commandId: input.commandId,
            },
          },
        });
        if (repeated) {
          const existing = await transaction.routingContract.findUniqueOrThrow({
            where: {
              id_companyId: {
                id: repeated.contractId,
                companyId: input.contract.companyId,
              },
            },
            include: contractInclude,
          });
          return mapContract(existing);
        }
        const row = await transaction.routingContract.create({
          data: {
            id: input.contract.id,
            companyId: input.contract.companyId,
            ...contractData(input.contract),
            createdByUserId: input.actorUserId,
            costCenters: {
              create: input.contract.costCenters.map((costCenter) => ({
                companyId: input.contract.companyId,
                code: costCenter.code,
                name: costCenter.name,
              })),
            },
            shifts: {
              create: input.contract.shifts.map((shift) => ({
                companyId: input.contract.companyId,
                name: shift.name,
                requiredArrivalTime: shift.requiredArrivalTime,
                vehicleCount: shift.vehicleCount,
                vehicleCapacity: shift.vehicleCapacity,
                activeWeekdays: shift.activeWeekdays,
              })),
            },
          },
          include: contractInclude,
        });
        const mapped = mapContract(row);
        await transaction.routingContractHistory.create({
          data: {
            companyId: input.contract.companyId,
            contractId: row.id,
            actorUserId: input.actorUserId,
            commandId: input.commandId,
            action: 'CONTRACT_CREATED',
            afterSnapshot: snapshot(mapped),
          },
        });
        return mapped;
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async list(
    companyId: string,
    query: ContractListQuery,
  ): Promise<ContractListResult> {
    const search = query.search?.trim();
    const where: Prisma.RoutingContractWhereInput = {
      companyId,
      ...(query.routingCompanyId
        ? { routingCompanyId: query.routingCompanyId }
        : {}),
      ...(query.status
        ? { status: query.status.toUpperCase() as RoutingContractStatus }
        : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { unitName: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.routingContract.findMany({
        where,
        include: contractInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.routingContract.count({ where }),
    ]);
    return { items: rows.map(mapContract), total };
  }

  async find(companyId: string, contractId: string) {
    const row = await this.prisma.routingContract.findUnique({
      where: { id_companyId: { id: contractId, companyId } },
      include: contractInclude,
    });
    return row ? mapContract(row) : null;
  }

  async update(input: {
    companyId: string;
    contractId: string;
    data: ContractData;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    reason?: string;
  }) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.routingContractHistory.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.companyId,
              commandId: input.commandId,
            },
          },
        });
        if (repeated) {
          const existing = await transaction.routingContract.findUnique({
            where: {
              id_companyId: {
                id: repeated.contractId,
                companyId: input.companyId,
              },
            },
            include: contractInclude,
          });
          return existing ? mapContract(existing) : null;
        }
        const beforeRow = await transaction.routingContract.findUnique({
          where: {
            id_companyId: { id: input.contractId, companyId: input.companyId },
          },
          include: contractInclude,
        });
        if (!beforeRow || beforeRow.version !== input.expectedVersion)
          return null;
        await transaction.routingContractCostCenter.deleteMany({
          where: { companyId: input.companyId, contractId: input.contractId },
        });
        await transaction.routingContractShift.deleteMany({
          where: { companyId: input.companyId, contractId: input.contractId },
        });
        const updated = await transaction.routingContract.update({
          where: {
            id_companyId: { id: input.contractId, companyId: input.companyId },
          },
          data: {
            ...contractData(input.data),
            version: { increment: 1 },
            costCenters: {
              create: input.data.costCenters.map((costCenter) => ({
                companyId: input.companyId,
                code: costCenter.code,
                name: costCenter.name,
              })),
            },
            shifts: {
              create: input.data.shifts.map((shift) => ({
                companyId: input.companyId,
                name: shift.name,
                requiredArrivalTime: shift.requiredArrivalTime,
                vehicleCount: shift.vehicleCount,
                vehicleCapacity: shift.vehicleCapacity,
                activeWeekdays: shift.activeWeekdays,
              })),
            },
          },
          include: contractInclude,
        });
        const before = mapContract(beforeRow);
        const after = mapContract(updated);
        await transaction.routingContractHistory.create({
          data: {
            companyId: input.companyId,
            contractId: input.contractId,
            actorUserId: input.actorUserId,
            commandId: input.commandId,
            action:
              before.status === after.status
                ? 'CONTRACT_UPDATED'
                : 'CONTRACT_STATUS_CHANGED',
            beforeSnapshot: snapshot(before),
            afterSnapshot: snapshot(after),
            reason: input.reason?.trim() || null,
          },
        });
        return after;
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async history(
    companyId: string,
    contractId: string,
  ): Promise<ContractHistoryRecord[]> {
    const rows = await this.prisma.routingContractHistory.findMany({
      where: { companyId, contractId },
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
}

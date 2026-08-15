import { Injectable } from '@nestjs/common';

import {
  RouteRepository,
  type RouteHistoryRecord,
  type RouteListQuery,
  type RouteListResult,
  type RouteVersionRecord,
} from '../../../application/contracts/route.repository';
import type {
  RouteAddress,
  RouteAggregate,
  RouteData,
  RouteNavigationLink,
  RoutePlan,
  RoutePoint,
  RouteProps,
  RouteStatus,
  RouteType,
} from '../../../domain/routing/route';
import {
  RoutingAssignmentStatus,
  RoutingDataOrigin,
  RoutingDirection,
  RoutingRouteStatus,
  RoutingRouteType,
  type Prisma,
} from '../prisma/generated/client';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

const routeInclude = {
  points: { orderBy: [{ direction: 'asc' }, { sequence: 'asc' }] },
  passengers: {
    include: {
      passenger: {
        select: {
          fullName: true,
          accessibilityRequired: true,
          accessibilityNotes: true,
        },
      },
    },
    orderBy: [{ boardingOrder: 'asc' }, { passengerId: 'asc' }],
  },
  navigationLinks: { orderBy: [{ direction: 'asc' }, { sequence: 'asc' }] },
} satisfies Prisma.RoutingRouteInclude;

type RouteRow = Prisma.RoutingRouteGetPayload<{ include: typeof routeInclude }>;

function toRouteStatus(value: RoutingRouteStatus): RouteStatus {
  return value.toLowerCase().replaceAll('_', '-') as RouteStatus;
}

function fromRouteStatus(value: RouteStatus): RoutingRouteStatus {
  return value.toUpperCase().replaceAll('-', '_') as RoutingRouteStatus;
}

function toRouteType(value: RoutingRouteType): RouteType {
  return value.toLowerCase() as RouteType;
}

function fromRouteType(value: RouteType): RoutingRouteType {
  return value.toUpperCase() as RoutingRouteType;
}

function address(
  row: RouteRow,
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

function mapPoint(row: RouteRow['points'][number]): RoutePoint {
  return {
    id: row.id,
    fixedPointId: row.fixedPointId,
    direction: row.direction.toLowerCase() as RoutePoint['direction'],
    sequence: row.sequence,
    address: {
      label: row.label,
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
    origin: row.origin.toLowerCase() as RoutePoint['origin'],
    scheduledTime: row.scheduledTime,
    alerts: row.alerts as string[],
  };
}

function mapRoute(row: RouteRow): RouteAggregate {
  const route: RouteProps = {
    id: row.id,
    companyId: row.companyId,
    routingCompanyId: row.routingCompanyId,
    contractId: row.contractId,
    code: row.code,
    name: row.name,
    shift: row.shift,
    requiredArrivalTime: row.requiredArrivalTime,
    type: toRouteType(row.type),
    requiresDocumentation: row.requiresDocumentation,
    requiredDocumentTypeCodes: row.requiredDocumentTypeCodes,
    origin: address(row, 'origin'),
    destination: address(row, 'destination'),
    predictedVehicleReference: row.predictedVehicleReference,
    predictedVehicleName: row.predictedVehicleName,
    predictedVehicleCapacity: row.predictedVehicleCapacity,
    maxWalkingDistanceMeters: row.maxWalkingDistanceMeters,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    notes: row.notes,
    status: toRouteStatus(row.status),
    needsRerouting: row.needsRerouting,
    version: row.version,
    planVersion: row.planVersion,
    approvedVersion: row.approvedVersion,
    plannedOutboundKm:
      row.plannedOutboundKm === null ? null : Number(row.plannedOutboundKm),
    plannedReturnKm:
      row.plannedReturnKm === null ? null : Number(row.plannedReturnKm),
    plannedTotalKm:
      row.plannedTotalKm === null ? null : Number(row.plannedTotalKm),
    estimatedDurationMinutes: row.estimatedDurationMinutes,
    overflowPassengerCount: row.overflowPassengerCount,
    additionalRouteSuggested: row.additionalRouteSuggested,
    createdByUserId: row.createdByUserId,
    publishedByUserId: row.publishedByUserId,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return {
    route,
    points: row.points.map(mapPoint),
    assignments: row.passengers.map((assignment) => ({
      id: assignment.id,
      passengerId: assignment.passengerId,
      pointId: assignment.pointId,
      status: assignment.status
        .toLowerCase()
        .replaceAll(
          '_',
          '-',
        ) as RouteAggregate['assignments'][number]['status'],
      walkingDistanceMeters: assignment.walkingDistanceMeters,
      boardingOrder: assignment.boardingOrder,
      origin:
        assignment.origin.toLowerCase() as RouteAggregate['assignments'][number]['origin'],
      warnings: assignment.warnings as string[],
      passengerName: assignment.passenger.fullName,
      accessibilityRequired: assignment.passenger.accessibilityRequired,
      accessibilityNotes: assignment.passenger.accessibilityNotes,
    })),
    navigationLinks: row.navigationLinks.map((link) => ({
      id: link.id,
      routeVersion: link.routeVersion,
      direction:
        link.direction.toLowerCase() as RouteNavigationLink['direction'],
      sequence: link.sequence,
      label: link.label,
      url: link.url,
    })),
  };
}

function snapshot(aggregate: RouteAggregate): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify({
      ...aggregate,
      route: {
        ...aggregate.route,
        validFrom: aggregate.route.validFrom.toISOString().slice(0, 10),
        validUntil:
          aggregate.route.validUntil?.toISOString().slice(0, 10) ?? null,
        publishedAt: aggregate.route.publishedAt?.toISOString() ?? null,
        createdAt: aggregate.route.createdAt.toISOString(),
        updatedAt: aggregate.route.updatedAt.toISOString(),
      },
    }),
  ) as Prisma.InputJsonValue;
}

function routeData(input: RouteData) {
  return {
    routingCompanyId: input.routingCompanyId,
    contractId: input.contractId,
    code: input.code,
    name: input.name,
    shift: input.shift,
    requiredArrivalTime: input.requiredArrivalTime,
    type: fromRouteType(input.type),
    requiresDocumentation: input.requiresDocumentation,
    requiredDocumentTypeCodes: input.requiredDocumentTypeCodes,
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
    predictedVehicleReference: input.predictedVehicleReference,
    predictedVehicleName: input.predictedVehicleName,
    predictedVehicleCapacity: input.predictedVehicleCapacity,
    maxWalkingDistanceMeters: input.maxWalkingDistanceMeters,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    notes: input.notes,
  };
}

function pointData(companyId: string, routeId: string, point: RoutePoint) {
  return {
    id: point.id,
    companyId,
    routeId,
    fixedPointId: point.fixedPointId ?? null,
    direction: point.direction.toUpperCase() as RoutingDirection,
    sequence: point.sequence,
    label: point.address.label,
    street: point.address.street,
    number: point.address.number,
    complement: point.address.complement,
    district: point.address.district,
    postalCode: point.address.postalCode,
    city: point.address.city,
    state: point.address.state,
    latitude: point.address.latitude,
    longitude: point.address.longitude,
    origin: point.origin.toUpperCase() as RoutingDataOrigin,
    scheduledTime: point.scheduledTime,
    alerts: point.alerts,
  };
}

function assignmentData(
  companyId: string,
  routeId: string,
  assignment: RoutePlan['assignments'][number],
) {
  return {
    id: assignment.id,
    companyId,
    routeId,
    passengerId: assignment.passengerId,
    pointId: assignment.pointId,
    status: assignment.status
      .toUpperCase()
      .replaceAll('-', '_') as RoutingAssignmentStatus,
    walkingDistanceMeters: assignment.walkingDistanceMeters,
    boardingOrder: assignment.boardingOrder,
    origin: assignment.origin.toUpperCase() as RoutingDataOrigin,
    warnings: assignment.warnings,
  };
}

@Injectable()
export class PrismaRouteRepository extends RouteRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async create(input: {
    route: RouteProps;
    actorUserId: string;
    commandId: string;
  }) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.routingRouteHistory.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.route.companyId,
              commandId: input.commandId,
            },
          },
        });
        if (repeated) {
          const existing = await transaction.routingRoute.findUniqueOrThrow({
            where: {
              id_companyId: {
                id: repeated.routeId,
                companyId: input.route.companyId,
              },
            },
            include: routeInclude,
          });
          return mapRoute(existing);
        }
        const created = await transaction.routingRoute.create({
          data: {
            id: input.route.id,
            companyId: input.route.companyId,
            ...routeData(input.route),
            status: RoutingRouteStatus.DRAFT,
            createdByUserId: input.actorUserId,
          },
          include: routeInclude,
        });
        const aggregate = mapRoute(created);
        const after = snapshot(aggregate);
        await transaction.routingRouteHistory.create({
          data: {
            companyId: input.route.companyId,
            routeId: created.id,
            actorUserId: input.actorUserId,
            commandId: input.commandId,
            action: 'ROUTE_CREATED',
            afterSnapshot: after,
          },
        });
        await transaction.routingRouteVersion.create({
          data: {
            companyId: input.route.companyId,
            routeId: created.id,
            version: created.version,
            planVersion: created.planVersion,
            snapshot: after,
          },
        });
        return aggregate;
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async list(
    companyId: string,
    query: RouteListQuery,
  ): Promise<RouteListResult> {
    const search = query.search?.trim();
    const where: Prisma.RoutingRouteWhereInput = {
      companyId,
      ...(query.routingCompanyId
        ? { routingCompanyId: query.routingCompanyId }
        : {}),
      ...(query.status ? { status: fromRouteStatus(query.status) } : {}),
      ...(search
        ? {
            OR: [
              { code: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              {
                predictedVehicleName: {
                  contains: search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.routingRoute.findMany({
        where,
        include: routeInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.routingRoute.count({ where }),
    ]);
    return { items: rows.map(mapRoute), total };
  }

  async find(companyId: string, routeId: string) {
    const row = await this.prisma.routingRoute.findUnique({
      where: { id_companyId: { id: routeId, companyId } },
      include: routeInclude,
    });
    return row ? mapRoute(row) : null;
  }

  async updateBase(input: {
    companyId: string;
    routeId: string;
    data: RouteData;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    reason?: string;
  }) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.routingRouteHistory.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.companyId,
              commandId: input.commandId,
            },
          },
        });
        if (repeated) {
          const existing = await transaction.routingRoute.findUnique({
            where: {
              id_companyId: {
                id: repeated.routeId,
                companyId: input.companyId,
              },
            },
            include: routeInclude,
          });
          return existing ? mapRoute(existing) : null;
        }
        const beforeRow = await transaction.routingRoute.findUnique({
          where: {
            id_companyId: { id: input.routeId, companyId: input.companyId },
          },
          include: routeInclude,
        });
        if (!beforeRow || beforeRow.version !== input.expectedVersion)
          return null;
        const nextStatus =
          beforeRow.status === RoutingRouteStatus.PUBLISHED ||
          beforeRow.status === RoutingRouteStatus.APPROVED
            ? RoutingRouteStatus.IN_REVIEW
            : RoutingRouteStatus.DRAFT;
        const updated = await transaction.routingRoute.update({
          where: {
            id_companyId: { id: input.routeId, companyId: input.companyId },
          },
          data: {
            ...routeData(input.data),
            status: nextStatus,
            needsRerouting: true,
            approvedVersion: null,
            version: { increment: 1 },
          },
          include: routeInclude,
        });
        return this.recordMutation(transaction, {
          before: mapRoute(beforeRow),
          after: mapRoute(updated),
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          action: 'ROUTE_BASE_UPDATED',
          reason: input.reason,
        });
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async savePlan(input: {
    companyId: string;
    routeId: string;
    plan: RoutePlan;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    action: 'ROUTE_CALCULATED' | 'ROUTE_RECALCULATED' | 'ROUTE_MANUALLY_EDITED';
    reason?: string;
  }) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.routingRouteHistory.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.companyId,
              commandId: input.commandId,
            },
          },
        });
        if (repeated) {
          const existing = await transaction.routingRoute.findUnique({
            where: {
              id_companyId: {
                id: repeated.routeId,
                companyId: input.companyId,
              },
            },
            include: routeInclude,
          });
          return existing ? mapRoute(existing) : null;
        }
        const beforeRow = await transaction.routingRoute.findUnique({
          where: {
            id_companyId: { id: input.routeId, companyId: input.companyId },
          },
          include: routeInclude,
        });
        if (!beforeRow || beforeRow.version !== input.expectedVersion)
          return null;
        await transaction.routingRoutePassenger.deleteMany({
          where: { companyId: input.companyId, routeId: input.routeId },
        });
        await transaction.routingRoutePoint.deleteMany({
          where: { companyId: input.companyId, routeId: input.routeId },
        });
        if (input.plan.points.length > 0) {
          await transaction.routingRoutePoint.createMany({
            data: input.plan.points.map((point) =>
              pointData(input.companyId, input.routeId, point),
            ),
          });
        }
        if (input.plan.assignments.length > 0) {
          await transaction.routingRoutePassenger.createMany({
            data: input.plan.assignments.map((assignment) =>
              assignmentData(input.companyId, input.routeId, assignment),
            ),
          });
        }
        const updated = await transaction.routingRoute.update({
          where: {
            id_companyId: { id: input.routeId, companyId: input.companyId },
          },
          data: {
            status:
              input.action === 'ROUTE_MANUALLY_EDITED'
                ? RoutingRouteStatus.IN_REVIEW
                : RoutingRouteStatus.ROUTED,
            needsRerouting: false,
            planVersion: { increment: 1 },
            version: { increment: 1 },
            approvedVersion: null,
            plannedOutboundKm: input.plan.plannedOutboundKm,
            plannedReturnKm: input.plan.plannedReturnKm,
            plannedTotalKm: input.plan.plannedTotalKm,
            estimatedDurationMinutes: input.plan.estimatedDurationMinutes,
            overflowPassengerCount: input.plan.overflowPassengerCount,
            additionalRouteSuggested: input.plan.additionalRouteSuggested,
          },
          include: routeInclude,
        });
        return this.recordMutation(transaction, {
          before: mapRoute(beforeRow),
          after: mapRoute(updated),
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          action: input.action,
          reason: input.reason,
        });
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async transition(input: {
    companyId: string;
    routeId: string;
    status: RouteStatus;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    action: string;
    reason?: string;
  }) {
    return this.simpleMutation({
      ...input,
      data: {
        status: fromRouteStatus(input.status),
        version: { increment: 1 },
      },
    });
  }

  async approve(input: {
    companyId: string;
    routeId: string;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    notes?: string;
    navigationLinks: RouteNavigationLink[];
  }) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.routingRouteHistory.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.companyId,
              commandId: input.commandId,
            },
          },
        });
        if (repeated) {
          const existing = await transaction.routingRoute.findUnique({
            where: {
              id_companyId: {
                id: repeated.routeId,
                companyId: input.companyId,
              },
            },
            include: routeInclude,
          });
          return existing ? mapRoute(existing) : null;
        }
        const beforeRow = await transaction.routingRoute.findUnique({
          where: {
            id_companyId: { id: input.routeId, companyId: input.companyId },
          },
          include: routeInclude,
        });
        if (!beforeRow || beforeRow.version !== input.expectedVersion)
          return null;
        const approvedVersion = beforeRow.version + 1;
        await transaction.routingNavigationLink.deleteMany({
          where: { companyId: input.companyId, routeId: input.routeId },
        });
        if (input.navigationLinks.length > 0) {
          await transaction.routingNavigationLink.createMany({
            data: input.navigationLinks.map((link) => ({
              companyId: input.companyId,
              routeId: input.routeId,
              routeVersion: approvedVersion,
              direction: link.direction.toUpperCase() as RoutingDirection,
              sequence: link.sequence,
              label: link.label,
              url: link.url,
            })),
          });
        }
        const updated = await transaction.routingRoute.update({
          where: {
            id_companyId: { id: input.routeId, companyId: input.companyId },
          },
          data: {
            status: RoutingRouteStatus.APPROVED,
            version: { increment: 1 },
            approvedVersion,
          },
          include: routeInclude,
        });
        await transaction.routingRouteApproval.create({
          data: {
            companyId: input.companyId,
            routeId: input.routeId,
            approvedVersion,
            approvedByUserId: input.actorUserId,
            notes: input.notes?.trim() || null,
          },
        });
        return this.recordMutation(transaction, {
          before: mapRoute(beforeRow),
          after: mapRoute(updated),
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          action: 'ROUTE_APPROVED',
          reason: input.notes,
        });
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async publish(input: {
    companyId: string;
    routeId: string;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
  }) {
    return this.simpleMutation({
      ...input,
      action: 'ROUTE_PUBLISHED',
      data: {
        status: RoutingRouteStatus.PUBLISHED,
        publishedByUserId: input.actorUserId,
        publishedAt: new Date(),
        version: { increment: 1 },
      },
    });
  }

  async history(
    companyId: string,
    routeId: string,
  ): Promise<RouteHistoryRecord[]> {
    const rows = await this.prisma.routingRouteHistory.findMany({
      where: { companyId, routeId },
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

  async version(
    companyId: string,
    routeId: string,
    version: number,
  ): Promise<RouteVersionRecord | null> {
    const row = await this.prisma.routingRouteVersion.findUnique({
      where: { companyId_routeId_version: { companyId, routeId, version } },
    });
    return row
      ? {
          ...row,
          snapshot: row.snapshot as Readonly<Record<string, unknown>>,
        }
      : null;
  }

  private async simpleMutation(input: {
    companyId: string;
    routeId: string;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    action: string;
    reason?: string;
    data: Prisma.RoutingRouteUncheckedUpdateInput;
  }) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.routingRouteHistory.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.companyId,
              commandId: input.commandId,
            },
          },
        });
        if (repeated) {
          const existing = await transaction.routingRoute.findUnique({
            where: {
              id_companyId: {
                id: repeated.routeId,
                companyId: input.companyId,
              },
            },
            include: routeInclude,
          });
          return existing ? mapRoute(existing) : null;
        }
        const beforeRow = await transaction.routingRoute.findUnique({
          where: {
            id_companyId: { id: input.routeId, companyId: input.companyId },
          },
          include: routeInclude,
        });
        if (!beforeRow || beforeRow.version !== input.expectedVersion)
          return null;
        const updated = await transaction.routingRoute.update({
          where: {
            id_companyId: { id: input.routeId, companyId: input.companyId },
          },
          data: input.data,
          include: routeInclude,
        });
        return this.recordMutation(transaction, {
          before: mapRoute(beforeRow),
          after: mapRoute(updated),
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          action: input.action,
          reason: input.reason,
        });
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  private async recordMutation(
    transaction: Prisma.TransactionClient,
    input: {
      before: RouteAggregate;
      after: RouteAggregate;
      actorUserId: string;
      commandId: string;
      action: string;
      reason?: string;
    },
  ): Promise<RouteAggregate> {
    const before = snapshot(input.before);
    const after = snapshot(input.after);
    await transaction.routingRouteHistory.create({
      data: {
        companyId: input.after.route.companyId,
        routeId: input.after.route.id,
        actorUserId: input.actorUserId,
        commandId: input.commandId,
        action: input.action,
        beforeSnapshot: before,
        afterSnapshot: after,
        reason: input.reason?.trim() || null,
      },
    });
    await transaction.routingRouteVersion.create({
      data: {
        companyId: input.after.route.companyId,
        routeId: input.after.route.id,
        version: input.after.route.version,
        planVersion: input.after.route.planVersion,
        snapshot: after,
      },
    });
    return input.after;
  }
}

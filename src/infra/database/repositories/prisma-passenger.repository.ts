import { Injectable } from '@nestjs/common';

import {
  PassengerRepository,
  type PassengerAggregate,
  type PassengerHistoryRecord,
  type PassengerImportAction,
  type PassengerImportBatchAggregate,
  type PassengerImportBatchRecord,
  type PassengerImportProblem,
  type PassengerListQuery,
  type PassengerListResult,
} from '../../../application/contracts/passenger.repository';
import type {
  PassengerData,
  PassengerIssueInput,
  PassengerProps,
  PassengerRegistrationStatus,
  PassengerStatus,
  RoutingDataOrigin,
} from '../../../domain/routing/passenger';
import {
  normalizePassengerName,
  passengerIdentityFingerprint,
} from '../../../domain/routing/passenger';
import {
  PassengerImportAction as PrismaPassengerImportAction,
  PassengerImportBatchStatus as PrismaPassengerImportBatchStatus,
  PassengerIssueStatus as PrismaPassengerIssueStatus,
  PassengerRegistrationStatus as PrismaPassengerRegistrationStatus,
  PassengerStatus as PrismaPassengerStatus,
  RoutingDataOrigin as PrismaRoutingDataOrigin,
  type Prisma,
} from '../prisma/generated/client';
import { rethrowKnownPrismaConflict } from '../prisma/prisma-errors';
import { PrismaService } from '../prisma/prisma.service';

const passengerInclude = {
  documents: { orderBy: [{ documentTypeCode: 'asc' as const }] },
  issues: {
    orderBy: [{ status: 'asc' as const }, { createdAt: 'asc' as const }],
  },
} as const satisfies Prisma.PassengerInclude;

type PassengerRow = Prisma.PassengerGetPayload<{
  include: typeof passengerInclude;
}>;

function passengerStatus(status: PassengerStatus) {
  return status.replaceAll('-', '_').toUpperCase() as PrismaPassengerStatus;
}

function registrationStatus(status: PassengerRegistrationStatus) {
  return status.toUpperCase() as PrismaPassengerRegistrationStatus;
}

function dataOrigin(origin: RoutingDataOrigin) {
  return origin.toUpperCase() as PrismaRoutingDataOrigin;
}

function importAction(action: PassengerImportAction) {
  return action.toUpperCase() as PrismaPassengerImportAction;
}

function mapPassenger(row: PassengerRow): PassengerAggregate {
  return {
    passenger: {
      ...row,
      residenceLatitude:
        row.residenceLatitude === null ? null : Number(row.residenceLatitude),
      residenceLongitude:
        row.residenceLongitude === null ? null : Number(row.residenceLongitude),
      predefinedBoardingLatitude:
        row.predefinedBoardingLatitude === null
          ? null
          : Number(row.predefinedBoardingLatitude),
      predefinedBoardingLongitude:
        row.predefinedBoardingLongitude === null
          ? null
          : Number(row.predefinedBoardingLongitude),
      predefinedBoardingOrigin: row.predefinedBoardingOrigin
        ? (row.predefinedBoardingOrigin.toLowerCase() as RoutingDataOrigin)
        : null,
      status: row.status.toLowerCase().replaceAll('_', '-') as PassengerStatus,
      registrationStatus:
        row.registrationStatus.toLowerCase() as PassengerRegistrationStatus,
    },
    documents: row.documents.map((document) => ({
      ...document,
      data: document.data as Readonly<Record<string, unknown>>,
      origin: document.origin.toLowerCase() as RoutingDataOrigin,
    })),
    issues: row.issues.map((issue) => ({
      ...issue,
      status: issue.status.toLowerCase() as 'open' | 'resolved',
    })),
  };
}

function passengerWriteData(
  data: PassengerData,
  derived: {
    identityFingerprint: string;
    normalizedName: string;
    registrationStatus: PassengerRegistrationStatus;
  },
): Prisma.PassengerUncheckedUpdateInput {
  return {
    ...data,
    identityFingerprint: derived.identityFingerprint,
    normalizedName: derived.normalizedName,
    registrationStatus: registrationStatus(derived.registrationStatus),
    predefinedBoardingOrigin: data.predefinedBoardingOrigin
      ? dataOrigin(data.predefinedBoardingOrigin)
      : null,
  };
}

function snapshot(passenger: PassengerProps): Prisma.InputJsonValue {
  return {
    id: passenger.id,
    routingCompanyId: passenger.routingCompanyId,
    externalReference: passenger.externalReference,
    fullName: passenger.fullName,
    shift: passenger.shift,
    requiredArrivalTime: passenger.requiredArrivalTime,
    sector: passenger.sector,
    accessibilityRequired: passenger.accessibilityRequired,
    accessibilityNotes: passenger.accessibilityNotes,
    residence: {
      street: passenger.residenceStreet,
      number: passenger.residenceNumber,
      complement: passenger.residenceComplement,
      district: passenger.residenceDistrict,
      postalCode: passenger.residencePostalCode,
      city: passenger.residenceCity,
      state: passenger.residenceState,
      latitude: passenger.residenceLatitude,
      longitude: passenger.residenceLongitude,
    },
    predefinedBoardingPoint: {
      label: passenger.predefinedBoardingLabel,
      street: passenger.predefinedBoardingStreet,
      number: passenger.predefinedBoardingNumber,
      complement: passenger.predefinedBoardingComplement,
      district: passenger.predefinedBoardingDistrict,
      postalCode: passenger.predefinedBoardingPostalCode,
      city: passenger.predefinedBoardingCity,
      state: passenger.predefinedBoardingState,
      latitude: passenger.predefinedBoardingLatitude,
      longitude: passenger.predefinedBoardingLongitude,
      origin: passenger.predefinedBoardingOrigin,
    },
    status: passenger.status,
    registrationStatus: passenger.registrationStatus,
    version: passenger.version,
  };
}

function mapBatch(row: {
  id: string;
  companyId: string;
  actorUserId: string;
  commandId: string;
  routeId: string | null;
  sourceFileName: string;
  sourceSha256: string;
  status: PrismaPassengerImportBatchStatus;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  keptCount: number;
  pendingCount: number;
  conflictCount: number;
  requiresRerouting: boolean;
  createdAt: Date;
  updatedAt: Date;
}): PassengerImportBatchRecord {
  return {
    ...row,
    status: row.status
      .toLowerCase()
      .replaceAll('_', '-') as PassengerImportBatchRecord['status'],
  };
}

@Injectable()
export class PrismaPassengerRepository extends PassengerRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  private async getWithClient(
    client: Prisma.TransactionClient | PrismaService,
    companyId: string,
    passengerId: string,
  ) {
    const row = await client.passenger.findUnique({
      where: { id_companyId: { id: passengerId, companyId } },
      include: passengerInclude,
    });
    return row ? mapPassenger(row) : null;
  }

  private async syncDocuments(
    transaction: Prisma.TransactionClient,
    companyId: string,
    passengerId: string,
    documents: {
      documentTypeCode: string;
      data: Readonly<Record<string, unknown>>;
    }[],
    origin: PrismaRoutingDataOrigin,
  ) {
    for (const document of documents) {
      await transaction.passengerDocumentData.upsert({
        where: {
          companyId_passengerId_documentTypeCode: {
            companyId,
            passengerId,
            documentTypeCode: document.documentTypeCode,
          },
        },
        create: {
          companyId,
          passengerId,
          documentTypeCode: document.documentTypeCode,
          data: document.data as Prisma.InputJsonValue,
          origin,
        },
        update: {
          data: document.data as Prisma.InputJsonValue,
          origin,
        },
      });
    }
  }

  private async syncIssues(
    transaction: Prisma.TransactionClient,
    companyId: string,
    passengerId: string,
    issues: PassengerIssueInput[],
  ) {
    const activeCodes = issues.map((issue) => issue.code);
    await transaction.passengerIssue.updateMany({
      where: {
        companyId,
        passengerId,
        status: PrismaPassengerIssueStatus.OPEN,
        ...(activeCodes.length ? { code: { notIn: activeCodes } } : {}),
      },
      data: {
        status: PrismaPassengerIssueStatus.RESOLVED,
        resolvedAt: new Date(),
      },
    });
    for (const issue of issues) {
      const existing = await transaction.passengerIssue.findFirst({
        where: { companyId, passengerId, code: issue.code },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        await transaction.passengerIssue.update({
          where: { id: existing.id },
          data: {
            ...issue,
            status: PrismaPassengerIssueStatus.OPEN,
            resolvedAt: null,
          },
        });
      } else {
        await transaction.passengerIssue.create({
          data: { companyId, passengerId, ...issue },
        });
      }
    }
  }

  async create(input: Parameters<PassengerRepository['create']>[0]) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.passengerHistory.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.passenger.companyId,
              commandId: input.commandId,
            },
          },
          select: { passengerId: true },
        });
        if (repeated) {
          return (await this.getWithClient(
            transaction,
            input.passenger.companyId,
            repeated.passengerId,
          ))!;
        }
        await transaction.passenger.create({
          data: {
            ...input.passenger,
            status: passengerStatus(input.passenger.status),
            registrationStatus: registrationStatus(
              input.passenger.registrationStatus,
            ),
            predefinedBoardingOrigin: input.passenger.predefinedBoardingOrigin
              ? dataOrigin(input.passenger.predefinedBoardingOrigin)
              : null,
          },
        });
        await this.syncDocuments(
          transaction,
          input.passenger.companyId,
          input.passenger.id,
          input.documents,
          input.action?.startsWith('PASSENGER_IMPORT')
            ? PrismaRoutingDataOrigin.IMPORT
            : PrismaRoutingDataOrigin.COMPANY,
        );
        await this.syncIssues(
          transaction,
          input.passenger.companyId,
          input.passenger.id,
          input.issues,
        );
        await transaction.passengerHistory.create({
          data: {
            companyId: input.passenger.companyId,
            passengerId: input.passenger.id,
            actorUserId: input.actorUserId,
            commandId: input.commandId,
            action: input.action ?? 'PASSENGER_CREATED',
            afterSnapshot: snapshot(input.passenger),
            reason: input.reason,
          },
        });
        return (await this.getWithClient(
          transaction,
          input.passenger.companyId,
          input.passenger.id,
        ))!;
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async update(input: Parameters<PassengerRepository['update']>[0]) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const repeated = await transaction.passengerHistory.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.companyId,
              commandId: input.commandId,
            },
          },
          select: { passengerId: true },
        });
        if (repeated) {
          if (repeated.passengerId !== input.passengerId) return null;
          return this.getWithClient(
            transaction,
            input.companyId,
            input.passengerId,
          );
        }
        const before = await this.getWithClient(
          transaction,
          input.companyId,
          input.passengerId,
        );
        if (!before || before.passenger.version !== input.expectedVersion) {
          return null;
        }
        const issuesBlockRouting = input.issues.some(
          (issue) => issue.blocksRouting,
        );
        const derived = {
          identityFingerprint: passengerIdentityFingerprint(input.data),
          normalizedName: normalizePassengerName(input.data.fullName),
          registrationStatus: issuesBlockRouting
            ? ('pending' as const)
            : ('ready' as const),
        };
        await transaction.passenger.update({
          where: {
            id_companyId: {
              id: input.passengerId,
              companyId: input.companyId,
            },
          },
          data: {
            ...passengerWriteData(input.data, derived),
            version: { increment: 1 },
          },
        });
        if (input.documents) {
          await this.syncDocuments(
            transaction,
            input.companyId,
            input.passengerId,
            input.documents,
            input.action?.startsWith('PASSENGER_IMPORT')
              ? PrismaRoutingDataOrigin.IMPORT
              : PrismaRoutingDataOrigin.OPERATIONS,
          );
        }
        await this.syncIssues(
          transaction,
          input.companyId,
          input.passengerId,
          input.issues,
        );
        const after = (await this.getWithClient(
          transaction,
          input.companyId,
          input.passengerId,
        ))!;
        await transaction.passengerHistory.create({
          data: {
            companyId: input.companyId,
            passengerId: input.passengerId,
            actorUserId: input.actorUserId,
            commandId: input.commandId,
            action: input.action ?? 'PASSENGER_UPDATED',
            beforeSnapshot: snapshot(before.passenger),
            afterSnapshot: snapshot(after.passenger),
            reason: input.reason,
          },
        });
        return after;
      });
    } catch (error) {
      rethrowKnownPrismaConflict(error);
    }
  }

  async changeStatus(
    input: Parameters<PassengerRepository['changeStatus']>[0],
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const repeated = await transaction.passengerHistory.findUnique({
        where: {
          companyId_commandId: {
            companyId: input.companyId,
            commandId: input.commandId,
          },
        },
        select: { passengerId: true },
      });
      if (repeated) {
        if (repeated.passengerId !== input.passengerId) return null;
        return this.getWithClient(
          transaction,
          input.companyId,
          input.passengerId,
        );
      }
      const before = await this.getWithClient(
        transaction,
        input.companyId,
        input.passengerId,
      );
      if (!before || before.passenger.version !== input.expectedVersion) {
        return null;
      }
      await transaction.passenger.update({
        where: {
          id_companyId: {
            id: input.passengerId,
            companyId: input.companyId,
          },
        },
        data: {
          status: passengerStatus(input.status),
          version: { increment: 1 },
        },
      });
      const after = (await this.getWithClient(
        transaction,
        input.companyId,
        input.passengerId,
      ))!;
      await transaction.passengerHistory.create({
        data: {
          companyId: input.companyId,
          passengerId: input.passengerId,
          actorUserId: input.actorUserId,
          commandId: input.commandId,
          action: 'PASSENGER_STATUS_CHANGED',
          beforeSnapshot: snapshot(before.passenger),
          afterSnapshot: snapshot(after.passenger),
          reason: input.reason,
        },
      });
      return after;
    });
  }

  async find(companyId: string, passengerId: string) {
    return this.getWithClient(this.prisma, companyId, passengerId);
  }

  async list(
    companyId: string,
    query: PassengerListQuery,
  ): Promise<PassengerListResult> {
    const search = query.search?.trim();
    const where: Prisma.PassengerWhereInput = {
      companyId,
      ...(query.routingCompanyId
        ? { routingCompanyId: query.routingCompanyId }
        : {}),
      ...(query.status ? { status: passengerStatus(query.status) } : {}),
      ...(query.registrationStatus
        ? { registrationStatus: registrationStatus(query.registrationStatus) }
        : {}),
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { externalReference: { contains: search, mode: 'insensitive' } },
              { residencePostalCode: { contains: search.replace(/\D/g, '') } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.passenger.findMany({
        where,
        include: passengerInclude,
        orderBy: [{ fullName: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.passenger.count({ where }),
    ]);
    return { items: rows.map(mapPassenger), total };
  }

  async findByExternalReference(
    companyId: string,
    routingCompanyId: string,
    externalReference: string,
  ) {
    const row = await this.prisma.passenger.findUnique({
      where: {
        companyId_routingCompanyId_externalReference: {
          companyId,
          routingCompanyId,
          externalReference,
        },
      },
      include: passengerInclude,
    });
    return row ? mapPassenger(row) : null;
  }

  async findByFingerprint(
    companyId: string,
    routingCompanyId: string,
    identityFingerprint: string,
  ) {
    const rows = await this.prisma.passenger.findMany({
      where: { companyId, routingCompanyId, identityFingerprint },
      include: passengerInclude,
      take: 3,
    });
    return rows.map(mapPassenger);
  }

  async history(
    companyId: string,
    passengerId: string,
  ): Promise<PassengerHistoryRecord[]> {
    const rows = await this.prisma.passengerHistory.findMany({
      where: { companyId, passengerId },
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

  async beginImport(input: Parameters<PassengerRepository['beginImport']>[0]) {
    const existing = await this.prisma.passengerImportBatch.findUnique({
      where: {
        companyId_commandId: {
          companyId: input.companyId,
          commandId: input.commandId,
        },
      },
    });
    if (existing) return { batch: mapBatch(existing), idempotent: true };
    const batch = await this.prisma.passengerImportBatch.create({
      data: input,
    });
    return { batch: mapBatch(batch), idempotent: false };
  }

  async saveImportRecord(
    input: Parameters<PassengerRepository['saveImportRecord']>[0],
  ) {
    await this.prisma.passengerImportRecord.upsert({
      where: {
        batchId_rowNumber: {
          batchId: input.batchId,
          rowNumber: input.rowNumber,
        },
      },
      create: {
        ...input,
        action: importAction(input.action),
        payload: input.payload as Prisma.InputJsonValue,
        problems: input.problems as unknown as Prisma.InputJsonValue,
      },
      update: {
        routingCompanyId: input.routingCompanyId,
        passengerId: input.passengerId,
        action: importAction(input.action),
        payload: input.payload as Prisma.InputJsonValue,
        problems: input.problems as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async completeImport(
    input: Parameters<PassengerRepository['completeImport']>[0],
  ): Promise<PassengerImportBatchAggregate> {
    await this.prisma.passengerImportBatch.update({
      where: {
        id_companyId: { id: input.batchId, companyId: input.companyId },
      },
      data: {
        totalRows: input.totalRows,
        createdCount: input.createdCount,
        updatedCount: input.updatedCount,
        keptCount: input.keptCount,
        pendingCount: input.pendingCount,
        conflictCount: input.conflictCount,
        requiresRerouting: input.requiresRerouting,
        status:
          input.pendingCount || input.conflictCount
            ? PrismaPassengerImportBatchStatus.REVIEW_REQUIRED
            : PrismaPassengerImportBatchStatus.COMPLETED,
      },
    });
    return (await this.getImport(input.companyId, input.batchId))!;
  }

  async getImport(
    companyId: string,
    batchId: string,
  ): Promise<PassengerImportBatchAggregate | null> {
    const row = await this.prisma.passengerImportBatch.findUnique({
      where: { id_companyId: { id: batchId, companyId } },
      include: { records: { orderBy: { rowNumber: 'asc' } } },
    });
    if (!row) return null;
    return {
      batch: mapBatch(row),
      records: row.records.map((record) => ({
        ...record,
        action: record.action.toLowerCase() as PassengerImportAction,
        payload: record.payload as Readonly<Record<string, unknown>>,
        problems: record.problems as unknown as PassengerImportProblem[],
      })),
    };
  }
}

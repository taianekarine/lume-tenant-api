import { createHash } from 'node:crypto';

import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import {
  createPassenger,
  normalizePassengerData,
  passengerIdentityFingerprint,
  validatePassengerData,
  type PassengerData,
  type PassengerDocumentInput,
} from '../../../domain/routing/passenger';
import { PassengerWorkbookService } from '../../../infra/routing/passenger-workbook.service';
import type { PassengerWorkbookRow } from '../../../infra/routing/passenger-workbook.service';
import { PassengerRepository } from '../../contracts/passenger.repository';
import type { PassengerImportProblem } from '../../contracts/passenger.repository';
import { RoutingRepository } from '../../contracts/routing.repository';
import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';
import { FixedPointRepository } from '../../contracts/fixed-point.repository';
import type { RoutingFixedPointProps } from '../../../domain/routing/fixed-point';
import { PostalCodeLookupService } from '../../../infra/routing/postal-code-lookup.service';
import {
  mergePassengerData,
  type PassengerMutationInput,
  validateDocuments,
} from './passengers.use-case';

function deterministicCommandId(batchId: string, rowNumber: number): string {
  const bytes = createHash('sha256')
    .update(`${batchId}:${rowNumber}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rowData(
  row: PassengerWorkbookRow,
  routingCompanyId: string,
  fixedPoint: RoutingFixedPointProps | null,
) {
  return normalizePassengerData({
    routingCompanyId,
    externalReference: row.externalReference,
    fullName: row.fullName,
    shift: row.shift,
    requiredArrivalTime: row.requiredArrivalTime,
    sector: row.sector,
    accessibilityRequired: row.accessibilityRequired,
    accessibilityNotes: row.accessibilityNotes,
    residenceStreet: row.residenceStreet,
    residenceNumber: row.residenceNumber,
    residenceComplement: row.residenceComplement,
    residenceDistrict: row.residenceDistrict,
    residencePostalCode: row.residencePostalCode,
    residenceCity: row.residenceCity,
    residenceState: row.residenceState,
    residenceLatitude: row.residenceLatitude,
    residenceLongitude: row.residenceLongitude,
    predefinedBoardingLabel: fixedPoint?.name ?? null,
    predefinedBoardingStreet: fixedPoint?.address.street ?? null,
    predefinedBoardingNumber: fixedPoint?.address.number ?? null,
    predefinedBoardingComplement: fixedPoint?.address.complement ?? null,
    predefinedBoardingDistrict: fixedPoint?.address.district ?? null,
    predefinedBoardingPostalCode: fixedPoint?.address.postalCode ?? null,
    predefinedBoardingCity: fixedPoint?.address.city ?? null,
    predefinedBoardingState: fixedPoint?.address.state ?? null,
    predefinedBoardingLatitude: fixedPoint?.address.latitude ?? null,
    predefinedBoardingLongitude: fixedPoint?.address.longitude ?? null,
    predefinedBoardingOrigin: fixedPoint ? 'company' : null,
    predefinedBoardingFixedPointId: fixedPoint?.id ?? null,
  });
}

function mergeIncremental(current: PassengerData, incoming: PassengerData) {
  const pick = <T>(next: T | null, previous: T | null) => next ?? previous;
  const hasPoint = Boolean(
    incoming.predefinedBoardingLabel ||
    incoming.predefinedBoardingStreet ||
    incoming.predefinedBoardingLatitude !== null ||
    incoming.predefinedBoardingLongitude !== null,
  );
  return normalizePassengerData({
    routingCompanyId: current.routingCompanyId,
    externalReference: pick(
      incoming.externalReference,
      current.externalReference,
    ),
    fullName: incoming.fullName,
    shift: pick(incoming.shift, current.shift),
    requiredArrivalTime: pick(
      incoming.requiredArrivalTime,
      current.requiredArrivalTime,
    ),
    sector: pick(incoming.sector, current.sector),
    accessibilityRequired: incoming.accessibilityRequired,
    accessibilityNotes: pick(
      incoming.accessibilityNotes,
      current.accessibilityNotes,
    ),
    residenceStreet: pick(incoming.residenceStreet, current.residenceStreet),
    residenceNumber: pick(incoming.residenceNumber, current.residenceNumber),
    residenceComplement: pick(
      incoming.residenceComplement,
      current.residenceComplement,
    ),
    residenceDistrict: pick(
      incoming.residenceDistrict,
      current.residenceDistrict,
    ),
    residencePostalCode: pick(
      incoming.residencePostalCode,
      current.residencePostalCode,
    ),
    residenceCity: pick(incoming.residenceCity, current.residenceCity),
    residenceState: pick(incoming.residenceState, current.residenceState),
    residenceLatitude: pick(
      incoming.residenceLatitude,
      current.residenceLatitude,
    ),
    residenceLongitude: pick(
      incoming.residenceLongitude,
      current.residenceLongitude,
    ),
    predefinedBoardingLabel: hasPoint
      ? incoming.predefinedBoardingLabel
      : current.predefinedBoardingLabel,
    predefinedBoardingStreet: hasPoint
      ? incoming.predefinedBoardingStreet
      : current.predefinedBoardingStreet,
    predefinedBoardingNumber: hasPoint
      ? incoming.predefinedBoardingNumber
      : current.predefinedBoardingNumber,
    predefinedBoardingComplement: hasPoint
      ? incoming.predefinedBoardingComplement
      : current.predefinedBoardingComplement,
    predefinedBoardingDistrict: hasPoint
      ? incoming.predefinedBoardingDistrict
      : current.predefinedBoardingDistrict,
    predefinedBoardingPostalCode: hasPoint
      ? incoming.predefinedBoardingPostalCode
      : current.predefinedBoardingPostalCode,
    predefinedBoardingCity: hasPoint
      ? incoming.predefinedBoardingCity
      : current.predefinedBoardingCity,
    predefinedBoardingState: hasPoint
      ? incoming.predefinedBoardingState
      : current.predefinedBoardingState,
    predefinedBoardingLatitude: hasPoint
      ? incoming.predefinedBoardingLatitude
      : current.predefinedBoardingLatitude,
    predefinedBoardingLongitude: hasPoint
      ? incoming.predefinedBoardingLongitude
      : current.predefinedBoardingLongitude,
    predefinedBoardingOrigin: hasPoint
      ? 'company'
      : current.predefinedBoardingOrigin,
    predefinedBoardingFixedPointId: hasPoint
      ? incoming.predefinedBoardingFixedPointId
      : current.predefinedBoardingFixedPointId,
  });
}

function comparable(data: PassengerData) {
  return JSON.stringify(data);
}

function documentsChanged(
  current: {
    documentTypeCode: string;
    data: Readonly<Record<string, unknown>>;
  }[],
  incoming: PassengerDocumentInput[],
) {
  if (!incoming.length) return false;
  const currentMap = new Map(
    current.map((document) => [
      document.documentTypeCode,
      JSON.stringify(document.data),
    ]),
  );
  return incoming.some(
    (document) =>
      currentMap.get(document.documentTypeCode) !==
      JSON.stringify(document.data),
  );
}

function presentImportDate(value: Date) {
  return value.toISOString();
}

export class PassengerImportUseCase {
  constructor(
    private readonly passengers: PassengerRepository,
    private readonly routing: RoutingRepository,
    private readonly workbook: PassengerWorkbookService,
    private readonly fixedPoints: FixedPointRepository,
    private readonly postalCodes: PostalCodeLookupService,
  ) {}

  async template(current: AuthenticatedPrincipal, routingCompanyId?: string) {
    const clientId = current.routingCompanyId ?? routingCompanyId;
    const result = await this.fixedPoints.list(current.companyId, {
      page: 1,
      pageSize: 1_000,
      status: 'active',
      ...(clientId ? { routingCompanyId: clientId } : {}),
    });
    const clients = new Map<string, string>();
    await Promise.all(
      result.items.map(async (point) => {
        if (!point.routingCompanyId || clients.has(point.routingCompanyId))
          return;
        const company = await this.routing.findCompany(
          current.companyId,
          point.routingCompanyId,
        );
        clients.set(
          point.routingCompanyId,
          company?.tradeName ?? company?.legalName ?? 'Cliente',
        );
      }),
    );
    return this.workbook.createTemplate(
      result.items.map((point) => ({
        code: point.code,
        name: point.name,
        clientName: point.routingCompanyId
          ? (clients.get(point.routingCompanyId) ?? 'Cliente')
          : 'Todos os clientes',
        address: `${point.address.street}, ${point.address.number} - ${point.address.district} - ${point.address.city}/${point.address.state} - CEP ${point.address.postalCode}`,
      })),
    );
  }

  async import(
    current: AuthenticatedPrincipal,
    input: {
      commandId: string;
      routeId?: string;
      routingCompanyId?: string;
      fileName: string;
      content: Buffer;
    },
  ) {
    const routingCompanyId = current.routingCompanyId ?? input.routingCompanyId;
    if (!routingCompanyId) {
      throw validationError(
        'Selecione o cliente dos colaboradores antes de importar.',
      );
    }
    if (
      current.routingCompanyId &&
      input.routingCompanyId &&
      input.routingCompanyId !== current.routingCompanyId
    ) {
      throw forbidden('O cliente informado nao pertence ao seu acesso.');
    }
    const routingCompany = await this.routing.findCompany(
      current.companyId,
      routingCompanyId,
    );
    if (!routingCompany || routingCompany.status !== 'active') {
      throw validationError('Selecione um cliente ativo antes de importar.');
    }
    const rows = await this.workbook.parse(input.content, input.fileName);
    const sourceSha256 = createHash('sha256')
      .update(input.content)
      .digest('hex');
    const started = await this.passengers.beginImport({
      companyId: current.companyId,
      actorUserId: current.id,
      commandId: input.commandId,
      routeId: input.routeId,
      sourceFileName: input.fileName,
      sourceSha256,
    });
    if (started.idempotent) {
      if (started.batch.sourceSha256 !== sourceSha256) {
        throw conflict('O commandId ja foi utilizado com outro arquivo.');
      }
      const repeated = await this.passengers.getImport(
        current.companyId,
        started.batch.id,
      );
      if (repeated && repeated.batch.status !== 'processing') {
        return this.present(repeated);
      }
    }

    const counts = {
      createdCount: 0,
      updatedCount: 0,
      keptCount: 0,
      pendingCount: 0,
      conflictCount: 0,
    };
    for (const row of rows) {
      const problems: PassengerImportProblem[] = [];
      if (!row.fullName.trim()) {
        problems.push({
          field: 'fullName',
          reason: 'Nome do colaborador nao informado.',
          resolutionAction: 'Preencha o nome completo.',
        });
      }
      const address = row.residencePostalCode
        ? await this.postalCodes.lookup(row.residencePostalCode)
        : null;
      const enrichedRow: PassengerWorkbookRow = address
        ? {
            ...row,
            residenceStreet: row.residenceStreet ?? address.street,
            residenceDistrict: row.residenceDistrict ?? address.district,
            residenceCity: row.residenceCity ?? address.city,
            residenceState: row.residenceState ?? address.state,
          }
        : row;
      let fixedPoint: RoutingFixedPointProps | null = null;
      if (row.fixedPointCode) {
        fixedPoint = await this.fixedPoints.findByCode(
          current.companyId,
          row.fixedPointCode,
        );
        if (
          !fixedPoint ||
          fixedPoint.status !== 'active' ||
          (fixedPoint.routingCompanyId &&
            fixedPoint.routingCompanyId !== routingCompanyId)
        ) {
          problems.push({
            field: 'fixedPointCode',
            reason:
              'Codigo do ponto de embarque inexistente, inativo ou de outro cliente.',
            resolutionAction: 'Use um codigo disponivel na aba Pontos fixos.',
          });
          fixedPoint = null;
        }
      }
      const payload = {
        externalReference: row.externalReference,
        fullName: row.fullName,
        shift: row.shift,
        requiredArrivalTime: row.requiredArrivalTime,
        sector: row.sector,
        accessibilityRequired: row.accessibilityRequired,
        accessibilityNotes: row.accessibilityNotes,
        residenceStreet: enrichedRow.residenceStreet,
        residenceNumber: enrichedRow.residenceNumber,
        residenceComplement: enrichedRow.residenceComplement,
        residenceDistrict: enrichedRow.residenceDistrict,
        residencePostalCode: enrichedRow.residencePostalCode,
        residenceCity: enrichedRow.residenceCity,
        residenceState: enrichedRow.residenceState,
        fixedPointCode: row.fixedPointCode,
        documentTypeCodes: row.documents.map(
          (document) => document.documentTypeCode,
        ),
      };
      if (problems.length) {
        counts.conflictCount += 1;
        await this.passengers.saveImportRecord({
          companyId: current.companyId,
          batchId: started.batch.id,
          rowNumber: row.rowNumber,
          action: 'conflict',
          payload,
          problems,
        });
        continue;
      }

      const data = rowData(enrichedRow, routingCompanyId, fixedPoint);
      const fingerprint = passengerIdentityFingerprint(data);
      const matches = data.externalReference
        ? [
            await this.passengers.findByExternalReference(
              current.companyId,
              routingCompanyId,
              data.externalReference,
            ),
          ].filter(Boolean)
        : await this.passengers.findByFingerprint(
            current.companyId,
            routingCompanyId,
            fingerprint,
          );
      if (matches.length > 1) {
        counts.conflictCount += 1;
        const conflictProblems = [
          {
            field: 'identity',
            reason:
              'Mais de um colaborador existente corresponde a esta linha.',
            resolutionAction:
              'Informe um Codigo externo unico e revise o cadastro.',
          },
        ];
        await this.passengers.saveImportRecord({
          companyId: current.companyId,
          batchId: started.batch.id,
          rowNumber: row.rowNumber,
          routingCompanyId,
          action: 'conflict',
          payload,
          problems: conflictProblems,
        });
        continue;
      }

      const existing = matches[0] ?? null;
      const commandId = deterministicCommandId(started.batch.id, row.rowNumber);
      let passengerId: string;
      let operation: 'created' | 'updated' | 'kept';
      let issues = validatePassengerData(data);
      if (!existing) {
        const passenger = createPassenger(current.companyId, current.id, data);
        const created = await this.passengers.create({
          passenger,
          documents: row.documents,
          issues,
          actorUserId: current.id,
          commandId,
          action: 'PASSENGER_IMPORT_CREATED',
          reason: `Importacao ${started.batch.id}, linha ${row.rowNumber}`,
        });
        passengerId = created.passenger.id;
        operation = 'created';
        counts.createdCount += 1;
      } else {
        const merged = mergeIncremental(existing.passenger, data);
        issues = validatePassengerData(merged);
        const changed =
          comparable(merged) !== comparable(existing.passenger) ||
          documentsChanged(existing.documents, row.documents);
        if (changed) {
          const updated = await this.passengers.update({
            companyId: current.companyId,
            passengerId: existing.passenger.id,
            data: merged,
            documents: row.documents.length ? row.documents : undefined,
            issues,
            actorUserId: current.id,
            commandId,
            expectedVersion: existing.passenger.version,
            action: 'PASSENGER_IMPORT_UPDATED',
            reason: `Importacao ${started.batch.id}, linha ${row.rowNumber}`,
          });
          if (!updated) {
            counts.conflictCount += 1;
            await this.passengers.saveImportRecord({
              companyId: current.companyId,
              batchId: started.batch.id,
              rowNumber: row.rowNumber,
              routingCompanyId,
              passengerId: existing.passenger.id,
              action: 'conflict',
              payload,
              problems: [
                {
                  field: 'version',
                  reason: 'O colaborador foi alterado durante a importacao.',
                  resolutionAction: 'Revise a linha e importe novamente.',
                },
              ],
            });
            continue;
          }
          operation = 'updated';
          counts.updatedCount += 1;
        } else {
          operation = 'kept';
          counts.keptCount += 1;
        }
        passengerId = existing.passenger.id;
      }

      const rowProblems = issues.map((issue) => ({
        field: issue.field,
        reason: issue.reason,
        resolutionAction: issue.resolutionAction,
      }));
      const pending = issues.some((issue) => issue.blocksRouting);
      if (pending) counts.pendingCount += 1;
      await this.passengers.saveImportRecord({
        companyId: current.companyId,
        batchId: started.batch.id,
        rowNumber: row.rowNumber,
        routingCompanyId,
        passengerId,
        action: pending ? 'pending' : operation,
        payload: { ...payload, operation },
        problems: rowProblems,
      });
    }
    return this.present(
      await this.passengers.completeImport({
        companyId: current.companyId,
        batchId: started.batch.id,
        totalRows: rows.length,
        ...counts,
        requiresRerouting: Boolean(
          input.routeId && (counts.createdCount || counts.updatedCount),
        ),
      }),
    );
  }

  async get(current: AuthenticatedPrincipal, batchId: string) {
    const batch = await this.passengers.getImport(current.companyId, batchId);
    if (!batch) throw notFound('Importacao');
    if (current.routingCompanyId && batch.batch.actorUserId !== current.id) {
      throw forbidden('Esta importacao nao pertence ao seu acesso.');
    }
    return this.present(batch);
  }

  async resolveAddress(
    current: AuthenticatedPrincipal,
    batchId: string,
    recordId: string,
    input: {
      commandId: string;
      postalCode: string;
      number: string;
      complement?: string | null;
    },
  ) {
    const batch = await this.passengers.getImport(current.companyId, batchId);
    if (!batch) throw notFound('Importacao');
    const record = batch.records.find((item) => item.id === recordId);
    if (!record || !record.passengerId) {
      throw notFound('Linha da importacao');
    }
    if (
      current.routingCompanyId &&
      record.routingCompanyId !== current.routingCompanyId
    ) {
      throw forbidden('Esta linha nao pertence ao seu acesso.');
    }
    const address = await this.postalCodes.lookup(input.postalCode);
    if (!address) {
      throw validationError('O CEP nao foi encontrado no ViaCEP.');
    }
    const aggregate = await this.passengers.find(
      current.companyId,
      record.passengerId,
    );
    if (!aggregate) throw notFound('Colaborador');
    const data = normalizePassengerData({
      ...aggregate.passenger,
      residenceStreet: address.street,
      residenceNumber: input.number,
      residenceComplement: input.complement ?? null,
      residenceDistrict: address.district,
      residencePostalCode: input.postalCode,
      residenceCity: address.city,
      residenceState: address.state,
    });
    const issues = validatePassengerData(data);
    const updated = await this.passengers.update({
      companyId: current.companyId,
      passengerId: aggregate.passenger.id,
      data,
      issues,
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: aggregate.passenger.version,
      action: 'PASSENGER_IMPORT_ADDRESS_RESOLVED',
      reason: `Correcao assistida da importacao ${batchId}, linha ${record.rowNumber}`,
    });
    if (!updated) {
      throw conflict(
        'O colaborador foi alterado. Recarregue e tente novamente.',
      );
    }
    const problems = issues.map((issue) => ({
      field: issue.field,
      reason: issue.reason,
      resolutionAction: issue.resolutionAction,
    }));
    const refreshed = await this.passengers.resolveImportRecord({
      companyId: current.companyId,
      batchId,
      recordId,
      action: issues.some((issue) => issue.blocksRouting)
        ? 'pending'
        : 'updated',
      payload: {
        ...record.payload,
        addressCorrected: true,
        postalCode: data.residencePostalCode,
      },
      problems,
    });
    return this.present(refreshed);
  }

  async resolveData(
    current: AuthenticatedPrincipal,
    batchId: string,
    recordId: string,
    input: Partial<PassengerMutationInput> & { commandId: string },
  ) {
    const batch = await this.passengers.getImport(current.companyId, batchId);
    if (!batch) throw notFound('Importacao');
    const record = batch.records.find((item) => item.id === recordId);
    if (!record || !record.passengerId) {
      throw notFound('Linha da importacao');
    }
    if (
      current.routingCompanyId &&
      record.routingCompanyId !== current.routingCompanyId
    ) {
      throw forbidden('Esta linha nao pertence ao seu acesso.');
    }
    const aggregate = await this.passengers.find(
      current.companyId,
      record.passengerId,
    );
    if (!aggregate) throw notFound('Colaborador');

    const data = mergePassengerData(aggregate.passenger, input);
    const issues = validatePassengerData(data);
    const updated = await this.passengers.update({
      companyId: current.companyId,
      passengerId: aggregate.passenger.id,
      data,
      documents:
        input.documents === undefined
          ? undefined
          : validateDocuments(input.documents),
      issues,
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: aggregate.passenger.version,
      action: 'PASSENGER_IMPORT_DATA_RESOLVED',
      reason: `Complementacao manual da importacao ${batchId}, linha ${record.rowNumber}`,
    });
    if (!updated) {
      throw conflict(
        'O colaborador foi alterado. Recarregue e tente novamente.',
      );
    }
    const problems = issues.map((issue) => ({
      field: issue.field,
      reason: issue.reason,
      resolutionAction: issue.resolutionAction,
    }));
    const refreshed = await this.passengers.resolveImportRecord({
      companyId: current.companyId,
      batchId,
      recordId,
      action: issues.some((issue) => issue.blocksRouting)
        ? 'pending'
        : 'updated',
      payload: {
        ...record.payload,
        manuallyCorrected: true,
        shift: data.shift,
        requiredArrivalTime: data.requiredArrivalTime,
      },
      problems,
    });
    return this.present(refreshed);
  }

  private present(
    batch: Awaited<ReturnType<PassengerRepository['getImport']>>,
  ) {
    if (!batch) throw notFound('Importacao');
    return {
      ...batch,
      batch: {
        ...batch.batch,
        createdAt: presentImportDate(batch.batch.createdAt),
        updatedAt: presentImportDate(batch.batch.updatedAt),
      },
      records: batch.records.map((record) => ({
        ...record,
        createdAt: presentImportDate(record.createdAt),
      })),
    };
  }
}

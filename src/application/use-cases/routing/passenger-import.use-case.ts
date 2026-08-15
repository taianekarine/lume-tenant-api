import { createHash } from 'node:crypto';

import { conflict, forbidden, notFound } from '../../../core/errors/app-error';
import {
  createPassenger,
  normalizePassengerData,
  passengerIdentityFingerprint,
  validatePassengerData,
  type PassengerData,
  type PassengerDocumentInput,
} from '../../../domain/routing/passenger';
import { normalizeTaxId } from '../../../shared/utils/normalization';
import { isValidCnpj } from '../../../shared/utils/brazilian-documents';
import { PassengerWorkbookService } from '../../../infra/routing/passenger-workbook.service';
import type { PassengerWorkbookRow } from '../../../infra/routing/passenger-workbook.service';
import { PassengerRepository } from '../../contracts/passenger.repository';
import type { PassengerImportProblem } from '../../contracts/passenger.repository';
import { RoutingRepository } from '../../contracts/routing.repository';
import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';

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

function rowData(row: PassengerWorkbookRow, routingCompanyId: string) {
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
    predefinedBoardingLabel: row.predefinedBoardingLabel,
    predefinedBoardingStreet: row.predefinedBoardingStreet,
    predefinedBoardingNumber: row.predefinedBoardingNumber,
    predefinedBoardingComplement: row.predefinedBoardingComplement,
    predefinedBoardingDistrict: row.predefinedBoardingDistrict,
    predefinedBoardingPostalCode: row.predefinedBoardingPostalCode,
    predefinedBoardingCity: row.predefinedBoardingCity,
    predefinedBoardingState: row.predefinedBoardingState,
    predefinedBoardingLatitude: row.predefinedBoardingLatitude,
    predefinedBoardingLongitude: row.predefinedBoardingLongitude,
    predefinedBoardingOrigin: 'company',
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
  ) {}

  template() {
    return this.workbook.createTemplate();
  }

  async import(
    current: AuthenticatedPrincipal,
    input: {
      commandId: string;
      routeId?: string;
      fileName: string;
      content: Buffer;
    },
  ) {
    const rows = await this.workbook.parse(input.content);
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
      const taxId = normalizeTaxId(row.companyTaxId);
      const routingCompany = isValidCnpj(taxId)
        ? await this.routing.findCompanyByTaxId(current.companyId, taxId)
        : null;
      if (!row.companyTaxId) {
        problems.push({
          field: 'companyTaxId',
          reason: 'CNPJ da empresa nao informado.',
          resolutionAction: 'Preencha o CNPJ da empresa atendida nesta linha.',
        });
      } else if (!isValidCnpj(taxId)) {
        problems.push({
          field: 'companyTaxId',
          reason: 'CNPJ da empresa invalido.',
          resolutionAction: 'Corrija o CNPJ da empresa atendida.',
        });
      } else if (!routingCompany || routingCompany.status !== 'active') {
        problems.push({
          field: 'companyTaxId',
          reason: 'Empresa cliente nao cadastrada ou inativa.',
          resolutionAction: 'Cadastre ou ative a empresa antes da importacao.',
        });
      } else if (
        current.routingCompanyId &&
        current.routingCompanyId !== routingCompany.id
      ) {
        problems.push({
          field: 'companyTaxId',
          reason: 'A empresa da linha nao pertence ao acesso do usuario.',
          resolutionAction: 'Use somente o CNPJ da sua empresa.',
        });
      }
      if (!row.fullName.trim()) {
        problems.push({
          field: 'fullName',
          reason: 'Nome do colaborador nao informado.',
          resolutionAction: 'Preencha o nome completo.',
        });
      }
      const payload = {
        companyTaxId: taxId,
        externalReference: row.externalReference,
        fullName: row.fullName,
        documentTypeCodes: row.documents.map(
          (document) => document.documentTypeCode,
        ),
      };
      if (problems.length || !routingCompany) {
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

      const data = rowData(row, routingCompany.id);
      const fingerprint = passengerIdentityFingerprint(data);
      const matches = data.externalReference
        ? [
            await this.passengers.findByExternalReference(
              current.companyId,
              routingCompany.id,
              data.externalReference,
            ),
          ].filter(Boolean)
        : await this.passengers.findByFingerprint(
            current.companyId,
            routingCompany.id,
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
          routingCompanyId: routingCompany.id,
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
              routingCompanyId: routingCompany.id,
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
        routingCompanyId: routingCompany.id,
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

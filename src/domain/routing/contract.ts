import { randomUUID } from 'node:crypto';

import { validationError } from '../../core/errors/app-error';
import {
  normalizeRouteAddress,
  type RouteAddress,
  type RouteType,
} from './route';

export const CONTRACT_STATUSES = [
  'draft',
  'active',
  'suspended',
  'ended',
] as const;
export const CONTRACT_PERIODICITIES = [
  'monthly',
  'weekly',
  'daily',
  'per-route',
] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export type ContractPeriodicity = (typeof CONTRACT_PERIODICITIES)[number];

export interface ContractCostCenter {
  id?: string;
  code: string;
  name: string | null;
}

export interface ContractShift {
  id?: string;
  name: string;
  requiredArrivalTime: string;
  vehicleCount: number | null;
  vehicleCapacity: number | null;
  activeWeekdays: number[];
}

export interface ContractData {
  routingCompanyId: string;
  code: string;
  name: string;
  operationType: string;
  routeType: RouteType;
  status: ContractStatus;
  periodicity: ContractPeriodicity;
  contractedVehicleCount: number;
  predictedVehicleName: string;
  predictedVehicleReference: string | null;
  predictedVehicleCapacity: number;
  contractedKm: number | null;
  plannedKm: number | null;
  maxWalkingDistanceMeters: number;
  requiresDocumentation: boolean;
  requiredDocumentTypeCodes: string[];
  unitName: string;
  origin: RouteAddress;
  destination: RouteAddress;
  validFrom: Date;
  validUntil: Date | null;
  notes: string | null;
  costCenters: ContractCostCenter[];
  shifts: ContractShift[];
}

export interface ContractProps extends ContractData {
  id: string;
  companyId: string;
  version: number;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

function text(value: string, label: string, max: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) throw validationError(`Informe ${label}.`);
  if (normalized.length > max) {
    throw validationError(`${label} deve possuir no maximo ${max} caracteres.`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(`${label} deve ser maior que zero.`);
  }
  return value;
}

function optionalKm(value: number | null, label: string): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw validationError(`${label} deve ser um valor positivo.`);
  }
  return Math.round(value * 1000) / 1000;
}

export function normalizeContractData(input: ContractData): ContractData {
  if (input.validUntil && input.validUntil < input.validFrom) {
    throw validationError('A vigencia final nao pode ser anterior a inicial.');
  }
  if (
    !Number.isInteger(input.maxWalkingDistanceMeters) ||
    input.maxWalkingDistanceMeters < 0
  ) {
    throw validationError('A distancia maxima deve ser informada em metros.');
  }
  const requiredDocumentTypeCodes = Array.from(
    new Set(
      input.requiredDocumentTypeCodes
        .map((code) => code.trim().toLocaleLowerCase('pt-BR'))
        .filter(Boolean),
    ),
  );
  if (
    requiredDocumentTypeCodes.some(
      (code) => !/^[a-z][a-z0-9-]{2,79}$/.test(code),
    )
  ) {
    throw validationError('Informe codigos documentais validos.');
  }
  if (input.requiresDocumentation && requiredDocumentTypeCodes.length === 0) {
    throw validationError(
      'Configure os dados documentais exigidos pelo contrato.',
    );
  }

  const costCenterCodes = new Set<string>();
  const costCenters = input.costCenters.map((costCenter) => {
    const code = text(costCenter.code, 'o centro de custo', 80).toUpperCase();
    if (costCenterCodes.has(code)) {
      throw validationError(
        `O centro de custo ${code} foi informado em duplicidade.`,
      );
    }
    costCenterCodes.add(code);
    return {
      ...(costCenter.id ? { id: costCenter.id } : {}),
      code,
      name: costCenter.name?.trim() || null,
    };
  });
  if (costCenters.length === 0) {
    throw validationError('Informe ao menos um centro de custo do contrato.');
  }

  const shiftKeys = new Set<string>();
  const shifts = input.shifts.map((shift) => {
    const name = text(shift.name, 'o turno do contrato', 80);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(shift.requiredArrivalTime)) {
      throw validationError(`Informe um horario valido para o turno ${name}.`);
    }
    const key = `${name.toLocaleLowerCase('pt-BR')}|${shift.requiredArrivalTime}`;
    if (shiftKeys.has(key)) {
      throw validationError(`O turno ${name} foi informado em duplicidade.`);
    }
    shiftKeys.add(key);
    const activeWeekdays = Array.from(new Set(shift.activeWeekdays)).sort();
    if (
      activeWeekdays.some(
        (weekday) => !Number.isInteger(weekday) || weekday < 0 || weekday > 6,
      )
    ) {
      throw validationError('Os dias ativos devem usar valores entre 0 e 6.');
    }
    return {
      ...(shift.id ? { id: shift.id } : {}),
      name,
      requiredArrivalTime: shift.requiredArrivalTime,
      vehicleCount:
        shift.vehicleCount === null
          ? null
          : positiveInteger(
              shift.vehicleCount,
              'A quantidade de veiculos do turno',
            ),
      vehicleCapacity:
        shift.vehicleCapacity === null
          ? null
          : positiveInteger(shift.vehicleCapacity, 'A capacidade do turno'),
      activeWeekdays,
    };
  });
  if (shifts.length === 0) {
    throw validationError('Informe ao menos um turno e horario do contrato.');
  }

  return {
    routingCompanyId: input.routingCompanyId,
    code: text(input.code, 'o codigo do contrato', 80).toUpperCase(),
    name: text(input.name, 'o nome do contrato', 160),
    operationType: text(input.operationType, 'o tipo de operacao', 120),
    routeType: input.routeType,
    status: input.status,
    periodicity: input.periodicity,
    contractedVehicleCount: positiveInteger(
      input.contractedVehicleCount,
      'A quantidade de veiculos contratados',
    ),
    predictedVehicleName: text(
      input.predictedVehicleName,
      'o veiculo previsto',
      160,
    ),
    predictedVehicleReference: input.predictedVehicleReference?.trim() || null,
    predictedVehicleCapacity: positiveInteger(
      input.predictedVehicleCapacity,
      'A capacidade prevista',
    ),
    contractedKm: optionalKm(input.contractedKm, 'O KM contratado'),
    plannedKm: optionalKm(input.plannedKm, 'O KM previsto'),
    maxWalkingDistanceMeters: input.maxWalkingDistanceMeters,
    requiresDocumentation: input.requiresDocumentation,
    requiredDocumentTypeCodes,
    unitName: text(input.unitName, 'a unidade atendida', 160),
    origin: normalizeRouteAddress(input.origin, 'o ponto de saida do contrato'),
    destination: normalizeRouteAddress(
      input.destination,
      'o destino do contrato',
    ),
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    notes: input.notes?.trim() || null,
    costCenters,
    shifts,
  };
}

export function createContract(
  companyId: string,
  actorUserId: string,
  input: ContractData,
): ContractProps {
  const data = normalizeContractData(input);
  const now = new Date();
  return {
    ...data,
    id: randomUUID(),
    companyId,
    version: 1,
    createdByUserId: actorUserId,
    createdAt: now,
    updatedAt: now,
  };
}

export function isContractEffective(
  contract: ContractProps,
  date: Date,
): boolean {
  const day = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  return (
    contract.status === 'active' &&
    day >= contract.validFrom &&
    (contract.validUntil === null || day <= contract.validUntil)
  );
}

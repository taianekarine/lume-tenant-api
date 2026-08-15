import { createHash, randomUUID } from 'node:crypto';

import { validationError } from '../../core/errors/app-error';
import { onlyDigits } from '../../shared/utils/normalization';

export const PASSENGER_STATUSES = [
  'active',
  'on-leave',
  'vacation',
  'temporarily-off-route',
  'unlinked',
] as const;

export type PassengerStatus = (typeof PASSENGER_STATUSES)[number];
export type PassengerRegistrationStatus = 'ready' | 'pending';
export type RoutingDataOrigin =
  'company' | 'agent' | 'operations' | 'import' | 'system';

export interface PassengerDocumentInput {
  documentTypeCode: string;
  data: Readonly<Record<string, unknown>>;
}

export interface PassengerIssueInput {
  field: string;
  code: string;
  reason: string;
  resolutionAction: string;
  blocksRouting: boolean;
}

export interface PassengerData {
  routingCompanyId: string;
  externalReference: string | null;
  fullName: string;
  shift: string | null;
  requiredArrivalTime: string | null;
  sector: string | null;
  accessibilityRequired: boolean;
  accessibilityNotes: string | null;
  residenceStreet: string | null;
  residenceNumber: string | null;
  residenceComplement: string | null;
  residenceDistrict: string | null;
  residencePostalCode: string | null;
  residenceCity: string | null;
  residenceState: string | null;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
  predefinedBoardingLabel: string | null;
  predefinedBoardingStreet: string | null;
  predefinedBoardingNumber: string | null;
  predefinedBoardingComplement: string | null;
  predefinedBoardingDistrict: string | null;
  predefinedBoardingPostalCode: string | null;
  predefinedBoardingCity: string | null;
  predefinedBoardingState: string | null;
  predefinedBoardingLatitude: number | null;
  predefinedBoardingLongitude: number | null;
  predefinedBoardingOrigin: RoutingDataOrigin | null;
  predefinedBoardingFixedPointId: string | null;
}

export interface PassengerProps extends PassengerData {
  id: string;
  companyId: string;
  identityFingerprint: string;
  normalizedName: string;
  status: PassengerStatus;
  registrationStatus: PassengerRegistrationStatus;
  version: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizePassengerName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt-BR');
}

function optionalText(value?: string | null): string | null {
  return value?.trim() || null;
}

function coordinate(value?: number | null): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value))
    throw validationError('Informe coordenadas validas.');
  return value;
}

export function normalizePassengerData(
  input: Omit<
    PassengerData,
    'predefinedBoardingOrigin' | 'predefinedBoardingFixedPointId'
  > & {
    predefinedBoardingOrigin?: RoutingDataOrigin | null;
    predefinedBoardingFixedPointId?: string | null;
  },
): PassengerData {
  const fullName = input.fullName.trim().replace(/\s+/g, ' ');
  if (fullName.length < 2) {
    throw validationError('Informe o nome completo do colaborador.');
  }
  const residencePostalCode = input.residencePostalCode
    ? onlyDigits(input.residencePostalCode)
    : null;
  const predefinedBoardingPostalCode = input.predefinedBoardingPostalCode
    ? onlyDigits(input.predefinedBoardingPostalCode)
    : null;
  const hasPredefinedBoardingPoint = Boolean(
    input.predefinedBoardingLabel ||
    input.predefinedBoardingStreet ||
    input.predefinedBoardingLatitude !== null ||
    input.predefinedBoardingLongitude !== null,
  );
  return {
    routingCompanyId: input.routingCompanyId,
    externalReference: optionalText(input.externalReference),
    fullName,
    shift: optionalText(input.shift),
    requiredArrivalTime: optionalText(input.requiredArrivalTime),
    sector: optionalText(input.sector),
    accessibilityRequired: input.accessibilityRequired,
    accessibilityNotes: optionalText(input.accessibilityNotes),
    residenceStreet: optionalText(input.residenceStreet),
    residenceNumber: optionalText(input.residenceNumber),
    residenceComplement: optionalText(input.residenceComplement),
    residenceDistrict: optionalText(input.residenceDistrict),
    residencePostalCode,
    residenceCity: optionalText(input.residenceCity),
    residenceState: optionalText(input.residenceState)?.toUpperCase() ?? null,
    residenceLatitude: coordinate(input.residenceLatitude),
    residenceLongitude: coordinate(input.residenceLongitude),
    predefinedBoardingLabel: optionalText(input.predefinedBoardingLabel),
    predefinedBoardingStreet: optionalText(input.predefinedBoardingStreet),
    predefinedBoardingNumber: optionalText(input.predefinedBoardingNumber),
    predefinedBoardingComplement: optionalText(
      input.predefinedBoardingComplement,
    ),
    predefinedBoardingDistrict: optionalText(input.predefinedBoardingDistrict),
    predefinedBoardingPostalCode,
    predefinedBoardingCity: optionalText(input.predefinedBoardingCity),
    predefinedBoardingState:
      optionalText(input.predefinedBoardingState)?.toUpperCase() ?? null,
    predefinedBoardingLatitude: coordinate(input.predefinedBoardingLatitude),
    predefinedBoardingLongitude: coordinate(input.predefinedBoardingLongitude),
    predefinedBoardingOrigin: hasPredefinedBoardingPoint
      ? (input.predefinedBoardingOrigin ?? 'company')
      : null,
    predefinedBoardingFixedPointId: hasPredefinedBoardingPoint
      ? (input.predefinedBoardingFixedPointId ?? null)
      : null,
  };
}

export function passengerIdentityFingerprint(data: PassengerData): string {
  const identity = data.externalReference
    ? `external:${data.externalReference.toLocaleLowerCase('pt-BR')}`
    : [
        normalizePassengerName(data.fullName),
        data.residencePostalCode ?? '',
        data.residenceStreet?.toLocaleLowerCase('pt-BR') ?? '',
        data.residenceNumber?.toLocaleLowerCase('pt-BR') ?? '',
      ].join('|');
  return createHash('sha256').update(identity).digest('hex');
}

export function validatePassengerData(
  data: PassengerData,
): PassengerIssueInput[] {
  const issues: PassengerIssueInput[] = [];
  const missing = (field: string, label: string) =>
    issues.push({
      field,
      code: `missing-${field}`,
      reason: `${label} nao informado.`,
      resolutionAction: `Preencha ${label.toLocaleLowerCase('pt-BR')}.`,
      blocksRouting: true,
    });

  if (!data.shift) missing('shift', 'Turno');
  if (!data.requiredArrivalTime) {
    missing('requiredArrivalTime', 'Horario de chegada');
  } else if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.requiredArrivalTime)) {
    issues.push({
      field: 'requiredArrivalTime',
      code: 'invalid-requiredArrivalTime',
      reason: 'Horario de chegada invalido.',
      resolutionAction: 'Use o formato HH:mm.',
      blocksRouting: true,
    });
  }
  if (!data.residenceStreet) missing('residenceStreet', 'Logradouro');
  if (!data.residenceNumber) missing('residenceNumber', 'Numero');
  if (!data.residencePostalCode) {
    missing('residencePostalCode', 'CEP');
  } else if (data.residencePostalCode.length !== 8) {
    issues.push({
      field: 'residencePostalCode',
      code: 'invalid-residencePostalCode',
      reason: 'CEP deve possuir 8 digitos.',
      resolutionAction: 'Corrija o CEP residencial.',
      blocksRouting: true,
    });
  }
  if (!data.residenceCity) missing('residenceCity', 'Cidade');
  if (!data.residenceState) {
    missing('residenceState', 'UF');
  } else if (!/^[A-Z]{2}$/.test(data.residenceState)) {
    issues.push({
      field: 'residenceState',
      code: 'invalid-residenceState',
      reason: 'UF deve possuir duas letras.',
      resolutionAction: 'Corrija a UF residencial.',
      blocksRouting: true,
    });
  }
  return issues;
}

export function createPassenger(
  companyId: string,
  actorUserId: string,
  input: PassengerData,
): PassengerProps {
  const data = normalizePassengerData(input);
  const issues = validatePassengerData(data);
  const now = new Date();
  return {
    ...data,
    id: randomUUID(),
    companyId,
    identityFingerprint: passengerIdentityFingerprint(data),
    normalizedName: normalizePassengerName(data.fullName),
    status: 'active',
    registrationStatus: issues.some((issue) => issue.blocksRouting)
      ? 'pending'
      : 'ready',
    version: 1,
    createdByUserId: actorUserId,
    createdAt: now,
    updatedAt: now,
  };
}

export function isPassengerRoutingEligible(passenger: PassengerProps): boolean {
  return (
    passenger.status === 'active' && passenger.registrationStatus === 'ready'
  );
}

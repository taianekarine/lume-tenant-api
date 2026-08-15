import { randomUUID } from 'node:crypto';

import { validationError } from '../../core/errors/app-error';
import { onlyDigits } from '../../shared/utils/normalization';

export const ROUTE_STATUSES = [
  'draft',
  'routed',
  'in-review',
  'pending-approval',
  'approved',
  'published',
] as const;

export type RouteStatus = (typeof ROUTE_STATUSES)[number];
export type RouteType = 'municipal' | 'intermunicipal';
export type RouteDirection = 'outbound' | 'return';
export type RoutePointOrigin = 'company' | 'agent' | 'operations';
export type RouteAssignmentStatus =
  'assigned' | 'overflow' | 'pending-data' | 'pending-documents';

export interface RouteAddress {
  label: string;
  street: string;
  number: string;
  complement: string | null;
  district: string;
  postalCode: string;
  city: string;
  state: string;
  latitude: number | null;
  longitude: number | null;
}

export interface RouteData {
  routingCompanyId: string;
  contractId: string;
  code: string;
  name: string;
  shift: string;
  requiredArrivalTime: string;
  type: RouteType;
  requiresDocumentation: boolean;
  requiredDocumentTypeCodes: string[];
  origin: RouteAddress;
  destination: RouteAddress;
  predictedVehicleReference: string | null;
  predictedVehicleName: string;
  predictedVehicleCapacity: number;
  maxWalkingDistanceMeters: number;
  validFrom: Date;
  validUntil: Date | null;
  notes: string | null;
}

export interface RouteProps extends RouteData {
  id: string;
  companyId: string;
  status: RouteStatus;
  needsRerouting: boolean;
  version: number;
  planVersion: number;
  approvedVersion: number | null;
  plannedOutboundKm: number | null;
  plannedReturnKm: number | null;
  plannedTotalKm: number | null;
  estimatedDurationMinutes: number | null;
  overflowPassengerCount: number;
  additionalRouteSuggested: boolean;
  createdByUserId: string;
  publishedByUserId: string | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutePoint {
  id: string;
  direction: RouteDirection;
  sequence: number;
  address: RouteAddress;
  origin: RoutePointOrigin;
  scheduledTime: string | null;
  alerts: string[];
}

export interface RoutePassengerAssignment {
  id: string;
  passengerId: string;
  pointId: string | null;
  status: RouteAssignmentStatus;
  walkingDistanceMeters: number | null;
  boardingOrder: number | null;
  origin: RoutePointOrigin;
  warnings: string[];
  passengerName?: string;
  accessibilityRequired?: boolean;
  accessibilityNotes?: string | null;
}

export interface RouteAggregate {
  route: RouteProps;
  points: RoutePoint[];
  assignments: RoutePassengerAssignment[];
  navigationLinks?: RouteNavigationLink[];
}

export interface RouteNavigationLink {
  id?: string;
  routeVersion: number;
  direction: RouteDirection;
  sequence: number;
  label: string;
  url: string;
}

export interface RoutePlan {
  points: RoutePoint[];
  assignments: RoutePassengerAssignment[];
  plannedOutboundKm: number;
  plannedReturnKm: number;
  plannedTotalKm: number;
  estimatedDurationMinutes: number;
  overflowPassengerCount: number;
  additionalRouteSuggested: boolean;
  warnings: string[];
}

function requiredText(value: string, label: string, max: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) throw validationError(`Informe ${label}.`);
  if (normalized.length > max) {
    throw validationError(`${label} deve possuir no maximo ${max} caracteres.`);
  }
  return normalized;
}

function optionalText(value?: string | null): string | null {
  return value?.trim() || null;
}

function coordinate(value?: number | null): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value)) {
    throw validationError('Informe coordenadas validas.');
  }
  return value;
}

export function normalizeRouteAddress(
  input: Partial<RouteAddress>,
  label: string,
): RouteAddress {
  const postalCode = onlyDigits(input.postalCode ?? '');
  if (postalCode.length !== 8) {
    throw validationError(`Informe um CEP valido para ${label}.`);
  }
  const state = requiredText(
    input.state ?? '',
    `a UF de ${label}`,
    2,
  ).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) {
    throw validationError(`Informe uma UF valida para ${label}.`);
  }
  return {
    label: requiredText(input.label ?? '', `o nome de ${label}`, 160),
    street: requiredText(input.street ?? '', `o logradouro de ${label}`, 160),
    number: requiredText(input.number ?? '', `o numero de ${label}`, 30),
    complement: optionalText(input.complement),
    district: requiredText(input.district ?? '', `o bairro de ${label}`, 120),
    postalCode,
    city: requiredText(input.city ?? '', `a cidade de ${label}`, 120),
    state,
    latitude: coordinate(input.latitude),
    longitude: coordinate(input.longitude),
  };
}

export function normalizeRouteData(input: RouteData): RouteData {
  const requiredDocumentTypeCodes = Array.from(
    new Set(
      input.requiredDocumentTypeCodes.map((code) =>
        code.trim().toLocaleLowerCase('pt-BR'),
      ),
    ),
  ).filter(Boolean);
  if (
    requiredDocumentTypeCodes.some(
      (code) => !/^[a-z][a-z0-9-]{2,79}$/.test(code),
    )
  ) {
    throw validationError('Informe codigos documentais validos para a rota.');
  }
  if (input.requiresDocumentation && requiredDocumentTypeCodes.length === 0) {
    throw validationError(
      'Configure os dados documentais exigidos antes de ativar a regra documental.',
    );
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.requiredArrivalTime)) {
    throw validationError('Informe o horario de chegada no formato HH:mm.');
  }
  if (
    !Number.isInteger(input.predictedVehicleCapacity) ||
    input.predictedVehicleCapacity < 1
  ) {
    throw validationError('A capacidade prevista deve ser maior que zero.');
  }
  if (
    !Number.isInteger(input.maxWalkingDistanceMeters) ||
    input.maxWalkingDistanceMeters < 0
  ) {
    throw validationError('A distancia maxima deve ser informada em metros.');
  }
  if (input.validUntil && input.validUntil < input.validFrom) {
    throw validationError('A vigencia final nao pode ser anterior a inicial.');
  }
  return {
    routingCompanyId: input.routingCompanyId,
    contractId: input.contractId,
    code: requiredText(input.code, 'o codigo da rota', 80).toUpperCase(),
    name: requiredText(input.name, 'o nome da rota', 160),
    shift: requiredText(input.shift, 'o turno', 80),
    requiredArrivalTime: input.requiredArrivalTime,
    type: input.type,
    requiresDocumentation: input.requiresDocumentation,
    requiredDocumentTypeCodes,
    origin: normalizeRouteAddress(input.origin, 'o ponto de saida'),
    destination: normalizeRouteAddress(input.destination, 'o destino'),
    predictedVehicleReference: optionalText(input.predictedVehicleReference),
    predictedVehicleName: requiredText(
      input.predictedVehicleName,
      'o veiculo previsto',
      160,
    ),
    predictedVehicleCapacity: input.predictedVehicleCapacity,
    maxWalkingDistanceMeters: input.maxWalkingDistanceMeters,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    notes: optionalText(input.notes),
  };
}

export function createRoute(
  companyId: string,
  actorUserId: string,
  input: RouteData,
): RouteProps {
  const data = normalizeRouteData(input);
  const now = new Date();
  return {
    ...data,
    id: randomUUID(),
    companyId,
    status: 'draft',
    needsRerouting: false,
    version: 1,
    planVersion: 0,
    approvedVersion: null,
    plannedOutboundKm: null,
    plannedReturnKm: null,
    plannedTotalKm: null,
    estimatedDurationMinutes: null,
    overflowPassengerCount: 0,
    additionalRouteSuggested: false,
    createdByUserId: actorUserId,
    publishedByUserId: null,
    publishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

const allowedTransitions: Record<RouteStatus, RouteStatus[]> = {
  draft: ['routed'],
  routed: ['in-review', 'draft'],
  'in-review': ['pending-approval', 'routed'],
  'pending-approval': ['approved', 'in-review'],
  approved: ['published', 'in-review'],
  published: ['in-review'],
};

export function assertRouteTransition(
  from: RouteStatus,
  to: RouteStatus,
): void {
  if (!allowedTransitions[from].includes(to)) {
    throw validationError(`A rota nao pode passar de ${from} para ${to}.`);
  }
}

export function missingRequiredDocuments(
  requiredCodes: readonly string[],
  documents: readonly {
    documentTypeCode: string;
    data: Readonly<Record<string, unknown>>;
  }[],
): string[] {
  const available = new Set(
    documents
      .filter((document) => Object.keys(document.data).length > 0)
      .map((document) => document.documentTypeCode),
  );
  return requiredCodes.filter((code) => !available.has(code));
}

export function routeAddressText(address: RouteAddress): string {
  return [
    `${address.street}, ${address.number}`,
    address.complement,
    address.district,
    `${address.city}/${address.state}`,
    address.postalCode,
  ]
    .filter(Boolean)
    .join(' - ');
}

export function googleMapsLocation(address: RouteAddress): string {
  if (address.latitude !== null && address.longitude !== null) {
    return `${address.latitude},${address.longitude}`;
  }
  return routeAddressText(address);
}

export function buildGoogleMapsLinks(
  routeVersion: number,
  origin: RouteAddress,
  points: RoutePoint[],
  destination: RouteAddress,
): RouteNavigationLink[] {
  const ordered = [...points]
    .filter((point) => point.direction === 'outbound')
    .sort((left, right) => left.sequence - right.sequence);
  const locations = [
    origin,
    ...ordered.map((point) => point.address),
    destination,
  ];
  const chunks: RouteNavigationLink[] = [];
  let startIndex = 0;
  let sequence = 1;
  while (startIndex < locations.length - 1) {
    const segment = locations.slice(startIndex, startIndex + 10);
    const segmentOrigin = googleMapsLocation(segment[0]);
    const segmentDestination = googleMapsLocation(segment[segment.length - 1]);
    const waypoints = segment.slice(1, -1).map(googleMapsLocation);
    const query = new URLSearchParams({
      api: '1',
      origin: segmentOrigin,
      destination: segmentDestination,
      travelmode: 'driving',
    });
    if (waypoints.length > 0) query.set('waypoints', waypoints.join('|'));
    chunks.push({
      routeVersion,
      direction: 'outbound',
      sequence,
      label: `Link Rota ${String(sequence).padStart(2, '0')}`,
      url: `https://www.google.com/maps/dir/?${query.toString()}`,
    });
    startIndex += 9;
    sequence += 1;
  }

  const returnQuery = new URLSearchParams({
    api: '1',
    origin: googleMapsLocation(destination),
    destination: googleMapsLocation(origin),
    travelmode: 'driving',
  });
  const reverseWaypoints = [...ordered]
    .reverse()
    .map((point) => googleMapsLocation(point.address));
  if (reverseWaypoints.length > 0 && reverseWaypoints.length <= 8) {
    returnQuery.set('waypoints', reverseWaypoints.join('|'));
  }
  chunks.push({
    routeVersion,
    direction: 'return',
    sequence: 1,
    label: 'Link de retorno',
    url: `https://www.google.com/maps/dir/?${returnQuery.toString()}`,
  });
  return chunks;
}

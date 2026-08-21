import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { validationError } from '../../core/errors/app-error';
import type { PassengerAggregate } from '../../application/contracts/passenger.repository';
import {
  missingRequiredDocuments,
  type RouteAddress,
  type RoutePlan,
  type RoutePoint,
  type RouteProps,
} from '../../domain/routing/route';
import { isPassengerRoutingEligible } from '../../domain/routing/passenger';

interface Coordinate {
  latitude: number;
  longitude: number;
}

function coordinates(address: RouteAddress): Coordinate | null {
  return address.latitude === null || address.longitude === null
    ? null
    : { latitude: address.latitude, longitude: address.longitude };
}

function distanceMeters(left: Coordinate, right: Coordinate): number {
  const earthRadius = 6_371_000;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = radians(right.latitude - left.latitude);
  const deltaLongitude = radians(right.longitude - left.longitude);
  const latitude1 = radians(left.latitude);
  const latitude2 = radians(right.latitude);
  const value =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(deltaLongitude / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function passengerResidence(aggregate: PassengerAggregate): RouteAddress {
  const passenger = aggregate.passenger;
  return {
    label: `Residencia - ${passenger.fullName}`,
    street: passenger.residenceStreet ?? 'Endereco pendente',
    number: passenger.residenceNumber ?? 'S/N',
    complement: passenger.residenceComplement,
    district: passenger.residenceDistrict ?? 'Bairro pendente',
    postalCode: passenger.residencePostalCode ?? '00000000',
    city: passenger.residenceCity ?? 'Cidade pendente',
    state: passenger.residenceState ?? 'MG',
    latitude: passenger.residenceLatitude,
    longitude: passenger.residenceLongitude,
  };
}

function predefinedPoint(aggregate: PassengerAggregate): RouteAddress | null {
  const passenger = aggregate.passenger;
  if (
    !passenger.predefinedBoardingStreet &&
    !passenger.predefinedBoardingLabel
  ) {
    return null;
  }
  return {
    label:
      passenger.predefinedBoardingLabel ??
      `Ponto informado - ${passenger.fullName}`,
    street: passenger.predefinedBoardingStreet ?? 'Endereco pendente',
    number: passenger.predefinedBoardingNumber ?? 'S/N',
    complement: passenger.predefinedBoardingComplement,
    district: passenger.predefinedBoardingDistrict ?? 'Bairro pendente',
    postalCode: passenger.predefinedBoardingPostalCode ?? '00000000',
    city: passenger.predefinedBoardingCity ?? 'Cidade pendente',
    state: passenger.predefinedBoardingState ?? 'MG',
    latitude: passenger.predefinedBoardingLatitude,
    longitude: passenger.predefinedBoardingLongitude,
  };
}

function pointKey(address: RouteAddress): string {
  return address.latitude !== null && address.longitude !== null
    ? `${address.latitude.toFixed(6)}:${address.longitude.toFixed(6)}`
    : [address.street, address.number, address.district, address.postalCode]
        .join('|')
        .toLocaleLowerCase('pt-BR');
}

function minutes(value: string): number {
  const [hours, minute] = value.split(':').map(Number);
  return hours * 60 + minute;
}

function time(value: number): string {
  const normalized = ((Math.round(value) % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function orderPoints(origin: RouteAddress, points: RoutePoint[]): RoutePoint[] {
  const remaining = [...points];
  const ordered: RoutePoint[] = [];
  let cursor = coordinates(origin);
  while (remaining.length > 0) {
    let selectedIndex = 0;
    if (cursor) {
      let selectedDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = coordinates(remaining[index].address);
        if (!candidate) continue;
        const distance = distanceMeters(cursor, candidate);
        if (distance < selectedDistance) {
          selectedDistance = distance;
          selectedIndex = index;
        }
      }
    }
    const [selected] = remaining.splice(selectedIndex, 1);
    ordered.push(selected);
    cursor = coordinates(selected.address) ?? cursor;
  }
  return ordered.map((point, index) => ({ ...point, sequence: index + 1 }));
}

function routeDistance(
  origin: RouteAddress,
  points: RoutePoint[],
  destination: RouteAddress,
): number {
  const locations = [
    origin,
    ...points.map((point) => point.address),
    destination,
  ];
  let meters = 0;
  for (let index = 1; index < locations.length; index += 1) {
    const previous = coordinates(locations[index - 1]);
    const current = coordinates(locations[index]);
    if (previous && current) meters += distanceMeters(previous, current);
  }
  return Math.round((meters / 1000) * 1000) / 1000;
}

@Injectable()
export class RoutingAgentService {
  summarizeManual(
    route: RouteProps,
    points: RoutePlan['points'],
    assignments: RoutePlan['assignments'],
  ): RoutePlan {
    const ordered = [...points]
      .filter((point) => point.direction === 'outbound')
      .sort((left, right) => left.sequence - right.sequence);
    const outboundKm = routeDistance(route.origin, ordered, route.destination);
    const returnKm = routeDistance(
      route.destination,
      [...ordered].reverse(),
      route.origin,
    );
    const assignedCount = assignments.filter(
      (assignment) => assignment.status === 'assigned',
    ).length;
    if (assignedCount > route.predictedVehicleCapacity) {
      throw validationError(
        `A rota possui ${assignedCount} passageiros para uma capacidade de ${route.predictedVehicleCapacity}.`,
      );
    }
    const overflowPassengerCount = assignments.filter(
      (assignment) => assignment.status === 'overflow',
    ).length;
    return {
      points: ordered,
      assignments,
      plannedOutboundKm: outboundKm,
      plannedReturnKm: returnKm,
      plannedTotalKm: Math.round((outboundKm + returnKm) * 1000) / 1000,
      estimatedDurationMinutes: Math.ceil(
        (outboundKm / 30) * 60 + ordered.length * 3,
      ),
      overflowPassengerCount,
      additionalRouteSuggested: overflowPassengerCount > 0,
      warnings:
        overflowPassengerCount > 0
          ? [`${overflowPassengerCount} passageiro(s) excedente(s).`]
          : [],
    };
  }

  calculate(route: RouteProps, passengers: PassengerAggregate[]): RoutePlan {
    const pointsByKey = new Map<string, RoutePoint>();
    const assignments: RoutePlan['assignments'] = [];
    const warnings: string[] = [];
    let assignedCount = 0;

    const candidates = passengers
      .filter(
        (aggregate) =>
          aggregate.passenger.routingCompanyId === route.routingCompanyId &&
          aggregate.passenger.shift?.toLocaleLowerCase('pt-BR') ===
            route.shift.toLocaleLowerCase('pt-BR'),
      )
      .sort((left, right) =>
        left.passenger.fullName.localeCompare(
          right.passenger.fullName,
          'pt-BR',
        ),
      );

    for (const aggregate of candidates) {
      const passenger = aggregate.passenger;
      const assignmentWarnings: string[] = [];
      if (!isPassengerRoutingEligible(passenger)) {
        assignments.push({
          id: randomUUID(),
          passengerId: passenger.id,
          pointId: null,
          status: 'pending-data',
          walkingDistanceMeters: null,
          boardingOrder: null,
          origin: 'agent',
          warnings: aggregate.issues
            .filter((issue) => issue.status === 'open')
            .map((issue) => issue.reason),
        });
        continue;
      }

      const missingDocuments = route.requiresDocumentation
        ? missingRequiredDocuments(
            route.requiredDocumentTypeCodes,
            aggregate.documents,
          )
        : [];
      if (missingDocuments.length > 0) {
        assignments.push({
          id: randomUUID(),
          passengerId: passenger.id,
          pointId: null,
          status: 'pending-documents',
          walkingDistanceMeters: null,
          boardingOrder: null,
          origin: 'agent',
          warnings: [
            `Dados documentais pendentes: ${missingDocuments.join(', ')}.`,
          ],
        });
        continue;
      }

      if (assignedCount >= route.predictedVehicleCapacity) {
        assignments.push({
          id: randomUUID(),
          passengerId: passenger.id,
          pointId: null,
          status: 'overflow',
          walkingDistanceMeters: null,
          boardingOrder: null,
          origin: 'agent',
          warnings: ['Capacidade do veiculo prevista excedida.'],
        });
        continue;
      }

      const residence = passengerResidence(aggregate);
      const companyPoint = predefinedPoint(aggregate);
      let selectedAddress = companyPoint ?? residence;
      let selectedFixedPointId = companyPoint
        ? passenger.predefinedBoardingFixedPointId
        : null;
      let selectedOrigin: RoutePoint['origin'] = companyPoint
        ? 'company'
        : 'agent';
      let walkingDistance: number | null = null;

      if (companyPoint) {
        const residenceCoordinates = coordinates(residence);
        const pointCoordinates = coordinates(companyPoint);
        if (residenceCoordinates && pointCoordinates) {
          walkingDistance = Math.round(
            distanceMeters(residenceCoordinates, pointCoordinates),
          );
          if (walkingDistance > route.maxWalkingDistanceMeters) {
            assignmentWarnings.push(
              `Ponto informado pela empresa esta a ${walkingDistance} m da residencia, acima do limite de ${route.maxWalkingDistanceMeters} m.`,
            );
          }
        }
      } else if (
        !passenger.accessibilityRequired &&
        route.maxWalkingDistanceMeters > 0
      ) {
        const residenceCoordinates = coordinates(residence);
        if (residenceCoordinates) {
          const shared = [...pointsByKey.values()].find((point) => {
            if (point.origin !== 'agent') return false;
            const pointCoordinates = coordinates(point.address);
            return (
              pointCoordinates !== null &&
              distanceMeters(residenceCoordinates, pointCoordinates) <=
                route.maxWalkingDistanceMeters
            );
          });
          if (shared) {
            selectedAddress = shared.address;
            selectedFixedPointId = shared.fixedPointId ?? null;
            walkingDistance = Math.round(
              distanceMeters(
                residenceCoordinates,
                coordinates(shared.address) as Coordinate,
              ),
            );
          }
        } else {
          assignmentWarnings.push(
            'Coordenadas residenciais ausentes; o ponto foi mantido no endereco informado.',
          );
        }
      } else if (passenger.accessibilityRequired) {
        assignmentWarnings.push(
          'Passageiro com acessibilidade priorizado para embarque na residencia.',
        );
      }

      const key = pointKey(selectedAddress);
      let point = pointsByKey.get(key);
      if (!point) {
        point = {
          id: randomUUID(),
          fixedPointId: selectedFixedPointId,
          direction: 'outbound',
          sequence: pointsByKey.size + 1,
          address: selectedAddress,
          origin: selectedOrigin,
          scheduledTime: null,
          alerts: [],
        };
        pointsByKey.set(key, point);
      } else {
        selectedOrigin = point.origin;
      }
      assignments.push({
        id: randomUUID(),
        passengerId: passenger.id,
        pointId: point.id,
        status: 'assigned',
        walkingDistanceMeters: walkingDistance,
        boardingOrder: assignedCount + 1,
        origin: selectedOrigin,
        warnings: assignmentWarnings,
      });
      assignedCount += 1;
    }

    const ordered = orderPoints(route.origin, [...pointsByKey.values()]);
    const pointSequence = new Map(
      ordered.map((point) => [point.id, point.sequence]),
    );
    assignments.forEach((assignment) => {
      assignment.boardingOrder = assignment.pointId
        ? (pointSequence.get(assignment.pointId) ?? null)
        : null;
    });
    const outboundKm = routeDistance(route.origin, ordered, route.destination);
    const returnKm = routeDistance(
      route.destination,
      [...ordered].reverse(),
      route.origin,
    );
    const estimatedDurationMinutes = Math.ceil(
      (outboundKm / 30) * 60 + ordered.length * 3,
    );
    const departureMinutes =
      minutes(route.requiredArrivalTime) - estimatedDurationMinutes;
    const scheduledPoints = ordered.map((point, index) => ({
      ...point,
      scheduledTime: time(
        departureMinutes +
          ((estimatedDurationMinutes - 3) * (index + 1)) / (ordered.length + 1),
      ),
    }));
    const overflowPassengerCount = assignments.filter(
      (assignment) => assignment.status === 'overflow',
    ).length;
    if (overflowPassengerCount > 0) {
      warnings.push(
        `${overflowPassengerCount} passageiro(s) excedente(s); uma rota adicional deve ser revisada.`,
      );
    }
    return {
      points: scheduledPoints,
      assignments,
      plannedOutboundKm: outboundKm,
      plannedReturnKm: returnKm,
      plannedTotalKm: Math.round((outboundKm + returnKm) * 1000) / 1000,
      estimatedDurationMinutes,
      overflowPassengerCount,
      additionalRouteSuggested: overflowPassengerCount > 0,
      warnings,
    };
  }
}

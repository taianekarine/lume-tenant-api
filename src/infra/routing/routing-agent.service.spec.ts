import { describe, expect, it } from 'vitest';

import type { PassengerAggregate } from '../../application/contracts/passenger.repository';
import { createPassenger } from '../../domain/routing/passenger';
import { createRoute } from '../../domain/routing/route';
import { RoutingAgentService } from './routing-agent.service';

const aggregate = (
  name: string,
  latitude: number,
  options: { predefined?: boolean; accessibility?: boolean } = {},
): PassengerAggregate => {
  const passenger = createPassenger('tenant-id', 'actor-id', {
    routingCompanyId: 'client-id',
    externalReference: name,
    fullName: name,
    shift: 'Turno A',
    requiredArrivalTime: '07:00',
    sector: null,
    accessibilityRequired: options.accessibility ?? false,
    accessibilityNotes: options.accessibility ? 'Embarque proximo' : null,
    residenceStreet: 'Rua A',
    residenceNumber: '10',
    residenceComplement: null,
    residenceDistrict: 'Centro',
    residencePostalCode: '38400000',
    residenceCity: 'Uberlandia',
    residenceState: 'MG',
    residenceLatitude: latitude,
    residenceLongitude: -48.27,
    predefinedBoardingLabel: options.predefined ? 'Ponto da empresa' : null,
    predefinedBoardingStreet: options.predefined ? 'Rua B' : null,
    predefinedBoardingNumber: options.predefined ? '20' : null,
    predefinedBoardingComplement: null,
    predefinedBoardingDistrict: options.predefined ? 'Outro bairro' : null,
    predefinedBoardingPostalCode: options.predefined ? '38400001' : null,
    predefinedBoardingCity: options.predefined ? 'Uberlandia' : null,
    predefinedBoardingState: options.predefined ? 'MG' : null,
    predefinedBoardingLatitude: options.predefined ? latitude + 0.02 : null,
    predefinedBoardingLongitude: options.predefined ? -48.27 : null,
    predefinedBoardingOrigin: options.predefined ? 'company' : null,
  });
  return { passenger, documents: [], issues: [] };
};

describe('RoutingAgentService', () => {
  it('preserves company points, prioritizes accessibility and signals overflow', () => {
    const route = createRoute('tenant-id', 'actor-id', {
      routingCompanyId: 'client-id',
      contractId: 'contract-id',
      code: 'CTR-01-A',
      name: 'Rota A',
      shift: 'Turno A',
      requiredArrivalTime: '07:00',
      type: 'municipal',
      requiresDocumentation: false,
      requiredDocumentTypeCodes: [],
      origin: {
        label: 'Garagem',
        street: 'Rua G',
        number: '1',
        complement: null,
        district: 'Centro',
        postalCode: '38400000',
        city: 'Uberlandia',
        state: 'MG',
        latitude: -18.92,
        longitude: -48.28,
      },
      destination: {
        label: 'Empresa',
        street: 'Rua E',
        number: '2',
        complement: null,
        district: 'Industrial',
        postalCode: '38400002',
        city: 'Uberlandia',
        state: 'MG',
        latitude: -18.88,
        longitude: -48.25,
      },
      predictedVehicleReference: null,
      predictedVehicleName: 'Van',
      predictedVehicleCapacity: 2,
      maxWalkingDistanceMeters: 500,
      validFrom: new Date('2026-08-14T00:00:00Z'),
      validUntil: new Date('2026-08-14T00:00:00Z'),
      notes: null,
    });
    const plan = new RoutingAgentService().calculate(route, [
      aggregate('Ana', -18.91, { predefined: true }),
      aggregate('Bruno', -18.905, { accessibility: true }),
      aggregate('Carla', -18.9),
    ]);

    expect(plan.assignments).toHaveLength(3);
    expect(
      plan.assignments.find(
        (item) => item.passengerId === plan.assignments[0].passengerId,
      )?.origin,
    ).toBe('company');
    expect(plan.assignments[0].warnings.join(' ')).toMatch(/acima do limite/i);
    expect(plan.assignments[1].warnings.join(' ')).toMatch(/acessibilidade/i);
    expect(plan.assignments[2].status).toBe('overflow');
    expect(plan.additionalRouteSuggested).toBe(true);
    expect(plan.plannedTotalKm).toBeGreaterThan(0);
  });
});

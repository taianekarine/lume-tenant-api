import { describe, expect, it } from 'vitest';

import { createContract, isContractEffective } from './contract';

const address = {
  label: 'Garagem',
  street: 'Rua A',
  number: '10',
  complement: null,
  district: 'Centro',
  postalCode: '38400000',
  city: 'Uberlandia',
  state: 'MG',
  latitude: -18.91,
  longitude: -48.27,
};

describe('routing contract domain', () => {
  it('normalizes the commercial rules that drive route generation', () => {
    const contract = createContract('tenant-id', 'actor-id', {
      routingCompanyId: 'client-id',
      code: ' ctr-01 ',
      name: 'Contrato Industrial',
      operationType: 'Fretamento continuo',
      routeType: 'intermunicipal',
      status: 'active',
      periodicity: 'monthly',
      contractedVehicleCount: 2,
      predictedVehicleName: 'Micro-onibus',
      predictedVehicleReference: 'AVIC-10',
      predictedVehicleCapacity: 28,
      contractedKm: 1200.5554,
      plannedKm: 1150,
      maxWalkingDistanceMeters: 500,
      requiresDocumentation: true,
      requiredDocumentTypeCodes: ['atf-data', 'atf-data'],
      unitName: 'Unidade Norte',
      origin: address,
      destination: { ...address, label: 'Unidade Norte', number: '200' },
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
      validUntil: new Date('2026-12-31T00:00:00.000Z'),
      notes: null,
      costCenters: [{ code: ' cc-10 ', name: 'Operacao Norte' }],
      shifts: [
        {
          name: 'Primeiro turno',
          requiredArrivalTime: '07:00',
          vehicleCount: null,
          vehicleCapacity: null,
          activeWeekdays: [5, 1, 1, 3],
        },
      ],
    });

    expect(contract.code).toBe('CTR-01');
    expect(contract.costCenters[0].code).toBe('CC-10');
    expect(contract.shifts[0].activeWeekdays).toEqual([1, 3, 5]);
    expect(contract.requiredDocumentTypeCodes).toEqual(['atf-data']);
    expect(contract.contractedKm).toBe(1200.555);
    expect(
      isContractEffective(contract, new Date('2026-08-14T12:00:00Z')),
    ).toBe(true);
  });

  it('requires configured document types when the contract enables documentation', () => {
    expect(() =>
      createContract('tenant-id', 'actor-id', {
        routingCompanyId: 'client-id',
        code: 'CTR-02',
        name: 'Contrato',
        operationType: 'Fretamento',
        routeType: 'intermunicipal',
        status: 'active',
        periodicity: 'daily',
        contractedVehicleCount: 1,
        predictedVehicleName: 'Van',
        predictedVehicleReference: null,
        predictedVehicleCapacity: 15,
        contractedKm: null,
        plannedKm: null,
        maxWalkingDistanceMeters: 0,
        requiresDocumentation: true,
        requiredDocumentTypeCodes: [],
        unitName: 'Unidade',
        origin: address,
        destination: address,
        validFrom: new Date('2026-08-01T00:00:00Z'),
        validUntil: null,
        notes: null,
        costCenters: [{ code: 'CC', name: null }],
        shifts: [
          {
            name: 'Turno',
            requiredArrivalTime: '08:00',
            vehicleCount: null,
            vehicleCapacity: null,
            activeWeekdays: [],
          },
        ],
      }),
    ).toThrow(/documentais/i);
  });
});

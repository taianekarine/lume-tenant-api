import { describe, expect, it } from 'vitest';

import { createRoutingFixedPoint } from './fixed-point';

describe('createRoutingFixedPoint', () => {
  it('generates a public code and accepts an address without a number', () => {
    const point = createRoutingFixedPoint({
      companyId: 'tenant-1',
      routingCompanyId: 'client-1',
      name: '  Portaria principal  ',
      actorUserId: 'user-1',
      address: {
        street: 'Rodovia Municipal',
        number: 'S/N',
        complement: null,
        district: 'Zona Rural',
        postalCode: '38400000',
        city: 'Uberlandia',
        state: 'MG',
        latitude: null,
        longitude: null,
      },
    });

    expect(point.code).toMatch(/^PF-[A-F0-9]{8}$/);
    expect(point.name).toBe('Portaria principal');
    expect(point.address.number).toBe('S/N');
    expect(point.routingCompanyId).toBe('client-1');
  });
});

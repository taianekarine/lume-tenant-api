import { describe, expect, it } from 'vitest';

import { contractNestedCreates } from './prisma-contract.repository';

describe('contractNestedCreates', () => {
  it('lets Prisma derive companyId and contractId from the parent relation', () => {
    const nested = contractNestedCreates({
      costCenters: [{ code: 'CENTRO001', name: 'Operação' }],
      shifts: [
        {
          name: 'MANHÃ',
          requiredArrivalTime: '07:50',
          vehicleCount: 2,
          vehicleCapacity: 25,
          activeWeekdays: [1, 2, 3, 4, 5],
        },
      ],
    });

    expect(nested.costCenters.create[0]).toEqual({
      code: 'CENTRO001',
      name: 'Operação',
    });
    expect(nested.shifts.create[0]).toEqual({
      name: 'MANHÃ',
      requiredArrivalTime: '07:50',
      vehicleCount: 2,
      vehicleCapacity: 25,
      activeWeekdays: [1, 2, 3, 4, 5],
    });
    expect(nested.costCenters.create[0]).not.toHaveProperty('companyId');
    expect(nested.shifts.create[0]).not.toHaveProperty('companyId');
  });
});

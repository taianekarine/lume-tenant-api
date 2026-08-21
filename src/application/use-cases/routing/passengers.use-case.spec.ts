import { describe, expect, it } from 'vitest';

import {
  normalizePassengerData,
  validatePassengerData,
} from '../../../domain/routing/passenger';
import { mergePassengerData } from './passengers.use-case';

describe('mergePassengerData', () => {
  it('completes imported passenger data while preserving the fixed boarding point', () => {
    const previous = normalizePassengerData({
      routingCompanyId: 'client-id',
      externalReference: 'BOOK14-0056',
      fullName: 'Pessoa importada',
      shift: null,
      requiredArrivalTime: null,
      sector: 'T01',
      accessibilityRequired: false,
      accessibilityNotes: null,
      residenceStreet: 'Rua A',
      residenceNumber: '10',
      residenceComplement: null,
      residenceDistrict: 'Centro',
      residencePostalCode: '38400000',
      residenceCity: 'Uberlandia',
      residenceState: 'MG',
      residenceLatitude: null,
      residenceLongitude: null,
      predefinedBoardingLabel: 'Ponto 1',
      predefinedBoardingStreet: 'Rua B',
      predefinedBoardingNumber: '20',
      predefinedBoardingComplement: null,
      predefinedBoardingDistrict: 'Centro',
      predefinedBoardingPostalCode: '38400001',
      predefinedBoardingCity: 'Uberlandia',
      predefinedBoardingState: 'MG',
      predefinedBoardingLatitude: null,
      predefinedBoardingLongitude: null,
      predefinedBoardingOrigin: 'company',
      predefinedBoardingFixedPointId: 'fixed-point-id',
    });

    const updated = mergePassengerData(previous, {
      shift: 'MANHA',
      requiredArrivalTime: '07:50',
    });

    expect(updated.shift).toBe('MANHA');
    expect(updated.requiredArrivalTime).toBe('07:50');
    expect(updated.predefinedBoardingFixedPointId).toBe('fixed-point-id');
    expect(validatePassengerData(updated)).toEqual([]);
  });
});

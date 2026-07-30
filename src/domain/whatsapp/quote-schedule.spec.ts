import { describe, expect, it } from 'vitest';

import { AppError } from '../../core/errors/app-error';
import {
  assertQuoteScheduleConsistency,
  dateOnlyFromDateTime,
  parseDateOnly,
  presentDateOnly,
} from './quote-schedule';

describe('quote schedule', () => {
  it('preserva uma data civil sem inventar horário', () => {
    const date = parseDateOnly('2026-08-31', 'departureDate');
    expect(presentDateOnly(date)).toBe('2026-08-31');
    expect(
      presentDateOnly(
        dateOnlyFromDateTime(new Date('2026-08-31T18:45:00.000Z')),
      ),
    ).toBe('2026-08-31');
  });

  it('rejeita datas civis inexistentes', () => {
    expect(() => parseDateOnly('2026-02-31', 'departureDate')).toThrowError(
      expect.objectContaining<AppError>({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('deriva a data civil no fuso operacional sem avançar o dia por UTC', () => {
    expect(
      presentDateOnly(
        dateOnlyFromDateTime(new Date('2026-08-01T23:30:00-03:00')),
      ),
    ).toBe('2026-08-01');
  });

  it('aceita data de saída sem horário', () => {
    expect(() =>
      assertQuoteScheduleConsistency(
        {
          departureDate: parseDateOnly('2026-08-01', 'departureDate'),
          departureAt: null,
          returnDate: null,
          returnAt: null,
        },
        { requireDepartureDate: true },
      ),
    ).not.toThrow();
  });

  it('rejeita confirmação sem data de saída', () => {
    expect(() =>
      assertQuoteScheduleConsistency(
        {
          departureDate: null,
          departureAt: null,
          returnDate: null,
          returnAt: null,
        },
        { requireDepartureDate: true },
      ),
    ).toThrowError(
      expect.objectContaining<AppError>({ code: 'VALIDATION_ERROR' }),
    );
  });

  it('rejeita data civil divergente do horário e retorno anterior', () => {
    expect(() =>
      assertQuoteScheduleConsistency({
        departureDate: parseDateOnly('2026-08-02', 'departureDate'),
        departureAt: new Date('2026-08-01T15:00:00-03:00'),
        returnDate: null,
        returnAt: null,
      }),
    ).toThrowError(
      expect.objectContaining<AppError>({ code: 'VALIDATION_ERROR' }),
    );

    expect(() =>
      assertQuoteScheduleConsistency({
        departureDate: parseDateOnly('2026-08-02', 'departureDate'),
        departureAt: null,
        returnDate: parseDateOnly('2026-08-01', 'returnDate'),
        returnAt: null,
      }),
    ).toThrowError(
      expect.objectContaining<AppError>({ code: 'VALIDATION_ERROR' }),
    );
  });
});

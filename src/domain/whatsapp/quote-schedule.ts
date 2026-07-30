import { validationError } from '../../core/errors/app-error';

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const BUSINESS_TIME_ZONE = 'America/Sao_Paulo';
const BUSINESS_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: BUSINESS_TIME_ZONE,
});

export function parseDateOnly(value: string, fieldName: string): Date {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    throw validationError(`${fieldName} deve usar o formato AAAA-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw validationError(`${fieldName} não contém uma data válida.`);
  }
  return date;
}

export function dateOnlyFromDateTime(value: Date): Date {
  const parts = BUSINESS_DATE_FORMATTER.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return parseDateOnly(
    `${part('year')}-${part('month')}-${part('day')}`,
    'dateTime',
  );
}

export function presentDateOnly(value: Date | null): string | null {
  return value?.toISOString().slice(0, 10) ?? null;
}

export interface QuoteSchedule {
  departureDate: Date | null;
  departureAt: Date | null;
  returnDate: Date | null;
  returnAt: Date | null;
}

export function assertQuoteScheduleConsistency(
  schedule: QuoteSchedule,
  options: { requireDepartureDate?: boolean } = {},
): void {
  const departureDate = presentDateOnly(schedule.departureDate);
  const returnDate = presentDateOnly(schedule.returnDate);

  if (options.requireDepartureDate && !departureDate) {
    throw validationError(
      'A data de saída é obrigatória; o horário é opcional.',
    );
  }
  if (schedule.departureAt && !departureDate) {
    throw validationError(
      'departureAt não pode ser informado sem a data civil departureDate.',
    );
  }
  if (schedule.returnAt && !returnDate) {
    throw validationError(
      'returnAt não pode ser informado sem a data civil returnDate.',
    );
  }
  if (
    schedule.departureAt &&
    departureDate !==
      presentDateOnly(dateOnlyFromDateTime(schedule.departureAt))
  ) {
    throw validationError(
      'departureDate e departureAt devem representar o mesmo dia em America/Sao_Paulo.',
    );
  }
  if (
    schedule.returnAt &&
    returnDate !== presentDateOnly(dateOnlyFromDateTime(schedule.returnAt))
  ) {
    throw validationError(
      'returnDate e returnAt devem representar o mesmo dia em America/Sao_Paulo.',
    );
  }
  if (departureDate && returnDate && returnDate < departureDate) {
    throw validationError(
      'A data de retorno não pode ser anterior à data de saída.',
    );
  }
  if (
    schedule.departureAt &&
    schedule.returnAt &&
    schedule.returnAt < schedule.departureAt
  ) {
    throw validationError(
      'A data e o horário de retorno não podem ser anteriores à saída.',
    );
  }
}

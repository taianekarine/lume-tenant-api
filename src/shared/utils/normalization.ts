export function onlyDigits(value: string): string {
  return value.replace(/\D/g, '');
}

export function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase('pt-BR');
}

export function normalizeUsername(value: string): string {
  return value.trim().toLocaleLowerCase('pt-BR');
}

export function normalizeCpf(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  return onlyDigits(value);
}

export function normalizeTaxId(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function normalizeLoginIdentifier(value: string): string {
  const trimmed = value.trim();

  if (trimmed.includes('@')) {
    return normalizeEmail(trimmed);
  }

  const digits = onlyDigits(trimmed);

  if (digits.length === 11 || digits.length === 14) {
    return digits;
  }

  return normalizeUsername(trimmed);
}

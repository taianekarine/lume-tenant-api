const PHONE_PATTERN = /(?<!\d)\+?\d{10,15}(?!\d)/g;
const CPF_PATTERN = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-4)}`;
}

export function maskCpf(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 11) return '***';
  return `***.***.***-${digits.slice(-2)}`;
}

export function maskToken(value: string): string {
  if (value.length < 8) return '***';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function sanitizeLogText(value: string, maximumLength = 500): string {
  return value
    .replace(BEARER_PATTERN, 'Bearer ***')
    .replace(CPF_PATTERN, (match) => maskCpf(match))
    .replace(PHONE_PATTERN, (match) => maskPhone(match))
    .slice(0, maximumLength);
}

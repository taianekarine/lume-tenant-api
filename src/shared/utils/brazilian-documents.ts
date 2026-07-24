import { normalizeTaxId, onlyDigits } from './normalization';

function hasRepeatedDigits(value: string): boolean {
  return /^(\d)\1+$/.test(value);
}

export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);

  if (cpf.length !== 11 || hasRepeatedDigits(cpf)) {
    return false;
  }

  const calculateDigit = (length: number): number => {
    let sum = 0;

    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }

    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return (
    calculateDigit(9) === Number(cpf[9]) &&
    calculateDigit(10) === Number(cpf[10])
  );
}

export function isValidCnpj(value: string): boolean {
  const cnpj = normalizeTaxId(value);

  if (!/^[A-Z0-9]{12}\d{2}$/.test(cnpj) || /^(.)\1{13}$/.test(cnpj)) {
    return false;
  }

  const calculateDigit = (characters: string, weights: number[]): number => {
    const sum = weights.reduce((total, weight, index) => {
      return total + (characters.charCodeAt(index) - 48) * weight;
    }, 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };

  const base = cnpj.slice(0, 12);
  const firstDigit = calculateDigit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const secondDigit = calculateDigit(
    `${base}${firstDigit}`,
    [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );

  return cnpj.slice(-2) === `${firstDigit}${secondDigit}`;
}

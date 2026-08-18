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

export function normalizeWhatsAppPhone(value: string): string {
  const localPart = (value.split('@')[0] ?? '').split(':')[0] ?? '';
  let digits = onlyDigits(localPart);

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  // Um número brasileiro local pode começar pelo DDD 55. Só tratamos os
  // primeiros dígitos como código do país quando o comprimento também é
  // compatível com +55 + DDD + telefone.
  const hasBrazilianCountryCode =
    digits.startsWith('55') && digits.length >= 12;
  const brazilianDigits = hasBrazilianCountryCode ? digits.slice(2) : digits;
  if (brazilianDigits.length === 10 || brazilianDigits.length === 11) {
    const areaCode = brazilianDigits.slice(0, 2);
    let subscriber = brazilianDigits.slice(2);

    // Celulares brasileiros antigos com oito dígitos passam a compartilhar a
    // mesma chave dos números atuais. Telefones fixos (prefixos 2 a 5) não
    // recebem o nono dígito porque isso alteraria o número real.
    if (subscriber.length === 8 && /^[6-9]/.test(subscriber)) {
      subscriber = `9${subscriber}`;
    }

    digits = `55${areaCode}${subscriber}`;
  }
  if (digits.length < 12 || digits.length > 15) {
    throw new Error('Telefone WhatsApp fora do padrão E.164.');
  }

  return digits;
}

export function formatWhatsAppPhone(value: string): string {
  const normalized = normalizeWhatsAppPhone(value);
  if (!normalized.startsWith('55')) return `+${normalized}`;

  const local = normalized.slice(2);
  if (local.length === 11) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  }
  if (local.length === 10) {
    return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  }

  return `+${normalized}`;
}

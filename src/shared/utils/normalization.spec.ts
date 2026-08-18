import { describe, expect, it } from 'vitest';

import { formatWhatsAppPhone, normalizeWhatsAppPhone } from './normalization';

describe('normalização de telefones do WhatsApp', () => {
  it.each([
    ['(34) 98868-7758', '5534988687758'],
    ['(34) 9 8868-7758', '5534988687758'],
    ['+55 34 98868-7758', '5534988687758'],
    ['5534988687758@s.whatsapp.net', '5534988687758'],
  ])('identifica %s como %s', (input, expected) => {
    expect(normalizeWhatsAppPhone(input)).toBe(expected);
  });

  it('preserva telefone fixo brasileiro com oito dígitos', () => {
    expect(normalizeWhatsAppPhone('(34) 3223-6060')).toBe('553432236060');
    expect(formatWhatsAppPhone('553432236060')).toBe('(34) 3223-6060');
  });

  it('apresenta celular no formato brasileiro atual', () => {
    expect(formatWhatsAppPhone('34988687758')).toBe('(34) 98868-7758');
  });

  it('não confunde o DDD 55 com o código do país', () => {
    expect(normalizeWhatsAppPhone('(55) 99999-1234')).toBe('5555999991234');
    expect(formatWhatsAppPhone('(55) 99999-1234')).toBe('(55) 99999-1234');
  });

  it('rejeita telefone sem DDD', () => {
    expect(() => normalizeWhatsAppPhone('9254')).toThrow(
      'Telefone WhatsApp fora do padrão E.164.',
    );
  });
});

import { describe, expect, it } from 'vitest';

import { createRoutingCompany } from './routing-company';

describe('createRoutingCompany', () => {
  it.each([
    ['CPF', '529.982.247-25', '52998224725'],
    ['CNPJ', '11.222.333/0001-81', '11222333000181'],
  ])('accepts a valid %s as the client document', (_, input, expected) => {
    const client = createRoutingCompany({
      companyId: 'tenant-1',
      taxId: input,
      legalName: 'Cliente de teste',
    });

    expect(client.taxId).toBe(expected);
    expect(client.status).toBe('active');
  });

  it('rejects an invalid CPF or CNPJ', () => {
    expect(() =>
      createRoutingCompany({
        companyId: 'tenant-1',
        taxId: '111.111.111-11',
        legalName: 'Cliente de teste',
      }),
    ).toThrow('Informe um CPF ou CNPJ valido para o cliente.');
  });
});

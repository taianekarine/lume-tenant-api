import { describe, expect, it } from 'vitest';

import { createRoutingCompany } from './routing-company';

describe('createRoutingCompany', () => {
  it('accepts a valid CPF as the individual client document', () => {
    const client = createRoutingCompany({
      companyId: 'tenant-1',
      clientType: 'pf',
      cpf: '529.982.247-25',
      individualName: 'Cliente de teste',
      individualWhatsapp: '(34) 99999-0000',
    });

    expect(client.cpf).toBe('52998224725');
    expect(client.taxId).toBe('52998224725');
    expect(client.status).toBe('active');
  });

  it('accepts a valid CNPJ as the corporate client document', () => {
    const client = createRoutingCompany({
      companyId: 'tenant-1',
      clientType: 'pj',
      cnpj: '11.222.333/0001-81',
      legalName: 'Cliente de teste',
    });

    expect(client.cnpj).toBe('11222333000181');
    expect(client.taxId).toBe('11222333000181');
    expect(client.status).toBe('active');
  });

  it('rejects an invalid CPF or CNPJ', () => {
    expect(() =>
      createRoutingCompany({
        companyId: 'tenant-1',
        clientType: 'pf',
        cpf: '111.111.111-11',
        individualWhatsapp: '(34) 99999-0000',
      }),
    ).toThrow('CPF inválido.');
  });

  it('preserves inactive corporate fields without validating them for an individual client', () => {
    const client = createRoutingCompany({
      companyId: 'tenant-1',
      clientType: 'pf',
      individualWhatsapp: '(34) 99999-0000',
      cnpj: '12.345',
      legalEmail: 'cadastro incompleto',
      legalWhatsapp: '123',
      legalPhones: [{ number: '456', description: 'Rascunho' }],
    });

    expect(client.cnpj).toBe('12345');
    expect(client.legalEmail).toBe('cadastro incompleto');
    expect(client.legalWhatsapp).toBe('55123');
    expect(client.legalPhones).toEqual([
      { number: '55456', description: 'Rascunho' },
    ]);
  });

  it('preserves inactive individual fields without validating them for a corporate client', () => {
    const client = createRoutingCompany({
      companyId: 'tenant-1',
      clientType: 'pj',
      legalName: 'Cliente de teste',
      cnpj: '11.222.333/0001-81',
      cpf: '123',
      individualEmail: 'cadastro incompleto',
      individualWhatsapp: '123',
      individualPhones: [{ number: '456', description: 'Rascunho' }],
    });

    expect(client.cpf).toBe('123');
    expect(client.individualEmail).toBe('cadastro incompleto');
    expect(client.individualWhatsapp).toBe('55123');
    expect(client.individualPhones).toEqual([
      { number: '55456', description: 'Rascunho' },
    ]);
  });
});

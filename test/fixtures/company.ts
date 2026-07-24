import type { BootstrapTenantInput } from '../../src/application/use-cases/tenant/bootstrap-tenant.use-case';

export const companyFixture: BootstrapTenantInput = {
  legalName: 'Empresa Exemplo Ltda.',
  tradeName: 'Empresa Exemplo',
  taxId: '04.252.011/0001-10',
  administrator: {
    name: 'Ana Souza',
    username: 'ana.souza',
    email: 'ana@empresa.test',
    cpf: '529.982.247-25',
    password: 'SenhaForte@2026',
  },
};

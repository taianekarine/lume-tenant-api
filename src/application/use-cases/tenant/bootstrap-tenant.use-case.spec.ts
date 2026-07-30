import { describe, expect, it } from 'vitest';

import { companyFixture } from '../../../../test/fixtures/company';
import {
  FakeOfflineLicenseVerifier,
  FakePasswordHasher,
  InMemoryStore,
  InMemoryTenantBootstrapRepository,
} from '../../../../test/fakes/in-memory';
import {
  ASSIGNABLE_DEPARTMENTS,
  ASSIGNABLE_DEPARTMENT_LABELS,
} from '../../../domain/access/access.constants';
import { BootstrapTenantUseCase } from './bootstrap-tenant.use-case';

describe('BootstrapTenantUseCase', () => {
  it('publishes only the nine assignable departments with PT-BR labels', () => {
    expect(ASSIGNABLE_DEPARTMENTS).toEqual([
      'commercial',
      'purchasing',
      'controllership',
      'personnel-department',
      'financial',
      'management',
      'maintenance',
      'monitoring',
      'operations',
    ]);
    expect(
      ASSIGNABLE_DEPARTMENTS.map(
        (department) => ASSIGNABLE_DEPARTMENT_LABELS[department],
      ),
    ).toEqual([
      'Comercial',
      'Compras',
      'Controladoria',
      'Departamento Pessoal',
      'Financeiro',
      'Gerência',
      'Manutenção',
      'Monitoramento',
      'Operacional',
    ]);
  });

  it('uses the tenant id signed by the control plane', async () => {
    const store = new InMemoryStore();
    const license = new FakeOfflineLicenseVerifier();
    const result = await new BootstrapTenantUseCase(
      new InMemoryTenantBootstrapRepository(store),
      new FakePasswordHasher(),
      license,
    ).execute(companyFixture);

    expect(result.tenant.id).toBe(license.status().payload.tenantId);
    expect(store.tenantDepartments).toHaveLength(9);
    expect(
      store.tenantDepartments.map((department) => department.name),
    ).toEqual([
      'Comercial',
      'Compras',
      'Controladoria',
      'Departamento Pessoal',
      'Financeiro',
      'Gerência',
      'Manutenção',
      'Monitoramento',
      'Operacional',
    ]);
    expect(
      store.tenantDepartments.find((department) => department.isDefault)?.code,
    ).toBe('commercial');
    expect(store.users).toHaveLength(1);
    expect(store.users[0].props).toMatchObject({
      isAdministrator: true,
      mustChangePassword: true,
      departments: [],
      permissionCodes: [],
    });
  });

  it('refuses a second tenant in the same installation', async () => {
    const store = new InMemoryStore();
    const useCase = new BootstrapTenantUseCase(
      new InMemoryTenantBootstrapRepository(store),
      new FakePasswordHasher(),
      new FakeOfflineLicenseVerifier(),
    );
    await useCase.execute(companyFixture);
    await expect(useCase.execute(companyFixture)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

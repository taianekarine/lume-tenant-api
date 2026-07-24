import { describe, expect, it } from 'vitest';

import { companyFixture } from '../../../../test/fixtures/company';
import {
  FakeOfflineLicenseVerifier,
  FakePasswordHasher,
  InMemoryStore,
  InMemoryTenantBootstrapRepository,
} from '../../../../test/fakes/in-memory';
import { BootstrapTenantUseCase } from './bootstrap-tenant.use-case';

describe('BootstrapTenantUseCase', () => {
  it('uses the tenant id signed by the control plane', async () => {
    const store = new InMemoryStore();
    const license = new FakeOfflineLicenseVerifier();
    const result = await new BootstrapTenantUseCase(
      new InMemoryTenantBootstrapRepository(store),
      new FakePasswordHasher(),
      license,
    ).execute(companyFixture);

    expect(result.tenant.id).toBe(license.status().payload.tenantId);
    expect(store.users).toHaveLength(1);
    expect(store.roles.map((role) => role.code)).toEqual([
      'administrator',
      'director',
      'manager',
      'driver',
    ]);
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

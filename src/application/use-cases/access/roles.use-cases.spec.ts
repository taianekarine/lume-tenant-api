import { beforeEach, describe, expect, it } from 'vitest';

import {
  FakePasswordHasher,
  FakeOfflineLicenseVerifier,
  InMemoryRolesRepository,
  InMemoryStore,
  InMemoryTenantBootstrapRepository,
} from '../../../../test/fakes/in-memory';
import { companyFixture } from '../../../../test/fixtures/company';
import { BootstrapTenantUseCase } from '../tenant/bootstrap-tenant.use-case';
import {
  CreateRoleUseCase,
  DeleteRoleUseCase,
  ListPermissionsUseCase,
  ListRolesUseCase,
  UpdateRoleUseCase,
} from './roles.use-cases';

describe('role and permission use cases', () => {
  let store: InMemoryStore;
  let roles: InMemoryRolesRepository;
  let companyId: string;

  beforeEach(async () => {
    store = new InMemoryStore();
    roles = new InMemoryRolesRepository(store);
    await new BootstrapTenantUseCase(
      new InMemoryTenantBootstrapRepository(store),
      new FakePasswordHasher(),
      new FakeOfflineLicenseVerifier(),
    ).execute(companyFixture);
    companyId = store.companies[0].id;
  });

  it('creates, updates, lists and deletes a custom role', async () => {
    const created = await new CreateRoleUseCase(roles).execute({
      companyId,
      code: 'operations-supervisor',
      name: 'Supervisor de Operações',
      permissions: ['dashboard:view', 'operations:manage'],
    });
    const updated = await new UpdateRoleUseCase(roles).execute({
      companyId,
      roleId: created.id,
      name: 'Supervisão de Operações',
      permissions: ['dashboard:view', 'operations:view'],
    });

    expect(updated.name).toBe('Supervisão de Operações');
    expect(updated.permissions).toEqual(['dashboard:view', 'operations:view']);
    expect(await new ListRolesUseCase(roles).execute(companyId)).toHaveLength(
      5,
    );

    await new DeleteRoleUseCase(roles).execute(companyId, created.id);
    expect(await new ListRolesUseCase(roles).execute(companyId)).toHaveLength(
      4,
    );
  });

  it('rejects permissions that are structurally valid but not meaningful for the resource', async () => {
    await expect(
      new CreateRoleUseCase(roles).execute({
        companyId,
        code: 'invalid-dashboard-role',
        name: 'Papel Inválido',
        permissions: ['dashboard:delete'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('protects system roles from mutation', async () => {
    const administrator = store.roles.find(
      (role) => role.code === 'administrator',
    )!;

    await expect(
      new UpdateRoleUseCase(roles).execute({
        companyId,
        roleId: administrator.id,
        name: 'Outro nome',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      new DeleteRoleUseCase(roles).execute(companyId, administrator.id),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('publishes a curated catalog compatible with resource-action permissions', () => {
    const catalog = new ListPermissionsUseCase().execute();

    expect(catalog.permissions).toContain('dashboard:view');
    expect(catalog.permissions).toContain('users:manage');
    expect(catalog.permissions).not.toContain('dashboard:delete');
    expect(catalog.actionsByResource.dashboard).toEqual(['view']);
  });
});

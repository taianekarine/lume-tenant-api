import { beforeEach, describe, expect, it } from 'vitest';

import { Role } from '../../../domain/entities/role';
import { BootstrapTenantUseCase } from '../tenant/bootstrap-tenant.use-case';
import { companyFixture } from '../../../../test/fixtures/company';
import {
  FakePasswordHasher,
  FakeOfflineLicenseVerifier,
  InMemoryRolesRepository,
  InMemoryStore,
  InMemoryTenantBootstrapRepository,
  InMemoryUsersRepository,
} from '../../../../test/fakes/in-memory';
import { CreateUserUseCase } from './create-user.use-case';
import { GetUserUseCase } from './get-user.use-case';

describe('tenant-scoped user use cases', () => {
  let store: InMemoryStore;
  let users: InMemoryUsersRepository;
  let roles: InMemoryRolesRepository;
  let createUser: CreateUserUseCase;

  beforeEach(async () => {
    store = new InMemoryStore();
    users = new InMemoryUsersRepository(store);
    roles = new InMemoryRolesRepository(store);
    const passwordHasher = new FakePasswordHasher();
    await new BootstrapTenantUseCase(
      new InMemoryTenantBootstrapRepository(store),
      passwordHasher,
      new FakeOfflineLicenseVerifier(),
    ).execute(companyFixture);
    createUser = new CreateUserUseCase(users, roles, passwordHasher);
  });

  it('creates an internal user only with roles from the authenticated company', async () => {
    const companyId = store.companies[0].id;
    const managerRole = store.roles.find((role) => role.code === 'manager');

    const output = await createUser.execute({
      companyId,
      name: 'Bruno Lima',
      username: 'bruno.lima',
      email: 'bruno@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['operations'],
      roleIds: [managerRole!.id],
    });

    expect(output.roles).toEqual(['manager']);
    expect(output.permissions).toContain('operations:manage');
    expect(output.permissions).toContain('whatsapp-conversations:manage');
    expect(store.users).toHaveLength(2);
  });

  it('does not return a user when queried through a different company id', async () => {
    const targetUser = store.users[0];

    await expect(
      new GetUserUseCase(users).execute(
        '00000000-0000-4000-8000-000000000099',
        targetUser.id,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects a role that belongs to another company', async () => {
    const firstCompanyId = store.companies[0].id;
    const foreignRole = Role.create({
      companyId: '00000000-0000-4000-8000-000000000099',
      code: 'foreign-manager',
      name: 'Gerente externo',
      permissionCodes: ['dashboard:view'],
    });
    store.roles.push(foreignRole);

    await expect(
      createUser.execute({
        companyId: firstCompanyId,
        name: 'Usuário Inválido',
        username: 'usuario.invalido',
        email: 'invalido@empresa.test',
        password: 'OutraSenha@2026',
        departments: [],
        roleIds: [foreignRole.id],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(store.users).toHaveLength(1);
  });
});

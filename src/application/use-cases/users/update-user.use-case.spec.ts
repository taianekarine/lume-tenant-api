import { beforeEach, describe, expect, it } from 'vitest';

import {
  FakePasswordHasher,
  FakeOfflineLicenseVerifier,
  InMemoryRolesRepository,
  InMemoryStore,
  InMemoryTenantBootstrapRepository,
  InMemoryUsersRepository,
} from '../../../../test/fakes/in-memory';
import { companyFixture } from '../../../../test/fixtures/company';
import { BootstrapTenantUseCase } from '../tenant/bootstrap-tenant.use-case';
import { CreateUserUseCase } from './create-user.use-case';
import { UpdateUserUseCase } from './update-user.use-case';

describe('UpdateUserUseCase', () => {
  let store: InMemoryStore;
  let users: InMemoryUsersRepository;
  let roles: InMemoryRolesRepository;
  let useCase: UpdateUserUseCase;

  beforeEach(async () => {
    store = new InMemoryStore();
    users = new InMemoryUsersRepository(store);
    roles = new InMemoryRolesRepository(store);
    await new BootstrapTenantUseCase(
      new InMemoryTenantBootstrapRepository(store),
      new FakePasswordHasher(),
      new FakeOfflineLicenseVerifier(),
    ).execute(companyFixture);
    useCase = new UpdateUserUseCase(users, roles);
  });

  it('updates a regular user within its company', async () => {
    const companyId = store.companies[0].id;
    const manager = store.roles.find((role) => role.code === 'manager')!;
    const created = await new CreateUserUseCase(
      users,
      roles,
      new FakePasswordHasher(),
    ).execute({
      companyId,
      name: 'Bruno Lima',
      username: 'bruno.lima',
      email: 'bruno@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['operations'],
      roleIds: [manager.id],
    });

    const updated = await useCase.execute({
      companyId,
      currentUserId: store.users[0].id,
      userId: created.id,
      name: 'Bruno Lima Atualizado',
      email: 'bruno.atualizado@empresa.test',
      departments: ['monitoring'],
      roleIds: [manager.id],
    });

    expect(updated.name).toBe('Bruno Lima Atualizado');
    expect(updated.email).toBe('bruno.atualizado@empresa.test');
    expect(updated.departments).toEqual(['monitoring']);
  });

  it('prevents self-deactivation', async () => {
    const administrator = store.users[0];

    await expect(
      useCase.execute({
        companyId: administrator.companyId,
        currentUserId: administrator.id,
        userId: administrator.id,
        isActive: false,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps at least one active administrator in the company', async () => {
    const administrator = store.users[0];

    await expect(
      useCase.execute({
        companyId: administrator.companyId,
        currentUserId: '00000000-0000-4000-8000-000000000099',
        userId: administrator.id,
        roleIds: [],
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A empresa deve manter ao menos um administrador ativo.',
    });
  });

  it('allows removing the administrator role from an inactive account when another active administrator remains', async () => {
    const companyId = store.companies[0].id;
    const firstAdministrator = store.users[0];
    const administratorRole = store.roles.find(
      (role) => role.code === 'administrator',
    )!;
    const secondAdministrator = await new CreateUserUseCase(
      users,
      roles,
      new FakePasswordHasher(),
    ).execute({
      companyId,
      name: 'Segundo Administrador',
      username: 'segundo.admin',
      email: 'segundo.admin@empresa.test',
      password: 'OutraSenha@2026',
      departments: [],
      roleIds: [administratorRole.id],
    });

    await useCase.execute({
      companyId,
      currentUserId: secondAdministrator.id,
      userId: firstAdministrator.id,
      isActive: false,
    });
    const updated = await useCase.execute({
      companyId,
      currentUserId: secondAdministrator.id,
      userId: firstAdministrator.id,
      departments: ['operations'],
      roleIds: [],
    });

    expect(updated.isActive).toBe(false);
    expect(updated.roles).toEqual([]);
    expect(updated.departments).toEqual(['operations']);
  });

  it('does not leave a regular user without any department or role', async () => {
    const companyId = store.companies[0].id;
    const manager = store.roles.find((role) => role.code === 'manager')!;
    const created = await new CreateUserUseCase(
      users,
      roles,
      new FakePasswordHasher(),
    ).execute({
      companyId,
      name: 'Usuário somente com papel',
      username: 'somente.papel',
      email: 'somente.papel@empresa.test',
      password: 'OutraSenha@2026',
      departments: [],
      roleIds: [manager.id],
    });

    await expect(
      useCase.execute({
        companyId,
        currentUserId: store.users[0].id,
        userId: created.id,
        roleIds: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

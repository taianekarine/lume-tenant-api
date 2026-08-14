import { beforeEach, describe, expect, it } from 'vitest';

import {
  FakeOfflineLicenseVerifier,
  FakePasswordHasher,
  InMemoryStore,
  InMemoryTenantBootstrapRepository,
  InMemoryUsersRepository,
} from '../../../../test/fakes/in-memory';
import { companyFixture } from '../../../../test/fixtures/company';
import { User } from '../../../domain/entities/user';
import { BootstrapTenantUseCase } from '../tenant/bootstrap-tenant.use-case';
import { CreateUserUseCase } from './create-user.use-case';
import { UpdateUserStatusUseCase } from './update-user-status.use-case';
import { UpdateUserUseCase } from './update-user.use-case';

describe('UpdateUserUseCase', () => {
  let store: InMemoryStore;
  let users: InMemoryUsersRepository;
  let useCase: UpdateUserUseCase;
  let create: CreateUserUseCase;

  beforeEach(async () => {
    store = new InMemoryStore();
    users = new InMemoryUsersRepository(store);
    const passwordHasher = new FakePasswordHasher();
    await new BootstrapTenantUseCase(
      new InMemoryTenantBootstrapRepository(store),
      passwordHasher,
      new FakeOfflineLicenseVerifier(),
    ).execute(companyFixture);
    useCase = new UpdateUserUseCase(users);
    create = new CreateUserUseCase(users, passwordHasher);
  });

  it('updates departments and individual permissions atomically', async () => {
    const created = await create.execute({
      companyId: store.companies[0].id,
      name: 'Bruno Lima',
      username: 'bruno.lima',
      email: 'bruno@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['operations'],
      permissionCodes: ['operations:view'],
    });

    const updated = await useCase.execute({
      companyId: store.companies[0].id,
      userId: created.id,
      name: 'Bruno Atualizado',
      departments: ['monitoring'],
      permissionCodes: ['monitoring:view', 'monitoring:manage'],
    });

    expect(updated.name).toBe('Bruno Atualizado');
    expect(updated.departments).toEqual(['monitoring']);
    expect(updated.permissionCodes).toEqual([
      'monitoring:manage',
      'monitoring:view',
    ]);
  });

  it('keeps a document-only candidate editable and promotes it to collaborator', async () => {
    const candidate = await create.execute({
      companyId: store.companies[0].id,
      name: 'Jean Candidato',
      username: 'jean.candidato',
      email: 'jean@empresa.test',
      password: 'OutraSenha@2026',
      documentAccessMode: 'document-portal',
      departments: [],
      permissionCodes: [],
    });

    await expect(
      useCase.execute({
        companyId: store.companies[0].id,
        userId: candidate.id,
        name: 'Jean Atualizado',
      }),
    ).resolves.toMatchObject({
      name: 'Jean Atualizado',
      documentAccessMode: 'document-portal',
    });

    await expect(
      useCase.execute({
        companyId: store.companies[0].id,
        userId: candidate.id,
        documentAccessMode: 'standard',
        departments: ['commercial'],
        permissionCodes: ['commercial:view'],
      }),
    ).resolves.toMatchObject({
      documentAccessMode: 'standard',
      departments: ['commercial'],
      permissionCodes: ['commercial:view'],
    });
  });

  it('rejects keeping an incompatible permission while changing department', async () => {
    const created = await create.execute({
      companyId: store.companies[0].id,
      name: 'Bruno Lima',
      username: 'bruno.lima',
      email: 'bruno@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['operations'],
      permissionCodes: ['operations:manage'],
    });

    await expect(
      useCase.execute({
        companyId: store.companies[0].id,
        userId: created.id,
        departments: ['commercial'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('suspends, revokes sessions and records a future deadline', async () => {
    const created = await create.execute({
      companyId: store.companies[0].id,
      name: 'Bruno Lima',
      username: 'bruno.lima',
      email: 'bruno@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['operations'],
      permissionCodes: ['operations:view'],
    });
    const until = new Date(Date.now() + 86_400_000);
    const statusUseCase = new UpdateUserStatusUseCase(users);

    const suspended = await statusUseCase.execute({
      companyId: store.companies[0].id,
      actorUserId: store.users[0].id,
      currentUserId: store.users[0].id,
      userId: created.id,
      status: 'suspended',
      suspendedUntil: until,
      suspensionReason: 'Afastamento temporário',
    });

    expect(suspended).toMatchObject({
      status: 'suspended',
      isActive: false,
      suspensionReason: 'Afastamento temporário',
    });
    expect(suspended.suspendedUntil).toBe(until.toISOString());
  });

  it('prevents suspending the current user', async () => {
    const administrator = store.users[0];
    await expect(
      new UpdateUserStatusUseCase(users).execute({
        companyId: administrator.companyId,
        actorUserId: administrator.id,
        currentUserId: administrator.id,
        userId: administrator.id,
        status: 'inactive',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('prevents the current administrator from demoting itself', async () => {
    const administrator = store.users[0];

    await expect(
      useCase.execute({
        companyId: administrator.companyId,
        actorUserId: administrator.id,
        currentUserId: administrator.id,
        userId: administrator.id,
        isAdministrator: false,
        departments: ['management'],
        permissionCodes: ['users:view'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('blocks a management user from mutating administrator identity or status', async () => {
    const administrator = store.users[0];
    const manager = await create.execute({
      companyId: administrator.companyId,
      name: 'Gerente',
      username: 'gerente',
      email: 'gerente@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['management'],
      permissionCodes: [],
    });

    await expect(
      useCase.execute({
        companyId: administrator.companyId,
        actorUserId: manager.id,
        currentUserId: manager.id,
        userId: administrator.id,
        email: 'captura@empresa.test',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      new UpdateUserStatusUseCase(users).execute({
        companyId: administrator.companyId,
        actorUserId: manager.id,
        currentUserId: manager.id,
        userId: administrator.id,
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows TI to edit another ordinary user but blocks self and administrator targets', async () => {
    const administrator = store.users[0];
    const informationTechnology = await create.execute({
      companyId: administrator.companyId,
      name: 'Analista de TI',
      username: 'analista.ti',
      email: 'ti@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['information-technology'],
      permissionCodes: [],
    });
    const common = await create.execute({
      companyId: administrator.companyId,
      name: 'Usuário comum',
      username: 'usuario.comum',
      email: 'comum@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['commercial'],
      permissionCodes: ['commercial:view'],
    });

    await expect(
      useCase.execute({
        companyId: administrator.companyId,
        actorUserId: informationTechnology.id,
        currentUserId: informationTechnology.id,
        userId: common.id,
        departments: ['operations'],
        permissionCodes: ['operations:view'],
      }),
    ).resolves.toMatchObject({ departments: ['operations'] });

    await expect(
      useCase.execute({
        companyId: administrator.companyId,
        actorUserId: informationTechnology.id,
        currentUserId: informationTechnology.id,
        userId: informationTechnology.id,
        name: 'Autoedição indevida',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      useCase.execute({
        companyId: administrator.companyId,
        actorUserId: informationTechnology.id,
        currentUserId: informationTechnology.id,
        userId: administrator.id,
        name: 'Administrador capturado',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows TI to suspend and reactivate another ordinary user but blocks self and administrators', async () => {
    const administrator = store.users[0];
    const informationTechnology = await create.execute({
      companyId: administrator.companyId,
      name: 'Analista de TI',
      username: 'analista.ti.status',
      email: 'ti.status@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['information-technology'],
      permissionCodes: [],
    });
    const common = await create.execute({
      companyId: administrator.companyId,
      name: 'Usuário comum',
      username: 'usuario.status',
      email: 'usuario.status@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['commercial'],
      permissionCodes: ['commercial:view'],
    });
    const statusUseCase = new UpdateUserStatusUseCase(users);

    await expect(
      statusUseCase.execute({
        companyId: administrator.companyId,
        actorUserId: informationTechnology.id,
        currentUserId: informationTechnology.id,
        userId: common.id,
        status: 'suspended',
        suspendedUntil: new Date(Date.now() + 86_400_000),
        suspensionReason: 'Bloqueio solicitado',
      }),
    ).resolves.toMatchObject({ status: 'suspended', isActive: false });

    await expect(
      statusUseCase.execute({
        companyId: administrator.companyId,
        actorUserId: informationTechnology.id,
        currentUserId: informationTechnology.id,
        userId: common.id,
        status: 'active',
      }),
    ).resolves.toMatchObject({ status: 'active', isActive: true });

    await expect(
      statusUseCase.execute({
        companyId: administrator.companyId,
        actorUserId: informationTechnology.id,
        currentUserId: informationTechnology.id,
        userId: informationTechnology.id,
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      statusUseCase.execute({
        companyId: administrator.companyId,
        actorUserId: informationTechnology.id,
        currentUserId: informationTechnology.id,
        userId: administrator.id,
        status: 'active',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('prevents TI from granting license permissions while editing another user', async () => {
    const administrator = store.users[0];
    const informationTechnology = await create.execute({
      companyId: administrator.companyId,
      name: 'Analista de TI',
      username: 'analista.ti',
      email: 'ti@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['information-technology'],
      permissionCodes: [],
    });
    const common = await create.execute({
      companyId: administrator.companyId,
      name: 'Usuário comum',
      username: 'usuario.comum',
      email: 'comum@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['management'],
      permissionCodes: [],
    });

    await expect(
      useCase.execute({
        companyId: administrator.companyId,
        actorUserId: informationTechnology.id,
        currentUserId: informationTechnology.id,
        userId: common.id,
        permissionCodes: ['license:view'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps one active direct administrator', async () => {
    const administrator = store.users[0];
    const inactiveAdministrator = User.restore({
      ...User.create({
        companyId: administrator.companyId,
        name: 'Administrador inativo',
        username: 'admin.inativo',
        usernameNormalized: 'admin.inativo',
        email: 'admin.inativo@empresa.test',
        emailNormalized: 'admin.inativo@empresa.test',
        cpfNormalized: null,
        passwordHash: 'hashed:SenhaInicial@2026',
        isAdministrator: true,
        departments: [],
      }).props,
      status: 'inactive',
      isActive: false,
    });
    store.users.push(inactiveAdministrator);

    await expect(
      useCase.execute({
        companyId: administrator.companyId,
        actorUserId: inactiveAdministrator.id,
        currentUserId: inactiveAdministrator.id,
        userId: administrator.id,
        isAdministrator: false,
        departments: ['management'],
        permissionCodes: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await expect(
      new UpdateUserStatusUseCase(users).execute({
        companyId: administrator.companyId,
        actorUserId: inactiveAdministrator.id,
        currentUserId: inactiveAdministrator.id,
        userId: administrator.id,
        status: 'inactive',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('filters the paginated list by search, department, permission and status', async () => {
    await create.execute({
      companyId: store.companies[0].id,
      name: 'Maria Comercial',
      username: 'maria.comercial',
      email: 'maria@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['commercial'],
      permissionCodes: ['commercial:view'],
    });

    const result = await users.list(store.companies[0].id, {
      page: 1,
      pageSize: 20,
      search: 'maria',
      department: 'commercial',
      permission: 'commercial:view',
      status: 'active',
    });

    expect(result.total).toBe(1);
    expect(result.items[0].user.props.username).toBe('maria.comercial');
  });

  it('filters by effective permissions, including implicit permissions', async () => {
    await create.execute({
      companyId: store.companies[0].id,
      name: 'Maria Comercial',
      username: 'maria.comercial',
      email: 'maria@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['commercial'],
      permissionCodes: [],
    });

    const result = await users.list(store.companies[0].id, {
      page: 1,
      pageSize: 20,
      search: 'maria',
      permission: 'profile:view',
    });

    expect(result.total).toBe(1);
  });

  it('does not filter in a direct permission stored outside the department ceiling', async () => {
    const created = await create.execute({
      companyId: store.companies[0].id,
      name: 'Maria Comercial',
      username: 'maria.comercial',
      email: 'maria@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['commercial'],
      permissionCodes: [],
    });
    const index = store.users.findIndex((user) => user.id === created.id);
    store.users[index] = User.restore({
      ...store.users[index].props,
      permissionCodes: ['users:manage'],
    });

    const result = await users.list(store.companies[0].id, {
      page: 1,
      pageSize: 20,
      search: 'maria',
      permission: 'users:manage',
    });

    expect(result.total).toBe(0);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import { companyFixture } from '../../../../test/fixtures/company';
import {
  FakeOfflineLicenseVerifier,
  FakePasswordHasher,
  InMemoryStore,
  InMemoryTenantBootstrapRepository,
  InMemoryUsersRepository,
} from '../../../../test/fakes/in-memory';
import { User } from '../../../domain/entities/user';
import { BootstrapTenantUseCase } from '../tenant/bootstrap-tenant.use-case';
import { CreateUserUseCase } from './create-user.use-case';
import { GetUserUseCase } from './get-user.use-case';
import { RoutingRepository } from '../../contracts/routing.repository';

describe('tenant-scoped user use cases', () => {
  let store: InMemoryStore;
  let users: InMemoryUsersRepository;
  let createUser: CreateUserUseCase;

  beforeEach(async () => {
    store = new InMemoryStore();
    users = new InMemoryUsersRepository(store);
    const passwordHasher = new FakePasswordHasher();
    await new BootstrapTenantUseCase(
      new InMemoryTenantBootstrapRepository(store),
      passwordHasher,
      new FakeOfflineLicenseVerifier(),
    ).execute(companyFixture);
    createUser = new CreateUserUseCase(users, passwordHasher);
  });

  it('creates a user with departments and direct permissions', async () => {
    const output = await createUser.execute({
      companyId: store.companies[0].id,
      name: 'Bruno Lima',
      username: 'bruno.lima',
      email: 'bruno@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['operations'],
      permissionCodes: ['operations:view', 'operations:manage'],
    });

    expect(output.permissionCodes).toEqual([
      'operations:manage',
      'operations:view',
    ]);
    expect(output.permissions).toContain('operations:manage');
    expect(output.mustChangePassword).toBe(true);
  });

  it('normalizes Controladoria and preserves selected permissions', async () => {
    const output = await createUser.execute({
      companyId: store.companies[0].id,
      name: 'Carla Controladoria',
      username: 'carla.controladoria',
      email: 'carla.controladoria@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['controllership'],
      permissionCodes: ['financial:view', 'financial:manage'],
    });

    expect(output.departments).toEqual(['controllership']);
    expect(output.permissions).toContain('financial:manage');
  });

  it('rejects administrative permission for a Commercial-only user', async () => {
    await expect(
      createUser.execute({
        companyId: store.companies[0].id,
        name: 'Comercial Elevado',
        username: 'comercial.elevado',
        email: 'comercial.elevado@empresa.test',
        password: 'OutraSenha@2026',
        departments: ['commercial'],
        permissionCodes: ['users:manage'],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('allows only an existing administrator to create another administrator', async () => {
    const administrator = store.users[0];
    const created = await createUser.execute({
      companyId: administrator.companyId,
      actorUserId: administrator.id,
      name: 'Nova Administradora',
      username: 'nova.admin',
      email: 'nova.admin@empresa.test',
      password: 'OutraSenha@2026',
      isAdministrator: true,
      departments: [],
      permissionCodes: [],
    });

    expect(created.isAdministrator).toBe(true);
    expect(created.departments).toEqual(
      expect.arrayContaining(['commercial', 'management', 'operations']),
    );
    expect(created.permissions).toEqual(
      expect.arrayContaining(['users:manage', 'commercial:manage']),
    );
  });

  it('does not treat a stored users:manage permission as administrator authority', async () => {
    const commercial = await createUser.execute({
      companyId: store.companies[0].id,
      name: 'Comercial',
      username: 'comercial',
      email: 'comercial@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['commercial'],
      permissionCodes: [],
    });
    const index = store.users.findIndex((user) => user.id === commercial.id);
    store.users[index] = User.restore({
      ...store.users[index].props,
      permissionCodes: ['users:manage'],
    });

    await expect(
      createUser.execute({
        companyId: store.companies[0].id,
        actorUserId: commercial.id,
        name: 'Admin indevido',
        username: 'admin.indevido',
        email: 'admin.indevido@empresa.test',
        password: 'OutraSenha@2026',
        isAdministrator: true,
        departments: [],
        permissionCodes: [],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires at least one department', async () => {
    await expect(
      createUser.execute({
        companyId: store.companies[0].id,
        name: 'Sem Departamento',
        username: 'sem.departamento',
        email: 'sem.departamento@empresa.test',
        password: 'OutraSenha@2026',
        departments: [],
        permissionCodes: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('allows HR to create only an initial document portal access', async () => {
    const humanResources = await createUser.execute({
      companyId: store.companies[0].id,
      name: 'Analista de RH',
      username: 'analista.rh',
      email: 'rh@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['human-resources'],
      permissionCodes: ['users:create'],
    });

    const created = await createUser.execute({
      companyId: store.companies[0].id,
      actorUserId: humanResources.id,
      name: 'Novo Candidato',
      username: 'novo.candidato',
      email: 'candidato@empresa.test',
      password: 'OutraSenha@2026',
      documentAccessMode: 'document-portal',
      departments: [],
      permissionCodes: [],
    });

    expect(created.documentAccessMode).toBe('document-portal');
    expect(created.departments).toEqual([]);
    expect(created.permissions).toEqual(
      expect.arrayContaining(['documents:view', 'documents:create']),
    );
  });

  it('prevents HR from assigning departments or permissions during initial access', async () => {
    const humanResources = await createUser.execute({
      companyId: store.companies[0].id,
      name: 'Analista de RH',
      username: 'analista.rh',
      email: 'rh@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['human-resources'],
      permissionCodes: ['users:create'],
    });

    await expect(
      createUser.execute({
        companyId: store.companies[0].id,
        actorUserId: humanResources.id,
        name: 'Acesso Indevido',
        username: 'acesso.indevido',
        email: 'indevido@empresa.test',
        password: 'OutraSenha@2026',
        documentAccessMode: 'standard',
        departments: ['commercial'],
        permissionCodes: ['commercial:view'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows an existing TI user to create an ordinary user with departments and permissions', async () => {
    const informationTechnology = await createUser.execute({
      companyId: store.companies[0].id,
      name: 'Analista de TI',
      username: 'analista.ti',
      email: 'ti@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['information-technology'],
      permissionCodes: [],
    });

    const created = await createUser.execute({
      companyId: store.companies[0].id,
      actorUserId: informationTechnology.id,
      name: 'Novo Comercial',
      username: 'novo.comercial',
      email: 'novo.comercial@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['commercial'],
      permissionCodes: ['commercial:view', 'commercial:manage'],
    });

    expect(created.isAdministrator).toBe(false);
    expect(created.departments).toEqual(['commercial']);
    expect(created.permissionCodes).toEqual([
      'commercial:manage',
      'commercial:view',
    ]);
  });

  it('creates Cliente PJ scoped to an active served company', async () => {
    const routingCompanyId = '00000000-0000-4000-8000-000000000088';
    const routing = {
      findCompany: async () => ({ id: routingCompanyId, status: 'active' }),
    } as unknown as RoutingRepository;
    const useCase = new CreateUserUseCase(
      users,
      new FakePasswordHasher(),
      undefined,
      routing,
    );

    const created = await useCase.execute({
      companyId: store.companies[0].id,
      routingCompanyId,
      name: 'Cliente PJ',
      username: 'cliente.pj',
      email: 'cliente.pj@empresa.test',
      password: 'OutraSenha@2026',
      documentAccessMode: 'client',
      clientCategory: 'legal-entity',
      departments: ['client-company'],
      permissionCodes: ['passengers:import', 'routes:view'],
    });

    expect(created).toMatchObject({
      type: 'client',
      documentAccessMode: 'client',
      clientCategory: 'legal-entity',
      routingCompanyId,
      departments: ['client-company'],
    });
  });

  it('creates Cliente PF without a served-company link', async () => {
    const created = await createUser.execute({
      companyId: store.companies[0].id,
      name: 'Cliente PF',
      username: 'cliente.pf',
      email: 'cliente.pf@empresa.test',
      password: 'OutraSenha@2026',
      documentAccessMode: 'client',
      clientCategory: 'individual',
      departments: ['client-company'],
      permissionCodes: ['routes:view'],
    });

    expect(created).toMatchObject({
      type: 'client',
      clientCategory: 'individual',
      routingCompanyId: null,
    });
  });

  it('rejects Cliente PF linked to a PJ', async () => {
    await expect(
      createUser.execute({
        companyId: store.companies[0].id,
        routingCompanyId: '00000000-0000-4000-8000-000000000088',
        name: 'Cliente PF invalido',
        username: 'cliente.pf.invalido',
        email: 'cliente.pf.invalido@empresa.test',
        password: 'OutraSenha@2026',
        documentAccessMode: 'client',
        clientCategory: 'individual',
        departments: ['client-company'],
        permissionCodes: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('prevents TI from creating administrators or granting license permissions', async () => {
    const informationTechnology = await createUser.execute({
      companyId: store.companies[0].id,
      name: 'Analista de TI',
      username: 'analista.ti',
      email: 'ti@empresa.test',
      password: 'OutraSenha@2026',
      departments: ['information-technology'],
      permissionCodes: [],
    });

    await expect(
      createUser.execute({
        companyId: store.companies[0].id,
        actorUserId: informationTechnology.id,
        name: 'Admin indevido',
        username: 'admin.por.ti',
        email: 'admin.por.ti@empresa.test',
        password: 'OutraSenha@2026',
        isAdministrator: true,
        departments: [],
        permissionCodes: [],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await expect(
      createUser.execute({
        companyId: store.companies[0].id,
        actorUserId: informationTechnology.id,
        name: 'Licença indevida',
        username: 'licenca.por.ti',
        email: 'licenca.por.ti@empresa.test',
        password: 'OutraSenha@2026',
        departments: ['management'],
        permissionCodes: ['license:view'],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each(['12345678901', '---', '1234'])(
    'rejects username without at least one letter: %s',
    async (username) => {
      await expect(
        createUser.execute({
          companyId: store.companies[0].id,
          name: 'Usuário inválido',
          username,
          email: `${username.replaceAll('-', 'x')}@empresa.test`,
          password: 'OutraSenha@2026',
          departments: ['commercial'],
          permissionCodes: [],
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    },
  );

  it('does not return a user through another company id', async () => {
    await expect(
      new GetUserUseCase(users).execute({
        companyId: '00000000-0000-4000-8000-000000000099',
        userId: store.users[0].id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

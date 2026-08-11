import { describe, expect, it } from 'vitest';

import { Company } from '../../../domain/entities/company';
import { User } from '../../../domain/entities/user';
import { TenantAuditLogsRepository } from '../../contracts/repositories';
import {
  InMemoryStore,
  InMemoryUsersRepository,
} from '../../../../test/fakes/in-memory';
import { DeleteUserUseCase } from './delete-user.use-case';

class AuditLogs extends TenantAuditLogsRepository {
  readonly entries: Parameters<TenantAuditLogsRepository['create']>[0][] = [];

  async create(input: Parameters<TenantAuditLogsRepository['create']>[0]) {
    this.entries.push(input);
  }
}

function setup() {
  const store = new InMemoryStore();
  const company = Company.create({
    id: '00000000-0000-4000-8000-000000000010',
    legalName: 'Empresa Teste',
    taxId: '11222333000181',
  });
  const administrator = User.create({
    companyId: company.id,
    name: 'Administradora',
    username: 'admin',
    usernameNormalized: 'admin',
    email: 'admin@example.test',
    emailNormalized: 'admin@example.test',
    cpfNormalized: null,
    passwordHash: 'hashed:Senha@2026',
    isAdministrator: true,
    departments: [],
  });
  const common = User.create({
    companyId: company.id,
    name: 'Usuário comum',
    username: 'comum',
    usernameNormalized: 'comum',
    email: 'comum@example.test',
    emailNormalized: 'comum@example.test',
    cpfNormalized: null,
    passwordHash: 'hashed:Senha@2026',
    departments: ['commercial'],
  });
  store.companies.push(company);
  store.users.push(administrator, common);
  const auditLogs = new AuditLogs();
  return {
    store,
    company,
    administrator,
    common,
    useCase: new DeleteUserUseCase(
      new InMemoryUsersRepository(store),
      auditLogs,
    ),
    auditLogs,
  };
}

describe('DeleteUserUseCase', () => {
  it('allows only an administrator to delete another user and records the action', async () => {
    const context = setup();

    await expect(
      context.useCase.execute({
        companyId: context.company.id,
        actorUserId: context.administrator.id,
        userId: context.common.id,
      }),
    ).resolves.toEqual({ deleted: true });

    expect(context.store.users.map((user) => user.id)).not.toContain(
      context.common.id,
    );
    expect(context.auditLogs.entries).toContainEqual(
      expect.objectContaining({
        action: 'USER_DELETED',
        targetId: context.common.id,
      }),
    );
  });

  it('blocks ordinary users and self-deletion', async () => {
    const context = setup();

    await expect(
      context.useCase.execute({
        companyId: context.company.id,
        actorUserId: context.common.id,
        userId: context.administrator.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      context.useCase.execute({
        companyId: context.company.id,
        actorUserId: context.administrator.id,
        userId: context.administrator.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

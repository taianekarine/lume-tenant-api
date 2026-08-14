import { describe, expect, it, vi } from 'vitest';

import { Company } from '../../../domain/entities/company';
import { User } from '../../../domain/entities/user';
import { GetUserUseCase } from './get-user.use-case';
import { ListUsersUseCase } from './list-users.use-case';

function record(id: string, isAdministrator = false) {
  const company = Company.create({
    id: '11111111-1111-4111-8111-111111111111',
    legalName: 'Empresa Teste',
    taxId: '11222333000181',
  });
  const user = User.create({
    id,
    companyId: company.id,
    name: isAdministrator ? 'Administrador' : 'Colaborador',
    username: id,
    usernameNormalized: id,
    email: `${id}@example.test`,
    emailNormalized: `${id}@example.test`,
    cpfNormalized: null,
    passwordHash: 'hashed-password',
    isAdministrator,
    departments: isAdministrator ? ['management'] : ['commercial'],
  });
  return { user, departments: user.departments, permissionOverrides: [] };
}

describe('ListUsersUseCase', () => {
  it('apresenta os usuÃ¡rios e calcula a paginaÃ§Ã£o', async () => {
    const first = record('user-1');
    const second = record('user-2');
    const users = {
      list: vi.fn().mockResolvedValue({
        items: [first, second],
        total: 5,
      }),
    };

    await expect(
      new ListUsersUseCase(users as never).execute('company-id', {
        page: 2,
        pageSize: 2,
      }),
    ).resolves.toMatchObject({
      data: [{ id: first.user.id }, { id: second.user.id }],
      meta: { page: 2, pageSize: 2, total: 5, totalPages: 3 },
    });
  });
});

describe('GetUserUseCase', () => {
  it('retorna o alvo quando o responsÃ¡vel pode administrÃ¡-lo', async () => {
    const actor = record('actor-id', true);
    const target = record('target-id');
    const users = {
      findById: vi
        .fn()
        .mockResolvedValueOnce(target)
        .mockResolvedValueOnce(actor),
    };

    await expect(
      new GetUserUseCase(users as never).execute({
        companyId: 'company-id',
        actorUserId: 'actor-id',
        userId: 'target-id',
      }),
    ).resolves.toMatchObject({ id: target.user.id });
  });

  it('diferencia alvo e responsÃ¡vel inexistentes', async () => {
    const users = { findById: vi.fn().mockResolvedValue(null) };
    const useCase = new GetUserUseCase(users as never);

    await expect(
      useCase.execute({ companyId: 'company-id', userId: 'missing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    users.findById
      .mockResolvedValueOnce(record('target-id'))
      .mockResolvedValueOnce(null);
    await expect(
      useCase.execute({
        companyId: 'company-id',
        actorUserId: 'missing-actor',
        userId: 'target-id',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

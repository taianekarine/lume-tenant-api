import { beforeEach, describe, expect, it } from 'vitest';

import { User } from '../../../domain/entities/user';
import { BootstrapTenantUseCase } from '../tenant/bootstrap-tenant.use-case';
import { companyFixture } from '../../../../test/fixtures/company';
import {
  FakeAccessTokenService,
  FakeOfflineLicenseVerifier,
  FakePasswordChangeTokenService,
  FakePasswordHasher,
  FakeRefreshTokenService,
  InMemoryPasswordChangeChallengesRepository,
  InMemoryTenantBootstrapRepository,
  InMemoryRefreshTokensRepository,
  InMemoryStore,
  InMemoryUsersRepository,
} from '../../../../test/fakes/in-memory';
import { AuthenticateUseCase } from './authenticate.use-case';
import { RefreshSessionUseCase } from './refresh-session.use-case';

describe('authentication use cases', () => {
  let store: InMemoryStore;
  let authenticate: AuthenticateUseCase;
  let refresh: RefreshSessionUseCase;

  beforeEach(async () => {
    store = new InMemoryStore();
    const users = new InMemoryUsersRepository(store);
    const refreshTokens = new InMemoryRefreshTokensRepository(store);
    const accessTokens = new FakeAccessTokenService();
    const refreshTokenService = new FakeRefreshTokenService();
    const passwordHasher = new FakePasswordHasher();

    await new BootstrapTenantUseCase(
      new InMemoryTenantBootstrapRepository(store),
      passwordHasher,
      new FakeOfflineLicenseVerifier(),
    ).execute(companyFixture);
    store.users[0] = User.restore({
      ...store.users[0].props,
      mustChangePassword: false,
    });

    const challenges = new InMemoryPasswordChangeChallengesRepository(store);
    const passwordChangeTokenService = new FakePasswordChangeTokenService();

    authenticate = new AuthenticateUseCase(
      users,
      refreshTokens,
      passwordHasher,
      accessTokens,
      refreshTokenService,
      7,
      30,
      challenges,
      passwordChangeTokenService,
      30,
    );
    refresh = new RefreshSessionUseCase(
      users,
      refreshTokens,
      accessTokens,
      refreshTokenService,
      7,
      30,
    );
  });

  it('authenticates by normalized username and returns the frontend session contract', async () => {
    const output = await authenticate.execute({
      identifier: ' ANA.SOUZA ',
      password: companyFixture.administrator.password,
      remember: true,
    });
    expect(output.tokenType).toBe('Bearer');
    expect(output.expiresIn).toBe(900);
    expect(output.session.version).toBe(1);
    expect(output.session.rememberDevice).toBe(true);
    expect(output.session.user).toMatchObject({
      type: 'employee',
      clientCategory: null,
      isActive: true,
    });
    expect(output.session.user.permissions).toContain('dashboard:view');
    expect(output.session.user.permissions).toContain('users:manage');
    expect(JSON.stringify(output.session)).not.toContain('passwordHash');
    expect(store.refreshTokens).toHaveLength(1);
  });

  it.each([
    ['unknown user', 'desconhecido', companyFixture.administrator.password],
    [
      'wrong password',
      companyFixture.administrator.username,
      'SenhaIncorreta@2026',
    ],
  ])(
    'returns the same safe error for %s',
    async (_case, identifier, password) => {
      await expect(
        authenticate.execute({ identifier, password, remember: false }),
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Usuário ou senha inválidos.',
      });
    },
  );

  it('does not accept CPF as a login identifier', async () => {
    await expect(
      authenticate.execute({
        identifier: companyFixture.administrator.cpf,
        password: companyFixture.administrator.password,
        remember: false,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('rotates refresh tokens and rejects reuse of the previous token', async () => {
    const first = await authenticate.execute({
      identifier: companyFixture.administrator.username,
      password: companyFixture.administrator.password,
      remember: false,
    });
    const second = await refresh.execute(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(store.refreshTokens[0].revokedAt).toBeInstanceOf(Date);
    expect(store.refreshTokens).toHaveLength(2);
    await expect(refresh.execute(first.refreshToken)).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
  });

  it('never creates a session with the initial password', async () => {
    const user = store.users[0];
    store.users[0] = User.restore({
      ...user.props,
      mustChangePassword: true,
    });

    await expect(
      authenticate.execute({
        identifier: companyFixture.administrator.username,
        password: companyFixture.administrator.password,
        remember: false,
      }),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_PASSWORD_SETUP_REQUIRED',
      details: {
        challengeToken: expect.any(String),
        expiresAt: expect.any(String),
        reason: 'first-access',
      },
    });
    expect(store.refreshTokens).toHaveLength(0);
    expect(store.passwordChallenges).toHaveLength(1);
  });

  it('blocks inactive and suspended accounts with stable error codes', async () => {
    const original = store.users[0];
    store.users[0] = User.restore({
      ...original.props,
      status: 'suspended',
      isActive: false,
      suspendedUntil: new Date(Date.now() + 86_400_000),
      suspensionReason: 'Afastamento',
    });
    await expect(
      authenticate.execute({
        identifier: companyFixture.administrator.username,
        password: companyFixture.administrator.password,
        remember: false,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });

    store.users[0] = User.restore({
      ...original.props,
      status: 'inactive',
      isActive: false,
    });
    await expect(
      authenticate.execute({
        identifier: companyFixture.administrator.username,
        password: companyFixture.administrator.password,
        remember: false,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
  });

  it('automatically resumes an expired suspension before authentication', async () => {
    const original = store.users[0];
    store.users[0] = User.restore({
      ...original.props,
      status: 'suspended',
      isActive: false,
      suspendedUntil: new Date(Date.now() - 1_000),
      suspensionReason: 'Prazo encerrado',
    });

    await expect(
      authenticate.execute({
        identifier: companyFixture.administrator.username,
        password: companyFixture.administrator.password,
        remember: false,
      }),
    ).resolves.toMatchObject({ tokenType: 'Bearer' });
    expect(store.users[0].props.status).toBe('active');
    expect(store.users[0].props.suspendedUntil).toBeNull();
  });
});

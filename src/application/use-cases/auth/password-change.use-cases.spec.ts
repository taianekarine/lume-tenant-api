import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { PasswordResetNotification } from '../../contracts/notifications';
import { PasswordResetNotifier } from '../../contracts/notifications';
import { TenantAuditLogsRepository } from '../../contracts/repositories';
import { Company } from '../../../domain/entities/company';
import { User } from '../../../domain/entities/user';
import {
  FakePasswordChangeTokenService,
  FakePasswordHasher,
  InMemoryPasswordChangeChallengesRepository,
  InMemoryStore,
  InMemoryUsersRepository,
} from '../../../../test/fakes/in-memory';
import {
  CompletePasswordChangeUseCase,
  RequestAdminPasswordResetUseCase,
  RequestPasswordResetUseCase,
  issuePasswordChangeChallenge,
} from './password-change.use-cases';

class TestAuditLogsRepository extends TenantAuditLogsRepository {
  readonly entries: unknown[] = [];

  async create(input: Parameters<TenantAuditLogsRepository['create']>[0]) {
    this.entries.push(input);
  }
}

class FailingPasswordResetNotifier extends PasswordResetNotifier {
  readonly configured = true;

  async send(_notification: PasswordResetNotification): Promise<void> {
    throw new Error('Delivery failed.');
  }
}

class DisabledPasswordResetNotifier extends PasswordResetNotifier {
  readonly configured = false;

  async send(_notification: PasswordResetNotification): Promise<void> {
    throw new Error('Disabled.');
  }
}

class RecordingPasswordResetNotifier extends PasswordResetNotifier {
  readonly configured = true;
  readonly notifications: PasswordResetNotification[] = [];

  async send(notification: PasswordResetNotification): Promise<void> {
    this.notifications.push(notification);
  }
}

describe('password change flow', () => {
  it('forces a temporary password to be replaced and consumes the token once', async () => {
    const store = new InMemoryStore();
    const company = Company.create({
      id: '00000000-0000-4000-8000-000000000010',
      legalName: 'Empresa Teste',
      taxId: '11222333000181',
    });
    store.companies.push(company);
    const passwordHasher = new FakePasswordHasher();
    const user = User.create({
      companyId: company.id,
      name: 'Usuário Temporário',
      username: 'temporario',
      usernameNormalized: 'temporario',
      email: 'temporario@example.test',
      emailNormalized: 'temporario@example.test',
      cpfNormalized: null,
      passwordHash: await passwordHasher.hash('SenhaTemporaria@2026'),
      departments: ['commercial'],
      mustChangePassword: true,
    });
    store.users.push(user);
    const users = new InMemoryUsersRepository(store);
    const challenges = new InMemoryPasswordChangeChallengesRepository(store);
    const tokenService = new FakePasswordChangeTokenService();
    const challenge = await issuePasswordChangeChallenge({
      user: (await users.findById(company.id, user.id))!,
      reason: 'first-access',
      challenges,
      tokenService,
      ttlMinutes: 30,
    });
    const complete = new CompletePasswordChangeUseCase(
      users,
      challenges,
      passwordHasher,
      tokenService,
      10,
    );

    await expect(
      complete.execute({
        token: challenge.challengeToken,
        newPassword: 'NovaSenhaSegura@2026',
      }),
    ).resolves.toEqual({ changed: true });
    const updated = await users.findById(company.id, user.id);
    expect(updated?.user.props.mustChangePassword).toBe(false);
    expect(
      await passwordHasher.compare(
        'NovaSenhaSegura@2026',
        updated!.user.props.passwordHash,
      ),
    ).toBe(true);
    expect(store.passwordHistory).toHaveLength(1);
    await expect(
      complete.execute({
        token: challenge.challengeToken,
        newPassword: 'OutraSenhaSegura@2026',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD_CHANGE_TOKEN' });
  });

  it('rejects a password that appears in the secure hash history', async () => {
    const store = new InMemoryStore();
    const company = Company.create({
      id: '00000000-0000-4000-8000-000000000010',
      legalName: 'Empresa Teste',
      taxId: '11222333000181',
    });
    store.companies.push(company);
    const passwordHasher = new FakePasswordHasher();
    const user = User.create({
      companyId: company.id,
      name: 'Usuário',
      username: 'usuario',
      usernameNormalized: 'usuario',
      email: 'usuario@example.test',
      emailNormalized: 'usuario@example.test',
      cpfNormalized: null,
      passwordHash: await passwordHasher.hash('SenhaAnterior@2026'),
      departments: ['commercial'],
      mustChangePassword: true,
    });
    store.users.push(user);
    const users = new InMemoryUsersRepository(store);
    const challenges = new InMemoryPasswordChangeChallengesRepository(store);
    const tokenService = new FakePasswordChangeTokenService();
    const challenge = await issuePasswordChangeChallenge({
      user: (await users.findById(company.id, user.id))!,
      reason: 'first-access',
      challenges,
      tokenService,
      ttlMinutes: 30,
    });

    await expect(
      new CompletePasswordChangeUseCase(
        users,
        challenges,
        passwordHasher,
        tokenService,
        10,
      ).execute({
        token: challenge.challengeToken,
        newPassword: 'SenhaAnterior@2026',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(store.passwordChallenges[0].consumedAt).toBeNull();
  });

  it('invalidates older challenges when a new one is issued', async () => {
    const store = new InMemoryStore();
    const company = Company.create({
      id: '00000000-0000-4000-8000-000000000010',
      legalName: 'Empresa Teste',
      taxId: '11222333000181',
    });
    store.companies.push(company);
    const passwordHasher = new FakePasswordHasher();
    const user = User.create({
      companyId: company.id,
      name: 'Usuario',
      username: 'usuario',
      usernameNormalized: 'usuario',
      email: 'usuario@example.test',
      emailNormalized: 'usuario@example.test',
      cpfNormalized: null,
      passwordHash: await passwordHasher.hash('SenhaTemporaria@2026'),
      departments: ['commercial'],
      mustChangePassword: true,
    });
    store.users.push(user);
    const users = new InMemoryUsersRepository(store);
    const challenges = new InMemoryPasswordChangeChallengesRepository(store);
    const tokenService = new FakePasswordChangeTokenService();
    const record = (await users.findById(company.id, user.id))!;
    const first = await issuePasswordChangeChallenge({
      user: record,
      reason: 'first-access',
      challenges,
      tokenService,
      ttlMinutes: 30,
    });
    await issuePasswordChangeChallenge({
      user: record,
      reason: 'first-access',
      challenges,
      tokenService,
      ttlMinutes: 30,
    });

    expect(store.passwordChallenges[0].consumedAt).not.toBeNull();
    await expect(
      new CompletePasswordChangeUseCase(
        users,
        challenges,
        passwordHasher,
        tokenService,
        10,
      ).execute({
        token: first.challengeToken,
        newPassword: 'NovaSenhaSegura@2026',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD_CHANGE_TOKEN' });
  });

  it('rejects a valid challenge after the password-change requirement is cleared', async () => {
    const store = new InMemoryStore();
    const company = Company.create({
      id: '00000000-0000-4000-8000-000000000010',
      legalName: 'Empresa Teste',
      taxId: '11222333000181',
    });
    store.companies.push(company);
    const passwordHasher = new FakePasswordHasher();
    const user = User.create({
      companyId: company.id,
      name: 'Usuario',
      username: 'usuario',
      usernameNormalized: 'usuario',
      email: 'usuario@example.test',
      emailNormalized: 'usuario@example.test',
      cpfNormalized: null,
      passwordHash: await passwordHasher.hash('SenhaTemporaria@2026'),
      departments: ['commercial'],
      mustChangePassword: true,
    });
    store.users.push(user);
    const users = new InMemoryUsersRepository(store);
    const challenges = new InMemoryPasswordChangeChallengesRepository(store);
    const tokenService = new FakePasswordChangeTokenService();
    const challenge = await issuePasswordChangeChallenge({
      user: (await users.findById(company.id, user.id))!,
      reason: 'first-access',
      challenges,
      tokenService,
      ttlMinutes: 30,
    });
    await users.changePassword(
      company.id,
      user.id,
      await passwordHasher.hash('SenhaAtual@2026'),
      new Date(),
    );

    await expect(
      new CompletePasswordChangeUseCase(
        users,
        challenges,
        passwordHasher,
        tokenService,
        10,
      ).execute({
        token: challenge.challengeToken,
        newPassword: 'OutraSenhaSegura@2026',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PASSWORD_CHANGE_TOKEN' });
  });

  it('does not block the user when reset e-mail delivery fails', async () => {
    const store = new InMemoryStore();
    const company = Company.create({
      id: '00000000-0000-4000-8000-000000000010',
      legalName: 'Empresa Teste',
      taxId: '11222333000181',
    });
    store.companies.push(company);
    const passwordHasher = new FakePasswordHasher();
    const user = User.create({
      companyId: company.id,
      name: 'Usuario',
      username: 'usuario',
      usernameNormalized: 'usuario',
      email: 'usuario@example.test',
      emailNormalized: 'usuario@example.test',
      cpfNormalized: null,
      passwordHash: await passwordHasher.hash('SenhaAtual@2026'),
      departments: ['commercial'],
    });
    store.users.push(user);
    const users = new InMemoryUsersRepository(store);
    const challenges = new InMemoryPasswordChangeChallengesRepository(store);
    const auditLogs = new TestAuditLogsRepository();
    const useCase = new RequestAdminPasswordResetUseCase(
      users,
      challenges,
      new FakePasswordChangeTokenService(),
      new FailingPasswordResetNotifier(),
      auditLogs,
      new ConfigService({
        PASSWORD_CHANGE_TOKEN_TTL_MINUTES: 30,
        PASSWORD_RESET_URL_BASE: 'https://tenant.example/password-change',
      }),
    );

    await expect(
      useCase.execute({
        companyId: company.id,
        actorUserId: '00000000-0000-4000-8000-000000000099',
        userId: user.id,
      }),
    ).rejects.toThrow('Delivery failed.');

    const unchanged = await users.findById(company.id, user.id);
    expect(unchanged?.user.props.mustChangePassword).toBe(false);
    expect(unchanged?.user.props.tokenVersion).toBe(user.props.tokenVersion);
    expect(store.passwordChallenges).toHaveLength(0);
    expect(auditLogs.entries).toEqual([
      expect.objectContaining({
        action: 'PASSWORD_RESET_DELIVERY_FAILED',
        targetId: user.id,
        metadata: expect.objectContaining({
          delivery: 'resend',
          failureCode: 'PROVIDER_UNAVAILABLE',
          correlationId: expect.any(String),
        }),
      }),
    ]);
  });

  it('preserves an existing active challenge when reset delivery fails', async () => {
    const store = new InMemoryStore();
    const company = Company.create({
      id: '00000000-0000-4000-8000-000000000010',
      legalName: 'Empresa Teste',
      taxId: '11222333000181',
    });
    store.companies.push(company);
    const passwordHasher = new FakePasswordHasher();
    const user = User.create({
      companyId: company.id,
      name: 'Usuario',
      username: 'usuario',
      usernameNormalized: 'usuario',
      email: 'usuario@example.test',
      emailNormalized: 'usuario@example.test',
      cpfNormalized: null,
      passwordHash: await passwordHasher.hash('SenhaTemporaria@2026'),
      departments: ['commercial'],
      mustChangePassword: true,
    });
    store.users.push(user);
    const users = new InMemoryUsersRepository(store);
    const challenges = new InMemoryPasswordChangeChallengesRepository(store);
    const tokenService = new FakePasswordChangeTokenService();
    const existing = await issuePasswordChangeChallenge({
      user: (await users.findById(company.id, user.id))!,
      reason: 'first-access',
      challenges,
      tokenService,
      ttlMinutes: 30,
    });
    const existingId = tokenService.parse(existing.challengeToken)!.id;

    await expect(
      new RequestAdminPasswordResetUseCase(
        users,
        challenges,
        tokenService,
        new FailingPasswordResetNotifier(),
        new TestAuditLogsRepository(),
        new ConfigService({
          PASSWORD_CHANGE_TOKEN_TTL_MINUTES: 30,
          PASSWORD_RESET_URL_BASE: 'https://tenant.example/password-change',
        }),
      ).execute({
        companyId: company.id,
        actorUserId: '00000000-0000-4000-8000-000000000099',
        userId: user.id,
      }),
    ).rejects.toThrow('Delivery failed.');

    expect(store.passwordChallenges).toHaveLength(1);
    expect(store.passwordChallenges[0]).toMatchObject({
      id: existingId,
      consumedAt: null,
    });
  });

  it('returns the same public response without enumerating the account', async () => {
    const store = new InMemoryStore();
    const company = Company.create({
      id: '00000000-0000-4000-8000-000000000010',
      legalName: 'Empresa Teste',
      taxId: '11222333000181',
    });
    store.companies.push(company);
    const user = User.create({
      companyId: company.id,
      name: 'Usuário',
      username: 'usuario',
      usernameNormalized: 'usuario',
      email: 'usuario@example.test',
      emailNormalized: 'usuario@example.test',
      cpfNormalized: null,
      passwordHash: 'hashed:SenhaInicial@2026',
      departments: ['commercial'],
      mustChangePassword: false,
    });
    store.users.push(user);
    store.refreshTokens.push({
      id: '00000000-0000-4000-8000-000000000020',
      companyId: company.id,
      userId: user.id,
      tokenHash: 'refresh-hash',
      rememberDevice: false,
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      createdAt: new Date(),
    });
    const notifier = new RecordingPasswordResetNotifier();
    const auditLogs = new TestAuditLogsRepository();
    const users = new InMemoryUsersRepository(store);
    const challenges = new InMemoryPasswordChangeChallengesRepository(store);
    const tokenService = new FakePasswordChangeTokenService();
    const useCase = new RequestPasswordResetUseCase(
      users,
      challenges,
      tokenService,
      notifier,
      auditLogs,
      new ConfigService({
        PASSWORD_CHANGE_TOKEN_TTL_MINUTES: 30,
        PASSWORD_RESET_URL_BASE: 'https://tenant.example/password-change',
      }),
    );

    const unknown = await useCase.execute({ identifier: 'inexistente' });
    const existing = await useCase.execute({ identifier: 'USUARIO' });

    expect(existing).toEqual(unknown);
    expect(notifier.notifications).toHaveLength(1);
    expect(store.passwordChallenges).toHaveLength(1);
    expect(auditLogs.entries[0]).not.toHaveProperty('actorUserId');
    expect(store.users[0].props.mustChangePassword).toBe(false);
    expect(store.users[0].props.tokenVersion).toBe(user.props.tokenVersion);
    expect(store.refreshTokens[0].revokedAt).toBeNull();

    const resetToken = new URL(
      notifier.notifications[0].resetUrl,
    ).searchParams.get('token');
    await expect(
      new CompletePasswordChangeUseCase(
        users,
        challenges,
        new FakePasswordHasher(),
        tokenService,
        10,
      ).execute({
        token: resetToken!,
        newPassword: 'NovaSenhaSegura@2026',
      }),
    ).resolves.toEqual({ changed: true });
    expect(store.refreshTokens[0].revokedAt).toBeInstanceOf(Date);
  });

  it('fails with the same public service error before looking up an account when e-mail is disabled', async () => {
    const store = new InMemoryStore();
    const users = new InMemoryUsersRepository(store);
    const lookup = vi.spyOn(users, 'findByLoginIdentifier');
    const useCase = new RequestPasswordResetUseCase(
      users,
      new InMemoryPasswordChangeChallengesRepository(store),
      new FakePasswordChangeTokenService(),
      new DisabledPasswordResetNotifier(),
      new TestAuditLogsRepository(),
      new ConfigService({
        PASSWORD_CHANGE_TOKEN_TTL_MINUTES: 30,
        PASSWORD_RESET_URL_BASE: 'https://tenant.example/password-change',
      }),
    );

    await expect(
      useCase.execute({ identifier: 'qualquer-conta' }),
    ).rejects.toMatchObject({
      code: 'EMAIL_DELIVERY_UNAVAILABLE',
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('blocks a non-administrator from resetting an administrator password', async () => {
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
      passwordHash: 'hashed:SenhaInicial@2026',
      isAdministrator: true,
      departments: [],
    });
    const manager = User.create({
      companyId: company.id,
      name: 'Gerente',
      username: 'gerente',
      usernameNormalized: 'gerente',
      email: 'gerente@example.test',
      emailNormalized: 'gerente@example.test',
      cpfNormalized: null,
      passwordHash: 'hashed:SenhaInicial@2026',
      departments: ['management'],
      permissionCodes: ['users:manage'],
    });
    store.companies.push(company);
    store.users.push(administrator, manager);

    await expect(
      new RequestAdminPasswordResetUseCase(
        new InMemoryUsersRepository(store),
        new InMemoryPasswordChangeChallengesRepository(store),
        new FakePasswordChangeTokenService(),
        new RecordingPasswordResetNotifier(),
        new TestAuditLogsRepository(),
        new ConfigService({
          PASSWORD_CHANGE_TOKEN_TTL_MINUTES: 30,
          PASSWORD_RESET_URL_BASE: 'https://tenant.example/password-change',
        }),
      ).execute({
        companyId: company.id,
        actorUserId: manager.id,
        userId: administrator.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(store.passwordChallenges).toHaveLength(0);
  });
});

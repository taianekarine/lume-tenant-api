import { ConfigService } from '@nestjs/config';

import {
  AppError,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import type { UserRecord } from '../../contracts/repositories';
import { normalizeLoginIdentifier } from '../../../shared/utils/normalization';

export const PASSWORD_RESET_TTL_MINUTES = 30;
import {
  PasswordChangeTokenService,
  PasswordHasher,
} from '../../contracts/cryptography';
import { PasswordResetNotifier } from '../../contracts/notifications';
import {
  PasswordChangeChallengesRepository,
  TenantAuditLogsRepository,
  UsersRepository,
} from '../../contracts/repositories';
import { assertCanManageUserTarget } from '../../../domain/access/user-management-policy';

export type PasswordChangeReason = 'first-access' | 'admin-reset';

export interface PasswordChangeChallengeOutput {
  passwordChangeRequired: true;
  challengeToken: string;
  reason: PasswordChangeReason;
  expiresAt: string;
}

export async function issuePasswordChangeChallenge(input: {
  user: UserRecord;
  reason: PasswordChangeReason;
  challenges: PasswordChangeChallengesRepository;
  tokenService: PasswordChangeTokenService;
  ttlMinutes: number;
  now?: Date;
}): Promise<PasswordChangeChallengeOutput> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + input.ttlMinutes * 60_000);
  const token = input.tokenService.issue();

  await input.challenges.replaceForUser({
    id: token.id,
    companyId: input.user.user.companyId,
    userId: input.user.user.id,
    tokenHash: token.hash,
    reason: input.reason,
    expiresAt,
    consumedAt: null,
    createdAt: now,
  });

  return {
    passwordChangeRequired: true,
    challengeToken: token.plainText,
    reason: input.reason,
    expiresAt: expiresAt.toISOString(),
  };
}

async function rejectsPasswordReuse(
  password: string,
  hashes: readonly string[],
  passwordHasher: PasswordHasher,
): Promise<boolean> {
  const matches = await Promise.all(
    hashes.map((hash) => passwordHasher.compare(password, hash)),
  );
  return matches.some(Boolean);
}

function passwordResetDeliveryFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'DELIVERY_FAILED';
  const status = /HTTP (\d{3})/.exec(error.message)?.[1];
  return status ? `HTTP_${status}` : 'PROVIDER_UNAVAILABLE';
}

export class CompletePasswordChangeUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly challenges: PasswordChangeChallengesRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly tokenService: PasswordChangeTokenService,
    private readonly historyLimit: number,
    private readonly auditLogs?: TenantAuditLogsRepository,
  ) {}

  async execute(input: { token: string; newPassword: string }) {
    const parsed = this.tokenService.parse(input.token);
    const challenge = parsed ? await this.challenges.findById(parsed.id) : null;
    const now = new Date();

    if (
      !parsed ||
      !challenge ||
      challenge.consumedAt ||
      challenge.expiresAt <= now ||
      !this.tokenService.matches(parsed.hash, challenge.tokenHash)
    ) {
      throw new AppError(
        'INVALID_PASSWORD_CHANGE_TOKEN',
        'O link para criar a senha é inválido ou expirou.',
      );
    }

    const user = await this.users.findById(
      challenge.companyId,
      challenge.userId,
    );
    if (
      !user ||
      !user.user.props.isActive ||
      user.user.props.status !== 'active' ||
      (challenge.reason === 'first-access' &&
        !user.user.props.mustChangePassword) ||
      !user.companyIsActive
    ) {
      throw new AppError(
        'INVALID_PASSWORD_CHANGE_TOKEN',
        'O link para criar a senha é inválido ou expirou.',
      );
    }

    const hashes = await this.users.listPasswordHashes(
      challenge.companyId,
      challenge.userId,
      this.historyLimit,
    );
    if (
      await rejectsPasswordReuse(input.newPassword, hashes, this.passwordHasher)
    ) {
      throw validationError(
        `Escolha uma senha diferente das últimas ${this.historyLimit} senhas utilizadas.`,
      );
    }

    const completed = await this.challenges.complete({
      companyId: challenge.companyId,
      userId: challenge.userId,
      challengeId: challenge.id,
      passwordHash: await this.passwordHasher.hash(input.newPassword),
      changedAt: now,
    });
    if (!completed) {
      throw new AppError(
        'INVALID_PASSWORD_CHANGE_TOKEN',
        'O link para criar a senha é inválido ou expirou.',
      );
    }

    await this.auditLogs?.create({
      companyId: challenge.companyId,
      actorUserId: challenge.userId,
      action: 'PASSWORD_CHANGED',
      targetType: 'user',
      targetId: challenge.userId,
      metadata: { reason: challenge.reason },
    });

    return { changed: true };
  }
}

export class ChangeOwnPasswordUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly historyLimit: number,
    private readonly auditLogs?: TenantAuditLogsRepository,
  ) {}

  async execute(input: {
    companyId: string;
    userId: string;
    currentPassword: string;
    newPassword: string;
  }) {
    const user = await this.users.findById(input.companyId, input.userId);
    if (!user) throw notFound('Usuário');

    const currentMatches = await this.passwordHasher.compare(
      input.currentPassword,
      user.user.props.passwordHash,
    );
    if (!currentMatches) {
      throw forbidden('A senha atual não confere.');
    }

    const hashes = await this.users.listPasswordHashes(
      input.companyId,
      input.userId,
      this.historyLimit,
    );
    if (
      await rejectsPasswordReuse(input.newPassword, hashes, this.passwordHasher)
    ) {
      throw validationError(
        `Escolha uma senha diferente das últimas ${this.historyLimit} senhas utilizadas.`,
      );
    }

    const now = new Date();
    await this.users.changePassword(
      input.companyId,
      input.userId,
      await this.passwordHasher.hash(input.newPassword),
      now,
    );
    await this.auditLogs?.create({
      companyId: input.companyId,
      actorUserId: input.userId,
      action: 'PASSWORD_CHANGED',
      targetType: 'user',
      targetId: input.userId,
      metadata: { reason: 'self-service' },
    });

    return { changed: true, sessionRevoked: true };
  }
}

export class RequestAdminPasswordResetUseCase {
  private readonly resetUrlBase: string;

  constructor(
    private readonly users: UsersRepository,
    private readonly challenges: PasswordChangeChallengesRepository,
    private readonly tokenService: PasswordChangeTokenService,
    private readonly notifier: PasswordResetNotifier,
    private readonly auditLogs: TenantAuditLogsRepository,
    config: ConfigService,
  ) {
    this.resetUrlBase = config.getOrThrow<string>('PASSWORD_RESET_URL_BASE');
  }

  async execute(input: {
    companyId: string;
    actorUserId: string;
    userId: string;
  }) {
    const user = await this.users.findById(input.companyId, input.userId);
    if (!user) throw notFound('Usuário');
    const actor = await this.users.findById(input.companyId, input.actorUserId);
    if (!actor) throw notFound('Usuário responsável');
    assertCanManageUserTarget(actor.user.props, user.user.props);

    if (!this.notifier.configured) {
      throw validationError(
        'O envio de e-mail para redefinição de senha ainda não está configurado.',
      );
    }
    if (!user.user.props.isActive || user.user.props.status !== 'active') {
      throw validationError(
        'Ative o usuário antes de solicitar uma nova senha.',
      );
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000,
    );
    const token = this.tokenService.issue();
    const resetUrl = new URL(this.resetUrlBase);
    resetUrl.searchParams.set('token', token.plainText);
    const challenge = {
      id: token.id,
      companyId: input.companyId,
      userId: input.userId,
      tokenHash: token.hash,
      reason: 'admin-reset',
      expiresAt,
      consumedAt: null,
      createdAt: now,
    } as const;

    await this.challenges.replaceForUser(challenge);
    try {
      await this.notifier.send({
        recipientName: user.user.props.name,
        recipientUsername: user.user.props.username,
        recipientEmail: user.user.props.email,
        idempotencyKey: challenge.id,
        resetUrl: resetUrl.toString(),
        expiresAt,
      });
    } catch (error) {
      await this.challenges
        .cancelReplacement({
          challengeId: challenge.id,
          companyId: challenge.companyId,
          userId: challenge.userId,
          replacedAt: now,
        })
        .catch(() => undefined);
      await this.auditLogs
        .create({
          companyId: input.companyId,
          actorUserId: input.actorUserId,
          action: 'PASSWORD_RESET_DELIVERY_FAILED',
          targetType: 'user',
          targetId: input.userId,
          metadata: {
            delivery: 'resend',
            failureCode: passwordResetDeliveryFailureCode(error),
            correlationId: challenge.id,
          },
        })
        .catch(() => undefined);
      throw error;
    }
    await this.auditLogs.create({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      action: 'PASSWORD_RESET_REQUESTED',
      targetType: 'user',
      targetId: input.userId,
      metadata: { delivery: 'resend' },
    });

    return {
      requested: true,
      recipient: user.user.props.email,
      expiresAt: expiresAt.toISOString(),
    };
  }
}

export class RequestPasswordResetUseCase {
  private readonly resetUrlBase: string;
  private readonly minimumResponseMs: number;

  constructor(
    private readonly users: UsersRepository,
    private readonly challenges: PasswordChangeChallengesRepository,
    private readonly tokenService: PasswordChangeTokenService,
    private readonly notifier: PasswordResetNotifier,
    private readonly auditLogs: TenantAuditLogsRepository,
    config: ConfigService,
  ) {
    this.resetUrlBase = config.getOrThrow<string>('PASSWORD_RESET_URL_BASE');
    this.minimumResponseMs =
      config.get<number>('PASSWORD_RESET_MIN_RESPONSE_MS') ?? 0;
  }

  private async waitForMinimumResponse(startedAt: number): Promise<void> {
    const remaining = this.minimumResponseMs - (Date.now() - startedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  async execute(input: { identifier: string }) {
    if (!this.notifier.configured) {
      throw new AppError(
        'EMAIL_DELIVERY_UNAVAILABLE',
        'A recuperação de senha por e-mail está temporariamente indisponível.',
      );
    }
    const startedAt = Date.now();
    const genericResponse = {
      requested: true,
      message:
        'Se a conta existir e estiver habilitada, enviaremos as instruções para o e-mail cadastrado.',
    } as const;
    const user = await this.users.findByLoginIdentifier(
      normalizeLoginIdentifier(input.identifier),
    );

    if (
      !user ||
      !user.companyIsActive ||
      !user.user.props.isActive ||
      user.user.props.status !== 'active'
    ) {
      await this.waitForMinimumResponse(startedAt);
      return genericResponse;
    }

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000,
    );
    const token = this.tokenService.issue();
    const resetUrl = new URL(this.resetUrlBase);
    resetUrl.searchParams.set('token', token.plainText);

    const challenge = {
      id: token.id,
      companyId: user.user.companyId,
      userId: user.user.id,
      tokenHash: token.hash,
      reason: 'admin-reset',
      expiresAt,
      consumedAt: null,
      createdAt: now,
    } as const;
    try {
      await this.challenges.create(challenge);
    } catch {
      await this.waitForMinimumResponse(startedAt);
      return genericResponse;
    }

    try {
      await this.notifier.send({
        recipientName: user.user.props.name,
        recipientUsername: user.user.props.username,
        recipientEmail: user.user.props.email,
        idempotencyKey: challenge.id,
        resetUrl: resetUrl.toString(),
        expiresAt,
      });
    } catch (error) {
      await this.challenges.delete(challenge.id).catch(() => undefined);
      await this.auditLogs
        .create({
          companyId: user.user.companyId,
          action: 'PASSWORD_RESET_DELIVERY_FAILED',
          targetType: 'user',
          targetId: user.user.id,
          metadata: {
            delivery: 'resend',
            failureCode: passwordResetDeliveryFailureCode(error),
            correlationId: challenge.id,
          },
        })
        .catch(() => undefined);
      await this.waitForMinimumResponse(startedAt);
      return genericResponse;
    }

    await this.auditLogs
      .create({
        companyId: user.user.companyId,
        action: 'PASSWORD_RESET_SELF_REQUESTED',
        targetType: 'user',
        targetId: user.user.id,
        metadata: { delivery: 'resend' },
      })
      .catch(() => undefined);

    await this.waitForMinimumResponse(startedAt);
    return genericResponse;
  }
}

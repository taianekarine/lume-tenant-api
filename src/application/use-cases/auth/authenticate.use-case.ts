import { AppError } from '../../../core/errors/app-error';
import { normalizeLoginIdentifier } from '../../../shared/utils/normalization';
import {
  AccessTokenService,
  PasswordChangeTokenService,
  PasswordHasher,
  RefreshTokenService,
} from '../../contracts/cryptography';
import {
  PasswordChangeChallengesRepository,
  RefreshTokensRepository,
  UsersRepository,
} from '../../contracts/repositories';
import { presentUser } from '../../presenters/user.presenter';
import type { AuthenticationOutput } from './auth.types';
import { issuePasswordChangeChallenge } from './password-change.use-cases';

const DUMMY_PASSWORD_HASH =
  '$2b$12$9Qn8FtK4RhsfBWD84a0b3e4VbYQj8MR0v2OBtNkibIaUbKZhxy2nK';

export interface AuthenticateInput {
  identifier: string;
  password: string;
  remember: boolean;
}

export class AuthenticateUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly passwordHasher: PasswordHasher,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly refreshTtlDays: number,
    private readonly rememberRefreshTtlDays: number,
    private readonly passwordChangeChallenges: PasswordChangeChallengesRepository,
    private readonly passwordChangeTokenService: PasswordChangeTokenService,
    private readonly passwordChangeTtlMinutes: number,
  ) {}

  async execute(input: AuthenticateInput): Promise<AuthenticationOutput> {
    const identifier = normalizeLoginIdentifier(input.identifier);
    const record = await this.users.findByLoginIdentifier(identifier);
    const passwordMatches = await this.passwordHasher.compare(
      input.password,
      record?.user.props.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!record || !passwordMatches || !record.companyIsActive) {
      throw new AppError('INVALID_CREDENTIALS', 'Usuário ou senha inválidos.');
    }

    if (
      record.user.props.status === 'suspended' &&
      record.user.props.suspendedUntil &&
      record.user.props.suspendedUntil > new Date()
    ) {
      throw new AppError(
        'ACCOUNT_SUSPENDED',
        'Esta conta está suspensa. Contate o administrador.',
        {
          suspendedUntil: record.user.props.suspendedUntil.toISOString(),
          suspensionReason: record.user.props.suspensionReason,
        },
      );
    }

    if (
      record.user.props.status === 'inactive' ||
      !record.user.props.isActive
    ) {
      throw new AppError(
        'ACCOUNT_INACTIVE',
        'Esta conta está desativada. Contate o administrador.',
      );
    }

    if (record.user.props.mustChangePassword) {
      const challenge = await issuePasswordChangeChallenge({
        user: record,
        reason: 'first-access',
        challenges: this.passwordChangeChallenges,
        tokenService: this.passwordChangeTokenService,
        ttlMinutes: this.passwordChangeTtlMinutes,
      });
      throw new AppError(
        'ACCOUNT_PASSWORD_SETUP_REQUIRED',
        'Crie uma nova senha para concluir o primeiro acesso.',
        {
          challengeToken: challenge.challengeToken,
          expiresAt: challenge.expiresAt,
          reason: challenge.reason,
        },
      );
    }

    const now = new Date();
    const refreshExpiresAt = new Date(now);
    refreshExpiresAt.setUTCDate(
      refreshExpiresAt.getUTCDate() +
        (input.remember ? this.rememberRefreshTtlDays : this.refreshTtlDays),
    );

    const refreshToken = this.refreshTokenService.issue();
    const accessToken = await this.accessTokens.sign({
      sub: record.user.props.id,
      companyId: record.user.props.companyId,
      tokenVersion: record.user.props.tokenVersion,
    });

    await Promise.all([
      this.refreshTokens.create({
        id: refreshToken.id,
        companyId: record.user.props.companyId,
        userId: record.user.props.id,
        tokenHash: refreshToken.hash,
        rememberDevice: input.remember,
        expiresAt: refreshExpiresAt,
        revokedAt: null,
        createdAt: now,
      }),
      this.users.markLastLogin(
        record.user.props.companyId,
        record.user.props.id,
        now,
      ),
    ]);

    return {
      accessToken,
      refreshToken: refreshToken.plainText,
      tokenType: 'Bearer',
      expiresIn: this.accessTokens.expiresInSeconds,
      session: {
        version: 1,
        id: refreshToken.id,
        user: presentUser(record),
        issuedAt: now.toISOString(),
        expiresAt: refreshExpiresAt.toISOString(),
        rememberDevice: input.remember,
      },
    };
  }
}

import { AppError } from '../../../core/errors/app-error';
import { normalizeLoginIdentifier } from '../../../shared/utils/normalization';
import {
  AccessTokenService,
  PasswordHasher,
  RefreshTokenService,
} from '../../contracts/cryptography';
import {
  RefreshTokensRepository,
  UsersRepository,
} from '../../contracts/repositories';
import { presentUser } from '../../presenters/user.presenter';
import type { AuthenticationOutput } from './auth.types';

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
  ) {}

  async execute(input: AuthenticateInput): Promise<AuthenticationOutput> {
    const identifier = normalizeLoginIdentifier(input.identifier);
    const record = await this.users.findByLoginIdentifier(identifier);
    const passwordMatches = await this.passwordHasher.compare(
      input.password,
      record?.user.props.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (
      !record ||
      !passwordMatches ||
      !record.user.props.isActive ||
      !record.companyIsActive
    ) {
      throw new AppError('INVALID_CREDENTIALS', 'Usuário ou senha inválidos.');
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

import { AppError } from '../../../core/errors/app-error';
import {
  AccessTokenService,
  RefreshTokenService,
} from '../../contracts/cryptography';
import {
  RefreshTokensRepository,
  UsersRepository,
} from '../../contracts/repositories';
import { presentUser } from '../../presenters/user.presenter';
import type { AuthenticationOutput } from './auth.types';

export class RefreshSessionUseCase {
  constructor(
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly refreshTtlDays: number,
    private readonly rememberRefreshTtlDays: number,
  ) {}

  async execute(rawToken: string): Promise<AuthenticationOutput> {
    const parsed = this.refreshTokenService.parse(rawToken);
    const stored = parsed ? await this.refreshTokens.findById(parsed.id) : null;
    const now = new Date();

    if (
      !parsed ||
      !stored ||
      !this.refreshTokenService.matches(parsed.hash, stored.tokenHash) ||
      stored.revokedAt ||
      stored.expiresAt <= now
    ) {
      throw new AppError(
        'INVALID_REFRESH_TOKEN',
        'Sessão inválida ou expirada.',
      );
    }

    const record = await this.users.findById(stored.companyId, stored.userId);

    if (!record || !record.user.props.isActive || !record.companyIsActive) {
      throw new AppError(
        'INVALID_REFRESH_TOKEN',
        'Sessão inválida ou expirada.',
      );
    }

    const nextRefresh = this.refreshTokenService.issue();
    const expiresAt = new Date(now);
    expiresAt.setUTCDate(
      expiresAt.getUTCDate() +
        (stored.rememberDevice
          ? this.rememberRefreshTtlDays
          : this.refreshTtlDays),
    );

    const accessToken = await this.accessTokens.sign({
      sub: record.user.props.id,
      companyId: record.user.props.companyId,
      tokenVersion: record.user.props.tokenVersion,
    });

    await this.refreshTokens.rotate(stored.id, {
      id: nextRefresh.id,
      companyId: stored.companyId,
      userId: stored.userId,
      tokenHash: nextRefresh.hash,
      rememberDevice: stored.rememberDevice,
      expiresAt,
      revokedAt: null,
      createdAt: now,
    });

    return {
      accessToken,
      refreshToken: nextRefresh.plainText,
      tokenType: 'Bearer',
      expiresIn: this.accessTokens.expiresInSeconds,
      session: {
        version: 1,
        id: nextRefresh.id,
        user: presentUser(record),
        issuedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        rememberDevice: stored.rememberDevice,
      },
    };
  }
}

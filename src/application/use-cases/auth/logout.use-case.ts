import { RefreshTokenService } from '../../contracts/cryptography';
import { RefreshTokensRepository } from '../../contracts/repositories';

export class LogoutUseCase {
  constructor(
    private readonly refreshTokens: RefreshTokensRepository,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  async execute(rawToken: string): Promise<void> {
    const parsed = this.refreshTokenService.parse(rawToken);

    if (!parsed) {
      return;
    }

    const stored = await this.refreshTokens.findById(parsed.id);

    if (
      stored &&
      this.refreshTokenService.matches(parsed.hash, stored.tokenHash)
    ) {
      await this.refreshTokens.revoke(stored.id, new Date());
    }
  }
}

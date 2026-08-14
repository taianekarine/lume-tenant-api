import { describe, expect, it, vi } from 'vitest';

import { LogoutUseCase } from './logout.use-case';

describe('LogoutUseCase', () => {
  it('ignora tokens que nÃ£o podem ser interpretados', async () => {
    const refreshTokens = { findById: vi.fn(), revoke: vi.fn() };
    const tokenService = {
      parse: vi.fn().mockReturnValue(null),
      matches: vi.fn(),
    };

    await new LogoutUseCase(
      refreshTokens as never,
      tokenService as never,
    ).execute('invÃ¡lido');

    expect(refreshTokens.findById).not.toHaveBeenCalled();
    expect(refreshTokens.revoke).not.toHaveBeenCalled();
  });

  it('revoga somente o token persistido cujo hash confere', async () => {
    const refreshTokens = {
      findById: vi
        .fn()
        .mockResolvedValue({ id: 'token-id', tokenHash: 'stored-hash' }),
      revoke: vi.fn().mockResolvedValue(undefined),
    };
    const tokenService = {
      parse: vi.fn().mockReturnValue({ id: 'token-id', hash: 'parsed-hash' }),
      matches: vi.fn().mockReturnValue(true),
    };

    await new LogoutUseCase(
      refreshTokens as never,
      tokenService as never,
    ).execute('token');

    expect(tokenService.matches).toHaveBeenCalledWith(
      'parsed-hash',
      'stored-hash',
    );
    expect(refreshTokens.revoke).toHaveBeenCalledWith(
      'token-id',
      expect.any(Date),
    );
  });

  it.each([
    ['ausente', null, true],
    ['com hash diferente', { id: 'token-id', tokenHash: 'stored-hash' }, false],
  ])('nÃ£o revoga um token %s', async (_label, stored, matches) => {
    const refreshTokens = {
      findById: vi.fn().mockResolvedValue(stored),
      revoke: vi.fn(),
    };
    const tokenService = {
      parse: vi.fn().mockReturnValue({ id: 'token-id', hash: 'parsed-hash' }),
      matches: vi.fn().mockReturnValue(matches),
    };

    await new LogoutUseCase(
      refreshTokens as never,
      tokenService as never,
    ).execute('token');

    expect(refreshTokens.revoke).not.toHaveBeenCalled();
  });
});

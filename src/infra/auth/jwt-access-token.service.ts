import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import {
  AccessTokenService,
  type AccessTokenPayload,
} from '../../application/contracts/cryptography';

interface SignedAccessTokenPayload extends AccessTokenPayload {
  type: 'access';
}

@Injectable()
export class JwtAccessTokenService extends AccessTokenService {
  readonly expiresInSeconds: number;
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    super();
    this.secret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.expiresInSeconds = config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
  }

  sign(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(
      { ...payload, type: 'access' } satisfies SignedAccessTokenPayload,
      {
        secret: this.secret,
        expiresIn: this.expiresInSeconds,
        issuer: 'lume-tenant-api',
        audience: 'lume-tenant-users',
      },
    );
  }

  async verify(token: string): Promise<AccessTokenPayload> {
    const payload = await this.jwt.verifyAsync<SignedAccessTokenPayload>(
      token,
      {
        secret: this.secret,
        issuer: 'lume-tenant-api',
        audience: 'lume-tenant-users',
      },
    );

    if (
      payload.type !== 'access' ||
      typeof payload.sub !== 'string' ||
      typeof payload.companyId !== 'string' ||
      typeof payload.tokenVersion !== 'number'
    ) {
      throw new Error('Invalid access token payload.');
    }

    return {
      sub: payload.sub,
      companyId: payload.companyId,
      tokenVersion: payload.tokenVersion,
    };
  }
}

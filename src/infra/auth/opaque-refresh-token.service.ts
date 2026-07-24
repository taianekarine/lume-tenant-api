import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  RefreshTokenService,
  type IssuedRefreshToken,
  type ParsedRefreshToken,
} from '../../application/contracts/cryptography';

@Injectable()
export class OpaqueRefreshTokenService extends RefreshTokenService {
  issue(): IssuedRefreshToken {
    const id = randomUUID();
    const plainText = `${id}.${randomBytes(48).toString('base64url')}`;

    return { id, plainText, hash: this.hash(plainText) };
  }

  parse(token: string): ParsedRefreshToken | null {
    const separatorIndex = token.indexOf('.');

    if (separatorIndex < 1) {
      return null;
    }

    const id = token.slice(0, separatorIndex);

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      return null;
    }

    return { id, hash: this.hash(token) };
  }

  matches(firstHash: string, secondHash: string): boolean {
    const first = Buffer.from(firstHash, 'hex');
    const second = Buffer.from(secondHash, 'hex');

    return first.length === second.length && timingSafeEqual(first, second);
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}

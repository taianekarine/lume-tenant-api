import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { compare, hash } from 'bcryptjs';

import { PasswordHasher } from '../../application/contracts/cryptography';

@Injectable()
export class BcryptPasswordHasher extends PasswordHasher {
  private readonly rounds: number;

  constructor(config: ConfigService) {
    super();
    this.rounds = config.getOrThrow<number>('BCRYPT_ROUNDS');
  }

  hash(plainText: string): Promise<string> {
    return hash(plainText, this.rounds);
  }

  compare(plainText: string, passwordHash: string): Promise<boolean> {
    return compare(plainText, passwordHash);
  }
}

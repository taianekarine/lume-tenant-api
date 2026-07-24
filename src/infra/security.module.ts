import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import {
  AccessTokenService,
  OfflineLicenseVerifier,
  PasswordHasher,
  RefreshTokenService,
} from '../application/contracts/cryptography';
import { JwtAccessTokenService } from './auth/jwt-access-token.service';
import { OpaqueRefreshTokenService } from './auth/opaque-refresh-token.service';
import { BcryptPasswordHasher } from './cryptography/bcrypt-password-hasher';
import { Ed25519OfflineLicenseVerifier } from './licensing/ed25519-offline-license-verifier';

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [
    { provide: PasswordHasher, useClass: BcryptPasswordHasher },
    { provide: AccessTokenService, useClass: JwtAccessTokenService },
    { provide: RefreshTokenService, useClass: OpaqueRefreshTokenService },
    {
      provide: OfflineLicenseVerifier,
      useClass: Ed25519OfflineLicenseVerifier,
    },
  ],
  exports: [
    PasswordHasher,
    AccessTokenService,
    RefreshTokenService,
    OfflineLicenseVerifier,
  ],
})
export class SecurityModule {}

import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import {
  AccessTokenService,
  OfflineLicenseVerifier,
  PasswordChangeTokenService,
  PasswordHasher,
  RefreshTokenService,
} from '../application/contracts/cryptography';
import {
  PasswordResetNotifier,
  SupportRequestNotifier,
} from '../application/contracts/notifications';
import { JwtAccessTokenService } from './auth/jwt-access-token.service';
import {
  OpaquePasswordChangeTokenService,
  OpaqueRefreshTokenService,
} from './auth/opaque-refresh-token.service';
import { BcryptPasswordHasher } from './cryptography/bcrypt-password-hasher';
import { Ed25519OfflineLicenseVerifier } from './licensing/ed25519-offline-license-verifier';
import { ResendPasswordResetNotifier } from './notifications/resend-password-reset.notifier';
import { ResendSupportRequestNotifier } from './notifications/resend-support-request.notifier';

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [
    { provide: PasswordHasher, useClass: BcryptPasswordHasher },
    { provide: AccessTokenService, useClass: JwtAccessTokenService },
    { provide: RefreshTokenService, useClass: OpaqueRefreshTokenService },
    {
      provide: PasswordChangeTokenService,
      useClass: OpaquePasswordChangeTokenService,
    },
    {
      provide: OfflineLicenseVerifier,
      useClass: Ed25519OfflineLicenseVerifier,
    },
    {
      provide: PasswordResetNotifier,
      useClass: ResendPasswordResetNotifier,
    },
    {
      provide: SupportRequestNotifier,
      useClass: ResendSupportRequestNotifier,
    },
  ],
  exports: [
    PasswordHasher,
    AccessTokenService,
    RefreshTokenService,
    PasswordChangeTokenService,
    OfflineLicenseVerifier,
    PasswordResetNotifier,
    SupportRequestNotifier,
  ],
})
export class SecurityModule {}

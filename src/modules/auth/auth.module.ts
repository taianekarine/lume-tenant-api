import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';

import {
  AccessTokenService,
  PasswordChangeTokenService,
  PasswordHasher,
  RefreshTokenService,
} from '../../application/contracts/cryptography';
import {
  PasswordChangeChallengesRepository,
  RefreshTokensRepository,
  TenantAuditLogsRepository,
  UsersRepository,
} from '../../application/contracts/repositories';
import { PasswordResetNotifier } from '../../application/contracts/notifications';
import { AuthenticateUseCase } from '../../application/use-cases/auth/authenticate.use-case';
import { LogoutUseCase } from '../../application/use-cases/auth/logout.use-case';
import {
  CompletePasswordChangeUseCase,
  RequestPasswordResetUseCase,
} from '../../application/use-cases/auth/password-change.use-cases';
import { RefreshSessionUseCase } from '../../application/use-cases/auth/refresh-session.use-case';
import { JwtAuthGuard } from '../../shared/http/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../shared/http/guards/permissions.guard';
import { AuthController } from './auth.controller';

@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AuthenticateUseCase,
      useFactory: (
        users: UsersRepository,
        refreshTokens: RefreshTokensRepository,
        passwordHasher: PasswordHasher,
        accessTokens: AccessTokenService,
        refreshTokenService: RefreshTokenService,
        passwordChangeChallenges: PasswordChangeChallengesRepository,
        passwordChangeTokenService: PasswordChangeTokenService,
        config: ConfigService,
      ) =>
        new AuthenticateUseCase(
          users,
          refreshTokens,
          passwordHasher,
          accessTokens,
          refreshTokenService,
          config.getOrThrow<number>('JWT_REFRESH_TTL_DAYS'),
          config.getOrThrow<number>('JWT_REFRESH_REMEMBER_TTL_DAYS'),
          passwordChangeChallenges,
          passwordChangeTokenService,
          config.getOrThrow<number>('PASSWORD_CHANGE_TOKEN_TTL_MINUTES'),
        ),
      inject: [
        UsersRepository,
        RefreshTokensRepository,
        PasswordHasher,
        AccessTokenService,
        RefreshTokenService,
        PasswordChangeChallengesRepository,
        PasswordChangeTokenService,
        ConfigService,
      ],
    },
    {
      provide: CompletePasswordChangeUseCase,
      useFactory: (
        users: UsersRepository,
        challenges: PasswordChangeChallengesRepository,
        passwordHasher: PasswordHasher,
        tokenService: PasswordChangeTokenService,
        auditLogs: TenantAuditLogsRepository,
        config: ConfigService,
      ) =>
        new CompletePasswordChangeUseCase(
          users,
          challenges,
          passwordHasher,
          tokenService,
          config.getOrThrow<number>('PASSWORD_HISTORY_LIMIT'),
          auditLogs,
        ),
      inject: [
        UsersRepository,
        PasswordChangeChallengesRepository,
        PasswordHasher,
        PasswordChangeTokenService,
        TenantAuditLogsRepository,
        ConfigService,
      ],
    },
    {
      provide: RequestPasswordResetUseCase,
      useFactory: (
        users: UsersRepository,
        challenges: PasswordChangeChallengesRepository,
        tokenService: PasswordChangeTokenService,
        notifier: PasswordResetNotifier,
        auditLogs: TenantAuditLogsRepository,
        config: ConfigService,
      ) =>
        new RequestPasswordResetUseCase(
          users,
          challenges,
          tokenService,
          notifier,
          auditLogs,
          config,
        ),
      inject: [
        UsersRepository,
        PasswordChangeChallengesRepository,
        PasswordChangeTokenService,
        PasswordResetNotifier,
        TenantAuditLogsRepository,
        ConfigService,
      ],
    },
    {
      provide: RefreshSessionUseCase,
      useFactory: (
        users: UsersRepository,
        refreshTokens: RefreshTokensRepository,
        accessTokens: AccessTokenService,
        refreshTokenService: RefreshTokenService,
        config: ConfigService,
      ) =>
        new RefreshSessionUseCase(
          users,
          refreshTokens,
          accessTokens,
          refreshTokenService,
          config.getOrThrow<number>('JWT_REFRESH_TTL_DAYS'),
          config.getOrThrow<number>('JWT_REFRESH_REMEMBER_TTL_DAYS'),
        ),
      inject: [
        UsersRepository,
        RefreshTokensRepository,
        AccessTokenService,
        RefreshTokenService,
        ConfigService,
      ],
    },
    {
      provide: LogoutUseCase,
      useFactory: (
        refreshTokens: RefreshTokensRepository,
        refreshTokenService: RefreshTokenService,
      ) => new LogoutUseCase(refreshTokens, refreshTokenService),
      inject: [RefreshTokensRepository, RefreshTokenService],
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AuthModule {}

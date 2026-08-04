import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  PasswordChangeTokenService,
  PasswordHasher,
} from '../../application/contracts/cryptography';
import { PasswordResetNotifier } from '../../application/contracts/notifications';
import {
  PasswordChangeChallengesRepository,
  TenantAuditLogsRepository,
  UsersRepository,
} from '../../application/contracts/repositories';
import { CreateUserUseCase } from '../../application/use-cases/users/create-user.use-case';
import { GetUserUseCase } from '../../application/use-cases/users/get-user.use-case';
import { ListUsersUseCase } from '../../application/use-cases/users/list-users.use-case';
import { UpdateUserUseCase } from '../../application/use-cases/users/update-user.use-case';
import { UpdateUserStatusUseCase } from '../../application/use-cases/users/update-user-status.use-case';
import {
  ChangeOwnPasswordUseCase,
  RequestAdminPasswordResetUseCase,
} from '../../application/use-cases/auth/password-change.use-cases';
import {
  GetProfileUseCase,
  UpdateProfilePictureUseCase,
} from '../../application/use-cases/users/profile.use-cases';
import { UsersController } from './users.controller';
import { DocumentManagementModule } from '../documents/document-management.module';

@Module({
  imports: [DocumentManagementModule],
  controllers: [UsersController],
  providers: [
    {
      provide: CreateUserUseCase,
      useFactory: (
        users: UsersRepository,
        passwordHasher: PasswordHasher,
        auditLogs: TenantAuditLogsRepository,
      ) => new CreateUserUseCase(users, passwordHasher, auditLogs),
      inject: [UsersRepository, PasswordHasher, TenantAuditLogsRepository],
    },
    {
      provide: ListUsersUseCase,
      useFactory: (users: UsersRepository) => new ListUsersUseCase(users),
      inject: [UsersRepository],
    },
    {
      provide: GetUserUseCase,
      useFactory: (users: UsersRepository) => new GetUserUseCase(users),
      inject: [UsersRepository],
    },
    {
      provide: UpdateUserUseCase,
      useFactory: (
        users: UsersRepository,
        auditLogs: TenantAuditLogsRepository,
      ) => new UpdateUserUseCase(users, auditLogs),
      inject: [UsersRepository, TenantAuditLogsRepository],
    },
    {
      provide: UpdateUserStatusUseCase,
      useFactory: (
        users: UsersRepository,
        auditLogs: TenantAuditLogsRepository,
      ) => new UpdateUserStatusUseCase(users, auditLogs),
      inject: [UsersRepository, TenantAuditLogsRepository],
    },
    {
      provide: ChangeOwnPasswordUseCase,
      useFactory: (
        users: UsersRepository,
        passwordHasher: PasswordHasher,
        auditLogs: TenantAuditLogsRepository,
        config: ConfigService,
      ) =>
        new ChangeOwnPasswordUseCase(
          users,
          passwordHasher,
          config.getOrThrow<number>('PASSWORD_HISTORY_LIMIT'),
          auditLogs,
        ),
      inject: [
        UsersRepository,
        PasswordHasher,
        TenantAuditLogsRepository,
        ConfigService,
      ],
    },
    {
      provide: RequestAdminPasswordResetUseCase,
      useFactory: (
        users: UsersRepository,
        challenges: PasswordChangeChallengesRepository,
        tokenService: PasswordChangeTokenService,
        notifier: PasswordResetNotifier,
        auditLogs: TenantAuditLogsRepository,
        config: ConfigService,
      ) =>
        new RequestAdminPasswordResetUseCase(
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
      provide: GetProfileUseCase,
      useFactory: (users: UsersRepository) => new GetProfileUseCase(users),
      inject: [UsersRepository],
    },
    {
      provide: UpdateProfilePictureUseCase,
      useFactory: (
        users: UsersRepository,
        auditLogs: TenantAuditLogsRepository,
      ) => new UpdateProfilePictureUseCase(users, auditLogs),
      inject: [UsersRepository, TenantAuditLogsRepository],
    },
  ],
})
export class UsersModule {}

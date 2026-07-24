import { Module } from '@nestjs/common';

import { PasswordHasher } from '../../application/contracts/cryptography';
import {
  RolesRepository,
  TenantAuditLogsRepository,
  UsersRepository,
} from '../../application/contracts/repositories';
import { CreateUserUseCase } from '../../application/use-cases/users/create-user.use-case';
import { GetUserUseCase } from '../../application/use-cases/users/get-user.use-case';
import { ListUsersUseCase } from '../../application/use-cases/users/list-users.use-case';
import { UpdateUserUseCase } from '../../application/use-cases/users/update-user.use-case';
import { UsersController } from './users.controller';

@Module({
  controllers: [UsersController],
  providers: [
    {
      provide: CreateUserUseCase,
      useFactory: (
        users: UsersRepository,
        roles: RolesRepository,
        passwordHasher: PasswordHasher,
        auditLogs: TenantAuditLogsRepository,
      ) => new CreateUserUseCase(users, roles, passwordHasher, auditLogs),
      inject: [
        UsersRepository,
        RolesRepository,
        PasswordHasher,
        TenantAuditLogsRepository,
      ],
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
        roles: RolesRepository,
        auditLogs: TenantAuditLogsRepository,
      ) => new UpdateUserUseCase(users, roles, auditLogs),
      inject: [UsersRepository, RolesRepository, TenantAuditLogsRepository],
    },
  ],
})
export class UsersModule {}

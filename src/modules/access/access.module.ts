import { Module } from '@nestjs/common';

import { RolesRepository } from '../../application/contracts/repositories';
import {
  CreateRoleUseCase,
  DeleteRoleUseCase,
  ListPermissionsUseCase,
  ListRolesUseCase,
  UpdateRoleUseCase,
} from '../../application/use-cases/access/roles.use-cases';
import { AccessController } from './access.controller';

@Module({
  controllers: [AccessController],
  providers: [
    {
      provide: ListRolesUseCase,
      useFactory: (roles: RolesRepository) => new ListRolesUseCase(roles),
      inject: [RolesRepository],
    },
    {
      provide: CreateRoleUseCase,
      useFactory: (roles: RolesRepository) => new CreateRoleUseCase(roles),
      inject: [RolesRepository],
    },
    {
      provide: UpdateRoleUseCase,
      useFactory: (roles: RolesRepository) => new UpdateRoleUseCase(roles),
      inject: [RolesRepository],
    },
    {
      provide: DeleteRoleUseCase,
      useFactory: (roles: RolesRepository) => new DeleteRoleUseCase(roles),
      inject: [RolesRepository],
    },
    {
      provide: ListPermissionsUseCase,
      useFactory: () => new ListPermissionsUseCase(),
    },
  ],
})
export class AccessModule {}

import { Module } from '@nestjs/common';

import { ListPermissionsUseCase } from '../../application/use-cases/access/list-permissions.use-case';
import { AccessController } from './access.controller';

@Module({
  controllers: [AccessController],
  providers: [
    {
      provide: ListPermissionsUseCase,
      useFactory: () => new ListPermissionsUseCase(),
    },
  ],
})
export class AccessModule {}

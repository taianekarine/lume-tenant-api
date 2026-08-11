import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { ListPermissionsUseCase } from '../../application/use-cases/access/list-permissions.use-case';
import { assertCanAccessUserCatalog } from '../../domain/access/user-management-policy';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';

@ApiTags('Permissões')
@ApiBearerAuth()
@Controller()
export class AccessController {
  constructor(private readonly listPermissions: ListPermissionsUseCase) {}

  @Get('permissions')
  @RequireAnyPermission(
    'users:view',
    'users:create',
    'users:update',
    'users:manage',
  )
  @ApiOkResponse({
    description: 'Catálogo de permissões compatível com o front-end.',
  })
  permissions(@CurrentUser() current: AuthenticatedPrincipal) {
    assertCanAccessUserCatalog(current);
    return this.listPermissions.execute();
  }
}

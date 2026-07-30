import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { ListPermissionsUseCase } from '../../application/use-cases/access/list-permissions.use-case';
import { forbidden } from '../../core/errors/app-error';
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
    if (!current.departments.includes('management')) {
      throw forbidden(
        'O catálogo de permissões administrativas é restrito ao departamento Gerência.',
      );
    }
    return this.listPermissions.execute();
  }
}

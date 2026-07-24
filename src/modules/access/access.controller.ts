import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import {
  CreateRoleUseCase,
  DeleteRoleUseCase,
  ListPermissionsUseCase,
  ListRolesUseCase,
  UpdateRoleUseCase,
} from '../../application/use-cases/access/roles.use-cases';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import { CreateRoleDto, UpdateRoleDto } from './dto/roles.dto';

@ApiTags('Papéis e permissões')
@ApiBearerAuth()
@Controller()
export class AccessController {
  constructor(
    private readonly listRoles: ListRolesUseCase,
    private readonly createRole: CreateRoleUseCase,
    private readonly updateRole: UpdateRoleUseCase,
    private readonly deleteRole: DeleteRoleUseCase,
    private readonly listPermissions: ListPermissionsUseCase,
  ) {}

  @Get('roles')
  @RequireAnyPermission('users:manage', 'settings:view', 'settings:manage')
  @ApiOkResponse({ description: 'Papéis da empresa autenticada.' })
  roles(@CurrentUser() current: AuthenticatedPrincipal) {
    return this.listRoles.execute(current.companyId);
  }

  @Post('roles')
  @RequireAnyPermission('settings:manage')
  @ApiCreatedResponse({ description: 'Papel personalizado criado.' })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateRoleDto,
  ) {
    return this.createRole.execute({ ...body, companyId: current.companyId });
  }

  @Patch('roles/:id')
  @RequireAnyPermission('settings:manage')
  @ApiOkResponse({ description: 'Papel personalizado atualizado.' })
  update(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) roleId: string,
    @Body() body: UpdateRoleDto,
  ) {
    return this.updateRole.execute({
      ...body,
      companyId: current.companyId,
      roleId,
    });
  }

  @Delete('roles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireAnyPermission('settings:manage')
  @ApiNoContentResponse({
    description: 'Papel personalizado sem vínculos excluído.',
  })
  async remove(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) roleId: string,
  ): Promise<void> {
    await this.deleteRole.execute(current.companyId, roleId);
  }

  @Get('permissions')
  @RequireAnyPermission('settings:view', 'settings:manage')
  @ApiOkResponse({
    description: 'Catálogo de permissões compatível com o front-end.',
  })
  permissions() {
    return this.listPermissions.execute();
  }
}

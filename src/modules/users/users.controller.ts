import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { normalizeUserDepartment } from '../../domain/access/access.constants';
import { forbidden } from '../../core/errors/app-error';
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
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  CreateUserDto,
  ChangeOwnPasswordDto,
  ListUsersQueryDto,
  UpdateProfilePictureDto,
  UpdateUserStatusDto,
  UpdateUserDto,
} from './dto/users.dto';

function assertManagementAccess(current: AuthenticatedPrincipal): void {
  if (!current.departments.includes('management')) {
    throw forbidden(
      'A gestão de usuários é restrita ao departamento Gerência.',
    );
  }
}

@ApiTags('Usuários')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly createUser: CreateUserUseCase,
    private readonly listUsers: ListUsersUseCase,
    private readonly getUser: GetUserUseCase,
    private readonly updateUser: UpdateUserUseCase,
    private readonly updateUserStatus: UpdateUserStatusUseCase,
    private readonly changeOwnPassword: ChangeOwnPasswordUseCase,
    private readonly requestPasswordReset: RequestAdminPasswordResetUseCase,
    private readonly getProfile: GetProfileUseCase,
    private readonly updateProfilePicture: UpdateProfilePictureUseCase,
  ) {}

  @Post()
  @RequireAnyPermission('users:create')
  @ApiCreatedResponse({
    description: 'Usuário interno criado na empresa autenticada.',
  })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateUserDto,
  ) {
    assertManagementAccess(current);
    return this.createUser.execute({
      ...body,
      companyId: current.companyId,
      actorUserId: current.id,
    });
  }

  @Get()
  @RequireAnyPermission(
    'users:view',
    'users:create',
    'users:update',
    'users:manage',
  )
  @ApiOkResponse({
    description: 'Lista paginada de usuários da empresa autenticada.',
  })
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListUsersQueryDto,
  ) {
    assertManagementAccess(current);
    return this.listUsers.execute(current.companyId, {
      ...query,
      department: query.department
        ? normalizeUserDepartment(query.department)
        : undefined,
    });
  }

  @Get('me/profile')
  @RequireAnyPermission('profile:view', 'profile:update')
  @ApiOkResponse({ description: 'Perfil do usuário autenticado.' })
  profile(@CurrentUser() current: AuthenticatedPrincipal) {
    return this.getProfile.execute(current.companyId, current.id);
  }

  @Put('me/profile-picture')
  @RequireAnyPermission('profile:update')
  @ApiOkResponse({ description: 'Foto do perfil atualizada ou removida.' })
  profilePicture(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: UpdateProfilePictureDto,
  ) {
    return this.updateProfilePicture.execute({
      companyId: current.companyId,
      userId: current.id,
      dataUrl: body.dataUrl ?? null,
    });
  }

  @Patch('me/password')
  @RequireAnyPermission('profile:update')
  @ApiOkResponse({
    description: 'Senha alterada; sessões existentes revogadas.',
  })
  password(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: ChangeOwnPasswordDto,
  ) {
    return this.changeOwnPassword.execute({
      companyId: current.companyId,
      userId: current.id,
      ...body,
    });
  }

  @Get(':id')
  @RequireAnyPermission(
    'users:view',
    'users:create',
    'users:update',
    'users:manage',
  )
  @ApiOkResponse({ description: 'Usuário da empresa autenticada.' })
  get(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) userId: string,
  ) {
    assertManagementAccess(current);
    return this.getUser.execute(current.companyId, userId);
  }

  @Patch(':id')
  @RequireAnyPermission('users:update')
  @ApiOkResponse({ description: 'Usuário e vínculos atualizados.' })
  update(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() body: UpdateUserDto,
  ) {
    assertManagementAccess(current);
    return this.updateUser.execute({
      ...body,
      companyId: current.companyId,
      currentUserId: current.id,
      actorUserId: current.id,
      userId,
    });
  }

  @Patch(':id/status')
  @RequireAnyPermission('users:manage')
  @ApiOkResponse({
    description:
      'Status atualizado; sessões revogadas e suspensão temporal registrada.',
  })
  status(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() body: UpdateUserStatusDto,
  ) {
    assertManagementAccess(current);
    return this.updateUserStatus.execute({
      companyId: current.companyId,
      actorUserId: current.id,
      currentUserId: current.id,
      userId,
      status: body.status,
      suspendedUntil: body.suspendedUntil
        ? new Date(body.suspendedUntil)
        : body.suspensionDays
          ? new Date(Date.now() + body.suspensionDays * 86_400_000)
          : undefined,
      suspensionReason: body.suspensionReason,
    });
  }

  @Post(':id/password-reset')
  @RequireAnyPermission('users:update')
  @ApiOkResponse({ description: 'E-mail de criação de nova senha solicitado.' })
  resetPassword(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) userId: string,
  ) {
    assertManagementAccess(current);
    return this.requestPasswordReset.execute({
      companyId: current.companyId,
      actorUserId: current.id,
      userId,
    });
  }
}

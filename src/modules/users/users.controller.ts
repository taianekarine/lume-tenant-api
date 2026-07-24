import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { CreateUserUseCase } from '../../application/use-cases/users/create-user.use-case';
import { GetUserUseCase } from '../../application/use-cases/users/get-user.use-case';
import { ListUsersUseCase } from '../../application/use-cases/users/list-users.use-case';
import { UpdateUserUseCase } from '../../application/use-cases/users/update-user.use-case';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  CreateUserDto,
  ListUsersQueryDto,
  UpdateUserDto,
} from './dto/users.dto';

@ApiTags('Usuários')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(
    private readonly createUser: CreateUserUseCase,
    private readonly listUsers: ListUsersUseCase,
    private readonly getUser: GetUserUseCase,
    private readonly updateUser: UpdateUserUseCase,
  ) {}

  @Post()
  @RequireAnyPermission('users:manage')
  @ApiCreatedResponse({
    description: 'Usuário interno criado na empresa autenticada.',
  })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateUserDto,
  ) {
    return this.createUser.execute({
      ...body,
      companyId: current.companyId,
      actorUserId: current.id,
    });
  }

  @Get()
  @RequireAnyPermission('users:view', 'users:manage')
  @ApiOkResponse({
    description: 'Lista paginada de usuários da empresa autenticada.',
  })
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListUsersQueryDto,
  ) {
    return this.listUsers.execute(current.companyId, query);
  }

  @Get(':id')
  @RequireAnyPermission('users:view', 'users:manage')
  @ApiOkResponse({ description: 'Usuário da empresa autenticada.' })
  get(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) userId: string,
  ) {
    return this.getUser.execute(current.companyId, userId);
  }

  @Patch(':id')
  @RequireAnyPermission('users:manage')
  @ApiOkResponse({ description: 'Usuário e vínculos atualizados.' })
  update(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('id', new ParseUUIDPipe({ version: '4' })) userId: string,
    @Body() body: UpdateUserDto,
  ) {
    return this.updateUser.execute({
      ...body,
      companyId: current.companyId,
      currentUserId: current.id,
      actorUserId: current.id,
      userId,
    });
  }
}

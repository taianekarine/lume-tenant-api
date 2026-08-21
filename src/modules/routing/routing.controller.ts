import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { RoutingCompaniesUseCase } from '../../application/use-cases/routing/routing-companies.use-case';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  CreateRoutingCompanyDto,
  ListRoutingCompaniesQueryDto,
  RoutingCompanyCommentDto,
  UpdateRoutingCompanyDto,
} from './dto/routing-company.dto';

@ApiTags('Clientes')
@ApiBearerAuth()
@Controller('clients')
export class RoutingController {
  constructor(private readonly companies: RoutingCompaniesUseCase) {}

  @Post()
  @RequireAnyPermission('clients:create')
  @ApiCreatedResponse({ description: 'Cliente cadastrado.' })
  createCompany(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateRoutingCompanyDto,
  ) {
    return this.companies.create(current, body);
  }

  @Get()
  @RequireAnyPermission('clients:view')
  listCompanies(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListRoutingCompaniesQueryDto,
  ) {
    return this.companies.list(current, query);
  }

  @Get(':routingCompanyId')
  @RequireAnyPermission('clients:view')
  getCompany(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
  ) {
    return this.companies.get(current, routingCompanyId);
  }

  @Patch(':routingCompanyId')
  @RequireAnyPermission('clients:update')
  updateCompany(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
    @Body() body: UpdateRoutingCompanyDto,
  ) {
    return this.companies.update(current, routingCompanyId, body);
  }

  @Get(':routingCompanyId/history')
  @RequireAnyPermission('clients:history')
  companyHistory(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
  ) {
    return this.companies.history(current, routingCompanyId);
  }

  @Get(':routingCompanyId/comments')
  @RequireAnyPermission('clients:view')
  companyComments(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
  ) {
    return this.companies.comments(current, routingCompanyId);
  }

  @Post(':routingCompanyId/comments')
  @RequireAnyPermission('clients:update')
  addCompanyComment(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
    @Body() body: RoutingCompanyCommentDto,
  ) {
    return this.companies.addComment(current, routingCompanyId, body);
  }

  @Patch(':routingCompanyId/comments/:commentId')
  @RequireAnyPermission('clients:update')
  updateCompanyComment(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
    @Param('commentId', new ParseUUIDPipe({ version: '4' })) commentId: string,
    @Body() body: RoutingCompanyCommentDto,
  ) {
    return this.companies.updateComment(
      current,
      routingCompanyId,
      commentId,
      body,
    );
  }

  @Delete(':routingCompanyId/comments/:commentId')
  @RequireAnyPermission('clients:update')
  removeCompanyComment(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
    @Param('commentId', new ParseUUIDPipe({ version: '4' })) commentId: string,
    @Query('commandId', new ParseUUIDPipe({ version: '4' })) commandId: string,
  ) {
    return this.companies.removeComment(
      current,
      routingCompanyId,
      commentId,
      commandId,
    );
  }
}

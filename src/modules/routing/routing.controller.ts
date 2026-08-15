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
  DeleteRoutingCompanyDto,
  ListRoutingCompaniesQueryDto,
  UpdateRoutingCompanyDto,
} from './dto/routing-company.dto';

@ApiTags('RoteirizaÃ§Ã£o')
@ApiBearerAuth()
@Controller('routing')
export class RoutingController {
  constructor(private readonly companies: RoutingCompaniesUseCase) {}

  @Post('companies')
  @RequireAnyPermission('routing-companies:create')
  @ApiCreatedResponse({ description: 'Empresa cliente cadastrada.' })
  createCompany(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateRoutingCompanyDto,
  ) {
    return this.companies.create(current, body);
  }

  @Get('companies')
  @RequireAnyPermission('routing-companies:view')
  listCompanies(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListRoutingCompaniesQueryDto,
  ) {
    return this.companies.list(current, query);
  }

  @Get('companies/:routingCompanyId')
  @RequireAnyPermission('routing-companies:view')
  getCompany(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
  ) {
    return this.companies.get(current, routingCompanyId);
  }

  @Patch('companies/:routingCompanyId')
  @RequireAnyPermission('routing-companies:update')
  updateCompany(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
    @Body() body: UpdateRoutingCompanyDto,
  ) {
    return this.companies.update(current, routingCompanyId, body);
  }

  @Delete('companies/:routingCompanyId')
  @RequireAnyPermission('routing-companies:manage')
  deleteCompany(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
    @Body() body: DeleteRoutingCompanyDto,
  ) {
    return this.companies.delete(current, routingCompanyId, body);
  }

  @Get('companies/:routingCompanyId/history')
  @RequireAnyPermission('routing-companies:view')
  companyHistory(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routingCompanyId', new ParseUUIDPipe({ version: '4' }))
    routingCompanyId: string,
  ) {
    return this.companies.history(current, routingCompanyId);
  }
}

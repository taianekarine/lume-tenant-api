import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { FixedPointsUseCase } from '../../application/use-cases/routing/fixed-points.use-case';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  CreateFixedPointDto,
  ListFixedPointsQueryDto,
} from './dto/fixed-point.dto';

@ApiTags('Roteirizacao - pontos fixos')
@ApiBearerAuth()
@Controller('routing/fixed-points')
export class RoutingFixedPointsController {
  constructor(private readonly points: FixedPointsUseCase) {}

  @Post()
  @RequireAnyPermission('routing-contracts:create', 'routes:update')
  @ApiCreatedResponse({ description: 'Ponto fixo cadastrado.' })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateFixedPointDto,
  ) {
    return this.points.create(current, {
      commandId: body.commandId,
      name: body.name,
      routingCompanyId: body.routingCompanyId ?? null,
      address: {
        street: body.address.street,
        number: body.address.number,
        complement: body.address.complement ?? null,
        district: body.address.district,
        postalCode: body.address.postalCode,
        city: body.address.city,
        state: body.address.state,
        latitude: body.address.latitude ?? null,
        longitude: body.address.longitude ?? null,
      },
    });
  }

  @Get()
  @RequireAnyPermission(
    'routing-contracts:view',
    'routes:view',
    'passengers:import',
  )
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListFixedPointsQueryDto,
  ) {
    return this.points.list(current, query);
  }
}

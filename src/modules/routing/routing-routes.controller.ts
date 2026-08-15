import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { RoutesUseCase } from '../../application/use-cases/routing/routes.use-case';
import type { RouteData } from '../../domain/routing/route';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import { RouteExportService } from '../../infra/routing/route-export.service';
import {
  ApproveRouteDto,
  EditRoutePlanDto,
  GenerateContractRoutesDto,
  ListRoutesQueryDto,
  RouteCommandDto,
  TransitionRouteDto,
  UpdateRouteDto,
} from './dto/route.dto';

@ApiTags('Roteirizacao - rotas')
@ApiBearerAuth()
@Controller('routing')
export class RoutingRoutesController {
  constructor(
    private readonly routes: RoutesUseCase,
    private readonly exports: RouteExportService,
  ) {}

  @Post('contracts/:contractId/generate-routes')
  @RequireAnyPermission('routes:use')
  @ApiCreatedResponse({ description: 'Rotas sugeridas a partir do contrato.' })
  generate(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('contractId', new ParseUUIDPipe({ version: '4' }))
    contractId: string,
    @Body() body: GenerateContractRoutesDto,
  ) {
    return this.routes.generateFromContract(current, contractId, {
      ...body,
      serviceDate: new Date(`${body.serviceDate}T00:00:00.000Z`),
    });
  }

  @Get('routes')
  @RequireAnyPermission('routes:view')
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListRoutesQueryDto,
  ) {
    return this.routes.list(current, query);
  }

  @Get('routes/:routeId')
  @RequireAnyPermission('routes:view')
  get(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
  ) {
    return this.routes.get(current, routeId);
  }

  @Patch('routes/:routeId')
  @RequireAnyPermission('routes:update')
  update(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Body() body: UpdateRouteDto,
  ) {
    const {
      commandId,
      expectedVersion,
      reason,
      validFrom,
      validUntil,
      origin,
      destination,
      ...scalars
    } = body;
    const data: Partial<Omit<RouteData, 'routingCompanyId' | 'contractId'>> = {
      ...scalars,
      ...(validFrom
        ? { validFrom: new Date(`${validFrom}T00:00:00.000Z`) }
        : {}),
      ...(validUntil !== undefined
        ? {
            validUntil: validUntil
              ? new Date(`${validUntil}T00:00:00.000Z`)
              : null,
          }
        : {}),
      ...(origin
        ? {
            origin: {
              ...origin,
              complement: origin.complement ?? null,
              latitude: origin.latitude ?? null,
              longitude: origin.longitude ?? null,
            },
          }
        : {}),
      ...(destination
        ? {
            destination: {
              ...destination,
              complement: destination.complement ?? null,
              latitude: destination.latitude ?? null,
              longitude: destination.longitude ?? null,
            },
          }
        : {}),
    };
    return this.routes.updateBase(current, routeId, {
      ...data,
      commandId,
      expectedVersion,
      reason,
    });
  }

  @Post('routes/:routeId/recalculate')
  @RequireAnyPermission('routes:use')
  recalculate(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Body() body: RouteCommandDto,
  ) {
    return this.routes.recalculate(current, routeId, body);
  }

  @Patch('routes/:routeId/plan')
  @RequireAnyPermission('routes:update')
  editPlan(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Body() body: EditRoutePlanDto,
  ) {
    return this.routes.editPlan(current, routeId, {
      ...body,
      points: body.points.map((point) => ({
        ...point,
        scheduledTime: point.scheduledTime ?? null,
        address: {
          ...point.address,
          complement: point.address.complement ?? null,
          latitude: point.address.latitude ?? null,
          longitude: point.address.longitude ?? null,
        },
      })),
      assignments: body.assignments.map((assignment) => ({
        ...assignment,
        pointId: assignment.pointId ?? null,
        walkingDistanceMeters: assignment.walkingDistanceMeters ?? null,
        boardingOrder: assignment.boardingOrder ?? null,
      })),
    });
  }

  @Post('routes/:routeId/transition')
  @RequireAnyPermission('routes:update')
  transition(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Body() body: TransitionRouteDto,
  ) {
    return this.routes.transition(current, routeId, body);
  }

  @Post('routes/:routeId/approve')
  @RequireAnyPermission('routes:approve')
  approve(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Body() body: ApproveRouteDto,
  ) {
    return this.routes.approve(current, routeId, body);
  }

  @Post('routes/:routeId/publish')
  @RequireAnyPermission('routes:publish')
  publish(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Body() body: RouteCommandDto,
  ) {
    return this.routes.publish(current, routeId, body);
  }

  @Get('routes/:routeId/history')
  @RequireAnyPermission('routes:view')
  history(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
  ) {
    return this.routes.history(current, routeId);
  }

  @Get('routes/:routeId/export.pdf')
  @RequireAnyPermission('routes:export')
  async exportPdf(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const context = await this.routes.approvedExportContext(current, routeId);
    const content = this.exports.operationalPdf(context);
    response.setHeader('Content-Type', 'application/pdf');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="rota-${routeId}.pdf"`,
    );
    return new StreamableFile(content);
  }

  @Get('routes/:routeId/export.xlsx')
  @RequireAnyPermission('routes:export')
  async exportXlsx(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const context = await this.routes.approvedExportContext(current, routeId);
    const content = await this.exports.operationalXlsx(context);
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="rota-${routeId}.xlsx"`,
    );
    return new StreamableFile(content);
  }

  @Get('routes/:routeId/my-maps.xlsx')
  @RequireAnyPermission('routes:export')
  async myMapsXlsx(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const context = await this.routes.approvedExportContext(current, routeId);
    const content = await this.exports.myMapsXlsx(context);
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="google-my-maps-${routeId}.xlsx"`,
    );
    return new StreamableFile(content);
  }

  @Get('routes/:routeId/my-maps.csv')
  @RequireAnyPermission('routes:export')
  async myMapsCsv(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('routeId', new ParseUUIDPipe({ version: '4' })) routeId: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const context = await this.routes.approvedExportContext(current, routeId);
    const content = this.exports.myMapsCsv(context);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="google-my-maps-${routeId}.csv"`,
    );
    return new StreamableFile(content);
  }
}

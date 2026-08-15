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
import { ApiBearerAuth, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import {
  presentContract,
  RoutingContractsUseCase,
} from '../../application/use-cases/routing/routing-contracts.use-case';
import type { ContractData } from '../../domain/routing/contract';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';
import {
  CreateRoutingContractDto,
  ListRoutingContractsQueryDto,
  UpdateRoutingContractDto,
} from './dto/routing-contract.dto';

function mapContractData(body: CreateRoutingContractDto): ContractData {
  return {
    ...body,
    predictedVehicleReference: body.predictedVehicleReference ?? null,
    contractedKm: body.contractedKm ?? null,
    plannedKm: body.plannedKm ?? null,
    origin: {
      ...body.origin,
      complement: body.origin.complement ?? null,
      latitude: body.origin.latitude ?? null,
      longitude: body.origin.longitude ?? null,
    },
    destination: {
      ...body.destination,
      complement: body.destination.complement ?? null,
      latitude: body.destination.latitude ?? null,
      longitude: body.destination.longitude ?? null,
    },
    validFrom: new Date(`${body.validFrom}T00:00:00.000Z`),
    validUntil: body.validUntil
      ? new Date(`${body.validUntil}T00:00:00.000Z`)
      : null,
    notes: body.notes ?? null,
    costCenters: body.costCenters.map((costCenter) => ({
      code: costCenter.code,
      name: costCenter.name ?? null,
    })),
    shifts: body.shifts.map((shift) => ({
      name: shift.name,
      requiredArrivalTime: shift.requiredArrivalTime,
      vehicleCount: shift.vehicleCount ?? null,
      vehicleCapacity: shift.vehicleCapacity ?? null,
      activeWeekdays: shift.activeWeekdays,
    })),
  };
}

@ApiTags('Roteirizacao - contratos')
@ApiBearerAuth()
@Controller('routing/contracts')
export class RoutingContractsController {
  constructor(private readonly contracts: RoutingContractsUseCase) {}

  @Post()
  @RequireAnyPermission('routing-contracts:create')
  @ApiCreatedResponse({ description: 'Contrato operacional cadastrado.' })
  create(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Body() body: CreateRoutingContractDto,
  ) {
    return this.contracts.create(current, {
      ...mapContractData(body),
      commandId: body.commandId,
    });
  }

  @Get()
  @RequireAnyPermission('routing-contracts:view')
  list(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Query() query: ListRoutingContractsQueryDto,
  ) {
    return this.contracts.list(current, query);
  }

  @Get(':contractId')
  @RequireAnyPermission('routing-contracts:view')
  async get(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('contractId', new ParseUUIDPipe({ version: '4' }))
    contractId: string,
  ) {
    return presentContract(await this.contracts.get(current, contractId));
  }

  @Patch(':contractId')
  @RequireAnyPermission('routing-contracts:update')
  update(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('contractId', new ParseUUIDPipe({ version: '4' }))
    contractId: string,
    @Body() body: UpdateRoutingContractDto,
  ) {
    const { commandId, expectedVersion, reason, ...data } = body;
    const {
      validFrom,
      validUntil,
      origin,
      destination,
      costCenters,
      shifts,
      ...scalarData
    } = data;
    const mapped: Partial<ContractData> = {
      ...scalarData,
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
      ...(costCenters
        ? {
            costCenters: costCenters.map((costCenter) => ({
              code: costCenter.code,
              name: costCenter.name ?? null,
            })),
          }
        : {}),
      ...(shifts
        ? {
            shifts: shifts.map((shift) => ({
              name: shift.name,
              requiredArrivalTime: shift.requiredArrivalTime,
              vehicleCount: shift.vehicleCount ?? null,
              vehicleCapacity: shift.vehicleCapacity ?? null,
              activeWeekdays: shift.activeWeekdays,
            })),
          }
        : {}),
    };
    return this.contracts.update(current, contractId, {
      ...mapped,
      commandId,
      expectedVersion,
      reason,
    });
  }

  @Get(':contractId/history')
  @RequireAnyPermission('routing-contracts:view')
  history(
    @CurrentUser() current: AuthenticatedPrincipal,
    @Param('contractId', new ParseUUIDPipe({ version: '4' }))
    contractId: string,
  ) {
    return this.contracts.history(current, contractId);
  }
}

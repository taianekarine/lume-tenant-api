import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  ROUTE_STATUSES,
  type RouteAssignmentStatus,
  type RoutePointOrigin,
  type RouteStatus,
} from '../../../domain/routing/route';
import { RoutingAddressDto } from './routing-contract.dto';

export class GenerateContractRoutesDto {
  @IsUUID('4')
  commandId!: string;

  @IsDateString({ strict: true })
  serviceDate!: string;

  @IsOptional()
  @IsUUID('4')
  shiftId?: string;
}

export class ListRoutesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @IsOptional()
  @IsUUID('4')
  routingCompanyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  search?: string;

  @IsOptional()
  @IsIn(ROUTE_STATUSES)
  status?: RouteStatus;
}

export class UpdateRouteDto {
  @IsUUID('4')
  commandId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  shift?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  requiredArrivalTime?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => RoutingAddressDto)
  origin?: RoutingAddressDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RoutingAddressDto)
  destination?: RoutingAddressDto;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  predictedVehicleReference?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  predictedVehicleName?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  predictedVehicleCapacity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxWalkingDistanceMeters?: number;

  @IsOptional()
  @IsDateString({ strict: true })
  validFrom?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  validUntil?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class RoutePointDto {
  @IsUUID('4')
  id!: string;

  @IsIn(['outbound', 'return'])
  direction: 'outbound' | 'return' = 'outbound';

  @Type(() => Number)
  @IsInt()
  @Min(1)
  sequence!: number;

  @ValidateNested()
  @Type(() => RoutingAddressDto)
  address!: RoutingAddressDto;

  @IsIn(['company', 'agent', 'operations'])
  origin!: RoutePointOrigin;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  scheduledTime?: string | null;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  alerts: string[] = [];
}

export class RouteAssignmentDto {
  @IsUUID('4')
  id!: string;

  @IsUUID('4')
  passengerId!: string;

  @IsOptional()
  @IsUUID('4')
  pointId?: string | null;

  @IsIn(['assigned', 'overflow', 'pending-data', 'pending-documents'])
  status!: RouteAssignmentStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  walkingDistanceMeters?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  boardingOrder?: number | null;

  @IsIn(['company', 'agent', 'operations'])
  origin!: RoutePointOrigin;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  warnings: string[] = [];
}

export class EditRoutePlanDto {
  @IsUUID('4')
  commandId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique((point: RoutePointDto) => point.id)
  @ValidateNested({ each: true })
  @Type(() => RoutePointDto)
  points!: RoutePointDto[];

  @IsArray()
  @ArrayMaxSize(10_000)
  @ArrayUnique((assignment: RouteAssignmentDto) => assignment.passengerId)
  @ValidateNested({ each: true })
  @Type(() => RouteAssignmentDto)
  assignments!: RouteAssignmentDto[];
}

export class RouteCommandDto {
  @IsUUID('4')
  commandId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class TransitionRouteDto extends RouteCommandDto {
  @IsIn(['in-review', 'pending-approval', 'routed'])
  status!: 'in-review' | 'pending-approval' | 'routed';
}

export class ApproveRouteDto extends RouteCommandDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

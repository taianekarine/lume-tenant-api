import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
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
  CONTRACT_PERIODICITIES,
  CONTRACT_STATUSES,
  type ContractPeriodicity,
  type ContractStatus,
} from '../../../domain/routing/contract';
import type { RouteType } from '../../../domain/routing/route';

export class RoutingAddressDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  label!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  street!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(30)
  number!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  complement?: string | null;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  district!: string;

  @Matches(/^\D*\d(?:\D*\d){7}\D*$/)
  postalCode!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  city!: string;

  @Matches(/^[A-Za-z]{2}$/)
  state!: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number | null;
}

export class ContractCostCenterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string | null;
}

export class ContractShiftDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  requiredArrivalTime!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  vehicleCount?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  vehicleCapacity?: number | null;

  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  activeWeekdays: number[] = [];
}

export class RoutingContractDataDto {
  @IsUUID('4')
  routingCompanyId!: string;

  @IsOptional()
  @IsUUID('4')
  originFixedPointId?: string | null;

  @IsOptional()
  @IsUUID('4')
  destinationFixedPointId?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  operationType!: string;

  @IsIn(['municipal', 'intermunicipal'])
  routeType!: RouteType;

  @IsIn(CONTRACT_STATUSES)
  status: ContractStatus = 'draft';

  @IsIn(CONTRACT_PERIODICITIES)
  periodicity!: ContractPeriodicity;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  contractedVehicleCount!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  predictedVehicleName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  predictedVehicleReference?: string | null;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  predictedVehicleCapacity!: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  contractedKm?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  plannedKm?: number | null;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxWalkingDistanceMeters!: number;

  @IsBoolean()
  requiresDocumentation = false;

  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @Matches(/^[a-z][a-z0-9-]{2,79}$/, { each: true })
  requiredDocumentTypeCodes: string[] = [];

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  unitName!: string;

  @ValidateNested()
  @Type(() => RoutingAddressDto)
  origin!: RoutingAddressDto;

  @ValidateNested()
  @Type(() => RoutingAddressDto)
  destination!: RoutingAddressDto;

  @IsDateString({ strict: true })
  validFrom!: string;

  @IsOptional()
  @IsDateString({ strict: true })
  validUntil?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiProperty({ type: [ContractCostCenterDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ContractCostCenterDto)
  costCenters!: ContractCostCenterDto[];

  @ApiProperty({ type: [ContractShiftDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ContractShiftDto)
  shifts!: ContractShiftDto[];
}

export class CreateRoutingContractDto extends RoutingContractDataDto {
  @IsUUID('4')
  commandId!: string;
}

export class UpdateRoutingContractDto extends PartialType(
  RoutingContractDataDto,
) {
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

export class ListRoutingContractsQueryDto {
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
  @IsIn(CONTRACT_STATUSES)
  status?: ContractStatus;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  search?: string;
}

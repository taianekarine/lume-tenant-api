import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { RoutingAddressDto } from './routing-contract.dto';

export class CreateFixedPointDto {
  @IsUUID('4')
  commandId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsUUID('4')
  routingCompanyId?: string | null;

  @ValidateNested()
  @Type(() => RoutingAddressDto)
  address!: RoutingAddressDto;
}

export class ListFixedPointsQueryDto {
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
  pageSize = 100;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  search?: string;

  @IsOptional()
  @IsUUID('4')
  routingCompanyId?: string;

  @IsOptional()
  @IsUUID('4')
  routeId?: string;

  @IsOptional()
  @IsIn(['active', 'inactive'])
  status?: 'active' | 'inactive';
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
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
} from 'class-validator';

import {
  ROUTING_COMPANY_STATUSES,
  type RoutingCompanyStatus,
} from '../../../domain/routing/routing-company';

export class CreateRoutingCompanyDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  commandId!: string;

  @ApiProperty({ example: '12.345.678/0001-95' })
  @Matches(/^\D*\d(?:\D*\d){13}\D*$/)
  taxId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  legalName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  tradeName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  costCenter?: string;
}

export class UpdateRoutingCompanyDto {
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
  legalName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  tradeName?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  costCenter?: string | null;

  @IsOptional()
  @IsIn(ROUTING_COMPANY_STATUSES)
  status?: RoutingCompanyStatus;
}

export class ListRoutingCompaniesQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsIn(ROUTING_COMPANY_STATUSES)
  status?: RoutingCompanyStatus;
}

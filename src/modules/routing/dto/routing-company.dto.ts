import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import {
  ROUTING_CLIENT_STATUSES,
  ROUTING_CLIENT_TYPES,
  type RoutingClientStatus,
  type RoutingClientType,
} from '../../../domain/routing/routing-company';

class RoutingPhoneDto {
  @IsString() @MaxLength(30) number!: string;
  @IsOptional() @IsString() @MaxLength(80) description?: string | null;
}

class RoutingCompanyFieldsDto {
  @IsIn(ROUTING_CLIENT_TYPES) clientType!: RoutingClientType;
  @IsOptional() @IsIn(ROUTING_CLIENT_STATUSES) status?: RoutingClientStatus;
  @IsOptional() @IsString() @MaxLength(160) avicExternalId?: string | null;
  @IsOptional() @IsString() @MaxLength(160) individualName?: string | null;
  @IsOptional() @IsString() @MaxLength(20) cpf?: string | null;
  @IsOptional() @IsString() @MaxLength(254) individualEmail?: string | null;
  @IsOptional() @IsString() @MaxLength(30) individualWhatsapp?: string | null;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoutingPhoneDto)
  individualPhones?: RoutingPhoneDto[];
  @IsOptional() @IsString() @MaxLength(160) legalName?: string | null;
  @IsOptional() @IsString() @MaxLength(120) tradeName?: string | null;
  @IsOptional() @IsString() @MaxLength(20) cnpj?: string | null;
  @IsOptional() @IsString() @MaxLength(254) legalEmail?: string | null;
  @IsOptional() @IsString() @MaxLength(30) legalWhatsapp?: string | null;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoutingPhoneDto)
  legalPhones?: RoutingPhoneDto[];
  @IsOptional() @IsString() @MaxLength(120) costCenter?: string | null;
}

export class CreateRoutingCompanyDto extends RoutingCompanyFieldsDto {
  @IsUUID('4') commandId!: string;
}

export class UpdateRoutingCompanyDto extends RoutingCompanyFieldsDto {
  @IsUUID('4') commandId!: string;
  @Type(() => Number) @IsInt() @Min(1) expectedVersion!: number;
}

export class RoutingCompanyCommentDto {
  @IsUUID('4') commandId!: string;
  @IsString() @MaxLength(4000) comment!: string;
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
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(ROUTING_CLIENT_STATUSES) status?: RoutingClientStatus;
  @IsOptional() @IsIn(ROUTING_CLIENT_TYPES) clientType?: RoutingClientType;
  @IsOptional() @IsIn(['name', 'status', 'avic']) sort?:
    'name' | 'status' | 'avic';
}

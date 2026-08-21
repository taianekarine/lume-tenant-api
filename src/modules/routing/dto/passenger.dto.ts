import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsObject,
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
  PASSENGER_STATUSES,
  type PassengerStatus,
} from '../../../domain/routing/passenger';

export class PassengerAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  street?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  number?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  complement?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string | null;

  @IsOptional()
  @Matches(/^\D*\d(?:\D*\d){7}\D*$/)
  postalCode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string | null;

  @IsOptional()
  @Matches(/^[A-Za-z]{2}$/)
  state?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number | null;
}

export class PassengerBoardingPointDto extends PassengerAddressDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  label?: string | null;
}

export class PassengerDocumentDataDto {
  @Matches(/^[a-z][a-z0-9-]{2,79}$/)
  documentTypeCode!: string;

  @IsObject()
  data!: Readonly<Record<string, unknown>>;
}

export class CreatePassengerDto {
  @IsUUID('4')
  commandId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  routingCompanyId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  shift?: string;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  requiredArrivalTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sector?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName!: string;

  @IsBoolean()
  accessibilityRequired = false;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  accessibilityNotes?: string;

  @ApiProperty({ type: PassengerAddressDto })
  @ValidateNested()
  @Type(() => PassengerAddressDto)
  residence!: PassengerAddressDto;

  @ApiPropertyOptional({ type: PassengerBoardingPointDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerBoardingPointDto)
  predefinedBoardingPoint?: PassengerBoardingPointDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique(
    (document: PassengerDocumentDataDto) => document.documentTypeCode,
  )
  @ValidateNested({ each: true })
  @Type(() => PassengerDocumentDataDto)
  documents?: PassengerDocumentDataDto[];
}

export class UpdatePassengerDto {
  @IsUUID('4')
  commandId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalReference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  shift?: string | null;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  requiredArrivalTime?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sector?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName?: string;

  @IsOptional()
  @IsBoolean()
  accessibilityRequired?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  accessibilityNotes?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerAddressDto)
  residence?: PassengerAddressDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerBoardingPointDto)
  predefinedBoardingPoint?: PassengerBoardingPointDto | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique(
    (document: PassengerDocumentDataDto) => document.documentTypeCode,
  )
  @ValidateNested({ each: true })
  @Type(() => PassengerDocumentDataDto)
  documents?: PassengerDocumentDataDto[];
}

export class ListPassengersQueryDto {
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
  @IsIn(PASSENGER_STATUSES)
  status?: PassengerStatus;

  @IsOptional()
  @IsIn(['ready', 'pending'])
  registrationStatus?: 'ready' | 'pending';
}

export class ChangePassengerStatusDto {
  @IsUUID('4')
  commandId!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;

  @IsIn(PASSENGER_STATUSES)
  status!: PassengerStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ImportPassengersDto {
  @IsUUID('4')
  commandId!: string;

  @IsOptional()
  @IsUUID('4')
  routeId?: string;

  @IsOptional()
  @IsUUID('4')
  routingCompanyId?: string;
}

export class ResolvePassengerImportAddressDto {
  @IsUUID('4')
  commandId!: string;

  @Matches(/^\D*\d(?:\D*\d){7}\D*$/)
  postalCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(30)
  number!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  complement?: string | null;
}

export class ResolvePassengerImportDataDto {
  @IsUUID('4')
  commandId!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalReference?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  shift?: string | null;

  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  requiredArrivalTime?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  sector?: string | null;

  @IsOptional()
  @IsBoolean()
  accessibilityRequired?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  accessibilityNotes?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerAddressDto)
  residence?: PassengerAddressDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique(
    (document: PassengerDocumentDataDto) => document.documentTypeCode,
  )
  @ValidateNested({ each: true })
  @Type(() => PassengerDocumentDataDto)
  documents?: PassengerDocumentDataDto[];
}

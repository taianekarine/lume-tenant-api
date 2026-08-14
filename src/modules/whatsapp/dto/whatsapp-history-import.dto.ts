import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { IMPORT_DEPARTMENT_CODES } from '../../../infra/imports/whatsapp-import.types';
import { WHATSAPP_HISTORY_STATE_OPTIONS } from '../../../infra/imports/whatsapp-export-workbook';

export class CreateWhatsAppHistoryImportDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  channelId!: string;
}

export class UpdateWhatsAppHistoryMappingDto {
  @ApiProperty({ example: '5534999999999' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\D/g, '') : value,
  )
  @Matches(/^\d{10,15}$/)
  phoneE164!: string;

  @ApiProperty({ minLength: 1, maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  contactName!: string;

  @ApiProperty({ minLength: 1, maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  companySenderName!: string;

  @ApiProperty({ enum: WHATSAPP_HISTORY_STATE_OPTIONS })
  @IsIn(WHATSAPP_HISTORY_STATE_OPTIONS)
  state!: (typeof WHATSAPP_HISTORY_STATE_OPTIONS)[number];

  @ApiProperty({ enum: IMPORT_DEPARTMENT_CODES })
  @IsIn(IMPORT_DEPARTMENT_CODES)
  departmentCode!: (typeof IMPORT_DEPARTMENT_CODES)[number];

  @ApiPropertyOptional({ nullable: true, maxLength: 80 })
  @IsOptional()
  @ValidateIf((_object, value: unknown) => value != null && value !== '')
  @IsString()
  @MaxLength(80)
  ownerUsername?: string | null;
}

export class ApplyWhatsAppHistoryImportDto {
  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  cutoffAt!: string;
}

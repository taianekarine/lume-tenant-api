import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
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

export const WHATSAPP_IMPORT_DIVERGENCE_RESOLUTIONS = [
  'keep-existing',
  'use-backup',
] as const;

export class ResolveWhatsAppImportDivergenceDto {
  @ApiProperty({ enum: WHATSAPP_IMPORT_DIVERGENCE_RESOLUTIONS })
  @IsIn(WHATSAPP_IMPORT_DIVERGENCE_RESOLUTIONS)
  resolution!: (typeof WHATSAPP_IMPORT_DIVERGENCE_RESOLUTIONS)[number];
}

export class AddWhatsAppAndroidBackupDto {
  @ApiProperty({
    description: 'Chave crypt15 hexadecimal. Nunca é persistida.',
    minLength: 64,
    maxLength: 64,
  })
  @IsString()
  @Matches(/^[0-9a-fA-F]{64}$/)
  rootKey!: string;

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

export class CreateWhatsAppAndroidMediaUploadDto {
  @ApiProperty({ minLength: 1, maxLength: 255, example: 'Media.zip' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;

  @ApiProperty({ minimum: 22, maximum: 8_589_934_592 })
  @IsInt()
  @Min(22)
  @Max(8_589_934_592)
  sizeBytes!: number;
}

export class AddWhatsAppAndroidMediaChunkDto {
  @ApiProperty({ minimum: 0 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt()
  @Min(0)
  offsetBytes!: number;
}

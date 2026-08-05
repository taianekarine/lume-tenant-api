import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  DOCUMENT_REQUEST_CONTEXTS,
  DOCUMENT_REQUEST_STATUSES,
  type DocumentRequestContext,
  type DocumentRequestStatus,
  type DocumentRequirement,
} from '../../../domain/documents/document-workflow';

export class CreateDocumentTypeDto {
  @Matches(/^[a-z][a-z0-9-]{2,79}$/)
  code!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(['application/pdf', 'image/jpeg', 'image/png'], { each: true })
  acceptedMimeTypes: string[] = ['application/pdf', 'image/jpeg', 'image/png'];

  @Type(() => Number)
  @IsInt()
  @Min(1024)
  @Max(25 * 1024 * 1024)
  maxFileSizeBytes = 10 * 1024 * 1024;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  minFiles = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  maxFiles = 1;

  @IsBoolean()
  allowsMultiplePages = false;

  @IsBoolean()
  requiresFrontBack = false;

  @IsBoolean()
  expires = false;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36500)
  defaultValidityDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  renewalLeadDays?: number;

  @IsBoolean()
  requiresOriginal = false;

  @IsOptional()
  @IsObject()
  extractionSchema?: Readonly<Record<string, unknown>>;
}

export class CreateChecklistItemDto {
  @IsUUID('4')
  documentTypeId!: string;

  @IsIn(['required', 'optional', 'conditional'])
  requirement!: DocumentRequirement;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructions?: string;

  @IsOptional()
  @IsObject()
  condition?: Readonly<Record<string, unknown>>;

  @IsOptional()
  @IsObject()
  configOverrides?: Readonly<Record<string, unknown>>;
}

export class CreateChecklistDto {
  @Matches(/^[a-z][a-z0-9-]{2,79}$/)
  code!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsIn(DOCUMENT_REQUEST_CONTEXTS)
  context!: DocumentRequestContext;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateChecklistItemDto)
  items!: CreateChecklistItemDto[];
}

export class CreateDocumentRequestDto {
  @IsUUID('4')
  commandId!: string;

  @IsUUID('4')
  subjectUserId!: string;

  @IsUUID('4')
  checklistId!: string;

  @IsIn(DOCUMENT_REQUEST_CONTEXTS)
  context!: DocumentRequestContext;

  @IsOptional()
  @IsDateString()
  deadline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ListDocumentRequestsQueryDto {
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
  @IsIn(DOCUMENT_REQUEST_STATUSES)
  status?: DocumentRequestStatus;

  @IsOptional()
  @IsIn(DOCUMENT_REQUEST_CONTEXTS)
  context?: DocumentRequestContext;

  @IsOptional()
  @IsUUID('4')
  subjectUserId?: string;
}

export class UploadDocumentSubmissionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  commandId!: string;

  @ApiPropertyOptional({
    description: 'Lista separada por vírgulas: single, front, back ou page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  sides?: string;

  @ApiPropertyOptional({
    description: 'Números de página separados por vírgulas.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  pageNumbers?: string;
}

export class AddDocumentRequestItemDto {
  @IsUUID('4')
  documentTypeId!: string;

  @IsIn(['required', 'optional'])
  requirement!: 'required' | 'optional';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  instructions?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class SetDocumentRequestItemPolicyDto {
  @IsIn(['required', 'optional', 'waived'])
  policy!: 'required' | 'optional' | 'waived';

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class ReviewDocumentSubmissionDto {
  @IsUUID('4')
  commandId!: string;

  @IsIn(['approved', 'rejected', 'resubmission-required'])
  decision!: 'approved' | 'rejected' | 'resubmission-required';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsObject()
  correctedFields?: Readonly<Record<string, unknown>>;

  @IsOptional()
  @IsObject()
  confirmedFields?: Readonly<Record<string, unknown>>;

  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @IsOptional()
  @IsIn(['not-required', 'pending', 'confirmed', 'divergent'])
  originalCheckStatus?: 'not-required' | 'pending' | 'confirmed' | 'divergent';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  originalObservation?: string;
}

export class UpdateExtractedFieldsDto {
  @IsObject()
  fields!: Readonly<Record<string, unknown>>;

  @IsOptional()
  @IsObject()
  confidences?: Readonly<Record<string, unknown>>;
}

export class ExpiringDocumentsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  withinDays = 90;
}

export class RenewDocumentDto {
  @IsUUID('4')
  commandId!: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { DEPARTMENTS } from '../../../domain/access/access.constants';
import {
  CONVERSATION_STATES,
  MESSAGE_KINDS,
  TRANSITION_NAMES,
} from '../../../domain/whatsapp/whatsapp.constants';

export class VersionedCommandDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class TransitionConversationDto extends VersionedCommandDto {
  @ApiProperty({ enum: TRANSITION_NAMES })
  @IsIn(TRANSITION_NAMES)
  name!: (typeof TRANSITION_NAMES)[number];

  @ApiPropertyOptional({ enum: DEPARTMENTS })
  @IsOptional()
  @IsIn(DEPARTMENTS)
  targetDepartment?: (typeof DEPARTMENTS)[number];

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ForwardConversationDto extends VersionedCommandDto {
  @ApiProperty({ enum: DEPARTMENTS })
  @IsIn(DEPARTMENTS)
  targetDepartment!: (typeof DEPARTMENTS)[number];
}

export class PatchQuoteRequestDto extends VersionedCommandDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\D/g, '') : value,
  )
  @Matches(/^\d{11}$|^\d{14}$/)
  document?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsString()
  @MaxLength(120)
  serviceType?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsString()
  @MaxLength(300)
  origin?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsString()
  @MaxLength(300)
  destination?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsISO8601({ strict: true })
  departureAt?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsISO8601({ strict: true })
  returnAt?: string | null;

  @ApiPropertyOptional({ minimum: 1, maximum: 500, nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsInt()
  @Min(1)
  @Max(500)
  passengerCount?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsString()
  @MaxLength(120)
  vehicleType?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsBoolean()
  vehicleAtDisposal?: boolean | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsBoolean()
  localTransfers?: boolean | null;

  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsString()
  @MaxLength(4000)
  notes?: string | null;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  structuredData?: Record<string, unknown>;
}

export class CreateOutboundMessageDto extends VersionedCommandDto {
  @ApiProperty({
    enum: [true],
    description:
      'Este endpoint pertence ao n8n e sempre cria conteúdo automático.',
  })
  @IsIn([true])
  automatic!: true;

  @ApiPropertyOptional({ enum: ['main-menu'] })
  @IsOptional()
  @IsIn(['main-menu'])
  purpose?: 'main-menu';

  @ApiProperty({ enum: MESSAGE_KINDS })
  @IsIn(MESSAGE_KINDS)
  kind!: (typeof MESSAGE_KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  text?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  media?: Record<string, unknown>;
}

export class CreateHumanOutboundMessageDto extends VersionedCommandDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Chave estável para impedir mensagens humanas duplicadas.',
  })
  @IsUUID()
  idempotencyKey!: string;

  @ApiProperty({ maxLength: 10_000 })
  @IsString()
  @MaxLength(10_000)
  text!: string;
}

export class ClaimEvolutionDispatchDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  attemptId!: string;

  @ApiPropertyOptional({ enum: ['confirmed-not-sent'] })
  @IsOptional()
  @IsIn(['confirmed-not-sent'])
  reconciliation?: 'confirmed-not-sent';
}

export class EvolutionResultDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  attemptId!: string;

  @ApiProperty({ enum: ['sent', 'delivered', 'read', 'failed'] })
  @IsIn(['sent', 'delivered', 'read', 'failed'])
  status!: 'sent' | 'delivered' | 'read' | 'failed';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  providerMessageId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  errorCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
}

export class CompleteOutboxExecutionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  executionId!: string;

  @ApiProperty({ example: 'whatsapp-conversation' })
  @IsString()
  @MaxLength(60)
  aggregateType!: string;

  @ApiProperty({ maxLength: 100 })
  @IsString()
  @MaxLength(100)
  aggregateId!: string;

  @ApiProperty({
    enum: ['succeeded', 'retryable-failure', 'terminal-failure'],
  })
  @IsIn(['succeeded', 'retryable-failure', 'terminal-failure'])
  outcome!: 'succeeded' | 'retryable-failure' | 'terminal-failure';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  errorCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  errorMessage?: string;
}

export class ConversationListQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;

  @ApiPropertyOptional({ enum: CONVERSATION_STATES })
  @IsOptional()
  @IsIn(CONVERSATION_STATES)
  state?: (typeof CONVERSATION_STATES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  search?: string;
}

export class MessageListQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 50;
}

export class TransitionListQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 50;
}

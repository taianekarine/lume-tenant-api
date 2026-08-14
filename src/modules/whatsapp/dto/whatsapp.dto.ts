import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
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
  MinLength,
  ValidateIf,
} from 'class-validator';

import { DEPARTMENTS } from '../../../domain/access/access.constants';
import {
  CONVERSATION_STATES,
  MESSAGE_KINDS,
  REQUEST_STATUSES,
  TRANSITION_NAMES,
} from '../../../domain/whatsapp/whatsapp.constants';

export class VersionedCommandDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiProperty({ minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class CloseConversationDto extends VersionedCommandDto {
  @ApiPropertyOptional({
    nullable: true,
    minLength: 3,
    maxLength: 500,
    description:
      'Motivo operacional do encerramento. É obrigatório quando a proposta mais recente foi recusada, salvo se a decisão já possuir motivo.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || null : value,
  )
  @ValidateIf((_object, value: unknown) => value != null)
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string | null;
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

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-08-01',
    nullable: true,
  })
  @ValidateIf((_object, value: unknown) => value != null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  departureDate?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @ValidateIf((_object, value: unknown) => value != null)
  @IsISO8601({ strict: true })
  returnAt?: string | null;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-08-02',
    nullable: true,
  })
  @ValidateIf((_object, value: unknown) => value != null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  returnDate?: string | null;

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
    description: 'Este endpoint interno sempre cria conteúdo automático.',
  })
  @IsIn([true])
  automatic!: true;

  @ApiPropertyOptional({
    enum: [
      'main-menu',
      'commercial-follow-up-menu',
      'department-notification',
      'unsupported-message-kind',
    ],
  })
  @IsOptional()
  @IsIn([
    'main-menu',
    'commercial-follow-up-menu',
    'department-notification',
    'unsupported-message-kind',
  ])
  purpose?:
    | 'main-menu'
    | 'commercial-follow-up-menu'
    | 'department-notification'
    | 'unsupported-message-kind';

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Obrigatório somente para unsupported-message-kind; identifica o inbound não textual respondido.',
  })
  @IsOptional()
  @IsUUID()
  inReplyToMessageId?: string;

  @ApiPropertyOptional({
    description:
      'Destinatário alternativo permitido apenas para notificações internas de departamento.',
    example: '5534991711373',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\D/g, '') : value,
  )
  @Matches(/^\d{10,15}$/)
  recipientPhone?: string;

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

export class CreateHumanOutboundMediaDto extends VersionedCommandDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  idempotencyKey!: string;

  @ApiPropertyOptional({ maxLength: 10_000 })
  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  caption?: string;

  @ApiPropertyOptional({ enum: ['auto', 'sticker'] })
  @IsOptional()
  @IsIn(['auto', 'sticker'])
  mediaKind?: 'auto' | 'sticker';
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

  @ApiPropertyOptional({
    type: [String],
    maxItems: 50,
    description:
      'Eventos inbound persistidos que foram incorporados ao mesmo lote durável.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  consumedSourceEventIds?: string[];

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

export class ReconcileAutomationOutboxDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  commandId!: string;

  @ApiProperty({
    enum: [
      'confirmed-sent',
      'confirmed-not-sent',
      'confirmed-processed',
      'confirmed-not-processed',
    ],
  })
  @IsIn([
    'confirmed-sent',
    'confirmed-not-sent',
    'confirmed-processed',
    'confirmed-not-processed',
  ])
  resolution!:
    | 'confirmed-sent'
    | 'confirmed-not-sent'
    | 'confirmed-processed'
    | 'confirmed-not-processed';

  @ApiProperty({ minLength: 10, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  evidence!: string;

  @ApiPropertyOptional({
    maxLength: 160,
    description:
      'Identificador confirmado no provedor. Obrigatório quando o envio foi confirmado.',
  })
  @ValidateIf(
    (object: ReconcileAutomationOutboxDto) =>
      object.resolution === 'confirmed-sent',
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  providerMessageId?: string;
}

export class AutomationBatchQueryDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  sourceEventId!: string;

  @ApiProperty({ minimum: 1, maximum: 300 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  windowSeconds!: number;
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

  @ApiPropertyOptional({ enum: DEPARTMENTS })
  @IsOptional()
  @IsIn(DEPARTMENTS)
  department?: (typeof DEPARTMENTS)[number];

  @ApiPropertyOptional({ enum: CONVERSATION_STATES })
  @IsOptional()
  @IsIn(CONVERSATION_STATES)
  state?: (typeof CONVERSATION_STATES)[number];

  @ApiPropertyOptional({
    enum: REQUEST_STATUSES,
    description:
      'Status do processo comercial. Quando informado, a fila é obrigatoriamente Comercial.',
  })
  @IsOptional()
  @IsIn(REQUEST_STATUSES)
  requestStatus?: (typeof REQUEST_STATUSES)[number];

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

  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  search?: string;
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

export class QuoteProposalListQueryDto {
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

  @ApiPropertyOptional({
    default: 'pending',
    enum: ['pending', 'sent', 'approved', 'cancelled'],
    description:
      'Separa fila pendente, propostas enviadas aguardando retorno, aprovadas e canceladas/recusadas.',
  })
  @IsOptional()
  @IsIn(['pending', 'sent', 'approved', 'cancelled'])
  stage: 'pending' | 'sent' | 'approved' | 'cancelled' = 'pending';

  @ApiPropertyOptional({
    maxLength: 160,
    description:
      'Busca por cliente, telefone, origem, destino ou nome do arquivo.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsString()
  @MaxLength(160)
  search?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Restringe a consulta aos orçamentos vinculados a uma conversa.',
  })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  createdFrom?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  createdTo?: string;
}

export class UploadQuoteProposalDocumentDto extends VersionedCommandDto {}

export class CreateQuoteProposalDto extends VersionedCommandDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId!: string;

  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MaxLength(160)
  contactName!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === ''
      ? null
      : typeof value === 'string'
        ? value.replace(/\D/g, '')
        : value,
  )
  @ValidateIf((_object, value: unknown) => value != null)
  @Matches(/^\d{11}$|^\d{14}$/)
  document?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  @ValidateIf((_object, value: unknown) => value != null)
  @IsEmail()
  @MaxLength(254)
  email?: string | null;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @MaxLength(120)
  serviceType!: string;

  @ApiProperty({ maxLength: 300 })
  @IsString()
  @MaxLength(300)
  origin!: string;

  @ApiProperty({ maxLength: 300 })
  @IsString()
  @MaxLength(300)
  destination!: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  @ValidateIf((_object, value: unknown) => value != null)
  @IsISO8601()
  departureAt?: string | null;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-08-01',
    nullable: true,
    description:
      'Data conhecida da viagem. Pode existir sem horário enquanto departureAt estiver nulo.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  @ValidateIf((_object, value: unknown) => value != null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  departureDate?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  @ValidateIf((_object, value: unknown) => value != null)
  @IsISO8601()
  returnAt?: string | null;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-08-02',
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  @ValidateIf((_object, value: unknown) => value != null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  returnDate?: string | null;

  @ApiProperty({ minimum: 1, maximum: 1000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  passengerCount!: number;

  @ApiPropertyOptional({ nullable: true, maxLength: 120 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  @ValidateIf((_object, value: unknown) => value != null)
  @IsString()
  @MaxLength(120)
  vehicleType?: string | null;

  @ApiProperty()
  @IsBoolean()
  vehicleAtDisposal!: boolean;

  @ApiProperty()
  @IsBoolean()
  localTransfers!: boolean;

  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? null : value,
  )
  @ValidateIf((_object, value: unknown) => value != null)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class DecideQuoteProposalDto extends VersionedCommandDto {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  @IsIn(['approved', 'rejected'])
  decision!: 'approved' | 'rejected';

  @ApiPropertyOptional({ nullable: true, maxLength: 500 })
  @ValidateIf(
    (object: DecideQuoteProposalDto) => object.decision === 'rejected',
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string | null;
}

export class UpdateQuoteProposalStatusDto extends VersionedCommandDto {
  @ApiProperty({
    enum: [
      'waiting-for-customer',
      'under-review',
      'approved',
      'rejected',
      'cancelled',
    ],
  })
  @IsIn([
    'waiting-for-customer',
    'under-review',
    'approved',
    'rejected',
    'cancelled',
  ])
  status!:
    | 'waiting-for-customer'
    | 'under-review'
    | 'approved'
    | 'rejected'
    | 'cancelled';

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 500,
    description:
      'Obrigatório para os status recusado e cancelado; fica registrado na auditoria.',
  })
  @ValidateIf(
    (object: UpdateQuoteProposalStatusDto) =>
      object.status === 'rejected' || object.status === 'cancelled',
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason?: string | null;
}

export class SendQuoteProposalDto extends VersionedCommandDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  proposalDocumentId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  batchId!: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: 10,
    description:
      'Lista ordenada e estável de todos os documentos que compõem o lote.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  batchDocumentIds!: string[];
}

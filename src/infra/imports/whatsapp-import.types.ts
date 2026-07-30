export const WHATSAPP_IMPORT_TABLES = {
  conversations: 'AtendimentosImportacao',
  messages: 'MensagensImportacao',
  documents: 'DocumentosImportacao',
} as const;

export const CONVERSATION_HEADERS = [
  'external_conversation_id',
  'source_system',
  'phone_e164',
  'contact_name',
  'channel_phone_e164',
  'department_code',
  'owner_username',
  'conversation_state',
  'flow_step',
  'request_status',
  'last_interaction_at',
  'last_message_preview',
  'unread_count',
  'quote_sequence',
  'quote_contact_name',
  'quote_document',
  'quote_email',
  'service_type',
  'trip_type',
  'origin',
  'destination',
  'departure_at',
  'return_at',
  'passenger_count',
  'vehicle_type',
  'vehicle_at_disposal',
  'local_transfers',
  'transfer_details',
  'notes',
  'confirmed_at',
  'decision_reason',
  'decided_at',
  'migration_action',
  'validation_status',
  'validation_message',
] as const;

export const MESSAGE_HEADERS = [
  'external_conversation_id',
  'external_message_id',
  'direction',
  'kind',
  'occurred_at',
  'delivery_status',
  'text',
  'media_reference',
  'actor_username',
  'provider_message_id',
  'correlation_id',
  'validation_status',
  'validation_message',
] as const;

export const DOCUMENT_HEADERS = [
  'external_conversation_id',
  'quote_sequence',
  'external_document_id',
  'file_name',
  'relative_file_path',
  'mime_type',
  'document_status',
  'sent_at',
  'provider_message_id',
  'sha256',
  'validation_status',
  'validation_message',
] as const;

export const IMPORT_DEPARTMENT_CODES = [
  'commercial',
  'purchasing',
  'controlling',
  'personnel-department',
  'financial',
  'management',
  'maintenance',
  'monitoring',
  'operations',
] as const;

export type ImportDepartmentCode = (typeof IMPORT_DEPARTMENT_CODES)[number];

export interface ConversationImportRow {
  rowNumber: number;
  externalConversationId: string;
  sourceSystem: string;
  phoneE164: string;
  contactName?: string;
  channelPhoneE164: string;
  departmentCode: string;
  ownerUsername?: string;
  conversationState: string;
  flowStep: string;
  requestStatus: string;
  lastInteractionAt: Date;
  lastMessagePreview?: string;
  unreadCount: number;
  quoteSequence?: number;
  quoteContactName?: string;
  quoteDocument?: string;
  quoteEmail?: string;
  serviceType?: string;
  tripType?: string;
  origin?: string;
  destination?: string;
  departureAt?: Date;
  returnAt?: Date;
  passengerCount?: number;
  vehicleType?: string;
  vehicleAtDisposal?: boolean;
  localTransfers?: boolean;
  transferDetails?: string;
  notes?: string;
  confirmedAt?: Date;
  decisionReason?: string;
  decidedAt?: Date;
  migrationAction: string;
}

export interface MessageImportRow {
  rowNumber: number;
  externalConversationId: string;
  externalMessageId: string;
  direction: string;
  kind: string;
  occurredAt: Date;
  deliveryStatus: string;
  text?: string;
  mediaReference?: string;
  actorUsername?: string;
  providerMessageId?: string;
  correlationId?: string;
}

export interface DocumentImportRow {
  rowNumber: number;
  externalConversationId: string;
  quoteSequence: number;
  externalDocumentId: string;
  fileName: string;
  relativeFilePath: string;
  mimeType: string;
  documentStatus: string;
  sentAt?: Date;
  providerMessageId?: string;
  expectedSha256?: string;
  absoluteFilePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ParsedWhatsAppImportPackage {
  packagePath: string;
  workbookPath: string;
  workbookSha256: string;
  packageSha256: string;
  conversations: ConversationImportRow[];
  messages: MessageImportRow[];
  documents: DocumentImportRow[];
}

export type ImportIssueSeverity = 'error' | 'warning';

export interface ImportIssue {
  severity: ImportIssueSeverity;
  table: 'package' | 'Atendimentos' | 'Mensagens' | 'Documentos' | 'database';
  rowNumber?: number;
  code: string;
  message: string;
}

export interface WhatsAppImportCounts {
  conversations: number;
  contactsToCreate: number;
  contactsToUpdate: number;
  conversationsToCreate: number;
  conversationsToUpdate: number;
  quoteRequestsToCreate: number;
  quoteRequestsToUpdate: number;
  messagesToCreate: number;
  messagesDuplicate: number;
  documentsToCreate: number;
  documentsDuplicate: number;
  byDepartment: Record<string, number>;
  byConversationState: Record<string, number>;
  byRequestStatus: Record<string, number>;
}

export interface WhatsAppImportValidationReport {
  schemaVersion: '1.0';
  mode: 'validate';
  valid: boolean;
  zeroWrites: true;
  companyId: string;
  channelId: string;
  batchName: string;
  actorUsername: string;
  packagePath: string;
  workbookPath?: string;
  workbookSha256?: string;
  packageSha256?: string;
  counts: WhatsAppImportCounts;
  issues: ImportIssue[];
  generatedAt: string;
}

export interface WhatsAppImportInput {
  companyId: string;
  channelId: string;
  actorUsername: string;
  batchName: string;
  packagePath: string;
  workbookPath?: string;
  cutoffAt?: Date;
}

export interface WhatsAppImportApplyInput extends WhatsAppImportInput {
  batchId: string;
  cutoffAt: Date;
  confirmation: string;
}

export interface WhatsAppImportRollbackInput {
  companyId: string;
  batchId: string;
  actorUsername: string;
  confirmation: string;
}

export function emptyImportCounts(): WhatsAppImportCounts {
  return {
    conversations: 0,
    contactsToCreate: 0,
    contactsToUpdate: 0,
    conversationsToCreate: 0,
    conversationsToUpdate: 0,
    quoteRequestsToCreate: 0,
    quoteRequestsToUpdate: 0,
    messagesToCreate: 0,
    messagesDuplicate: 0,
    documentsToCreate: 0,
    documentsDuplicate: 0,
    byDepartment: {},
    byConversationState: {},
    byRequestStatus: {},
  };
}

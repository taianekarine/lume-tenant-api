import type { Department } from '../../domain/access/access.constants';
import type {
  ConversationState,
  DeliveryStatus,
  MessageDirection,
  MessageKind,
  RequestStatus,
  TransitionName,
} from '../../domain/whatsapp/whatsapp.constants';

export interface WebhookChannelConfiguration {
  id: string;
  companyId: string;
  instanceName: string;
  webhookSecretHash: string;
  ignoreGroups: boolean;
  ignoreFromMe: boolean;
  enabled: boolean;
}

export interface PersistWebhookMessageInput {
  channel: WebhookChannelConfiguration;
  externalEventId: string;
  providerMessageId: string;
  correlationId: string;
  payloadHash: string;
  phoneNormalized: string;
  direction: MessageDirection;
  displayName?: string;
  profilePictureUrl?: string;
  occurredAt: Date;
  kind: MessageKind;
  text?: string;
  media?: Readonly<Record<string, unknown>>;
}

export interface PersistWebhookMessageResult {
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly messageId: string | null;
  readonly conversationId: string | null;
  readonly automationAllowed?: boolean;
  readonly canGenerateReply?: boolean;
  readonly canSendReply?: boolean;
  readonly isFirstContact?: boolean;
  readonly reopenedAfterClosure?: boolean;
  readonly version?: number;
}

export interface TransitionCommand {
  companyId: string;
  conversationId: string;
  commandId: string;
  expectedVersion: number;
  name: TransitionName;
  actorType: 'user' | 'webhook' | 'system';
  actorUserId?: string;
  targetDepartment?: Department;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface QuoteRequestPatch {
  commandId: string;
  expectedVersion: number;
  contactName?: string | null;
  document?: string | null;
  email?: string | null;
  serviceType?: string | null;
  origin?: string | null;
  destination?: string | null;
  departureDate?: Date | null;
  departureAt?: Date | null;
  returnDate?: Date | null;
  returnAt?: Date | null;
  passengerCount?: number | null;
  vehicleType?: string | null;
  vehicleAtDisposal?: boolean | null;
  localTransfers?: boolean | null;
  notes?: string | null;
  structuredData?: Readonly<Record<string, unknown>>;
}

export interface CreateOutboundInput {
  companyId: string;
  conversationId: string;
  commandId: string;
  expectedVersion: number;
  automatic: true;
  purpose?:
    | 'main-menu'
    | 'commercial-follow-up-menu'
    | 'department-notification'
    | 'unsupported-message-kind';
  inReplyToMessageId?: string;
  recipientPhone?: string;
  kind: MessageKind;
  text?: string;
  media?: Readonly<Record<string, unknown>>;
}

export interface CreateHumanOutboundInput {
  companyId: string;
  conversationId: string;
  commandId: string;
  idempotencyKey: string;
  expectedVersion: number;
  actorUserId: string;
  text?: string;
  attachment?: {
    messageId: string;
    kind: Extract<
      MessageKind,
      'image' | 'document' | 'audio' | 'video' | 'contact' | 'sticker'
    >;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    storageKey: string;
  };
}

export interface ClaimEvolutionDispatchInput {
  companyId: string;
  messageId: string;
  attemptId: string;
  commandId: string;
  ownerId: string;
  reconciliation?: 'confirmed-not-sent';
}

export interface EvolutionResultInput {
  companyId: string;
  messageId: string;
  commandId: string;
  attemptId: string;
  status: Exclude<DeliveryStatus, 'received' | 'pending'>;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface MarkEvolutionDispatchUnknownInput {
  companyId: string;
  messageId: string;
  attemptId: string;
  ownerId: string;
  errorCode: string;
  errorMessage: string;
}

export interface CompleteOutboxExecutionInput {
  companyId: string;
  eventId: string;
  commandId: string;
  executionId: string;
  automationProvider?: 'api';
  aggregateType: string;
  aggregateId: string;
  outcome: 'succeeded' | 'retryable-failure' | 'terminal-failure';
  consumedSourceEventIds?: string[];
  errorCode?: string;
  errorMessage?: string;
}

export type AutomationOutboxReconciliationResolution =
  | 'confirmed-sent'
  | 'confirmed-not-sent'
  | 'confirmed-processed'
  | 'confirmed-not-processed';

export interface ReconcileAutomationOutboxInput {
  companyId: string;
  eventId: string;
  commandId: string;
  resolution: AutomationOutboxReconciliationResolution;
  evidence: string;
  providerMessageId?: string;
  serviceIdentityId: string;
  serviceIdentityName: string;
}

export interface ConversationListQuery {
  page: number;
  pageSize: number;
  department?: Department;
  state?: ConversationState;
  control?: 'bot' | 'human' | 'paused' | 'closed';
  requestStatus?: RequestStatus;
  search?: string;
}

export interface EnsureWhatsAppConversationResult {
  readonly id: string;
  readonly version: number;
  readonly conversationState: ConversationState;
  readonly assignedTo: { readonly id: string; readonly name: string } | null;
}

export interface MessageListQuery {
  page: number;
  pageSize: number;
  search?: string;
}

export interface TransitionListQuery {
  page: number;
  pageSize: number;
}

export interface QuoteProposalListQuery {
  page: number;
  pageSize: number;
  stage: 'pending' | 'sent' | 'approved' | 'cancelled';
  search?: string;
  conversationId?: string;
  createdFrom?: string;
  createdTo?: string;
}

export interface QuoteProposalNotificationSummary {
  notificationId: 'commercial.pending-quote-proposals';
  pendingTotal: number;
  unreadTotal: number;
}

export interface QuoteProposalPdf {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
}

export interface UploadQuoteProposalDocumentInput {
  companyId: string;
  quoteRequestId: string;
  actorUserId: string;
  commandId: string;
  expectedVersion: number;
  file: QuoteProposalPdf;
}

export interface SendQuoteProposalInput {
  companyId: string;
  quoteRequestId: string;
  proposalDocumentId: string;
  batchId: string;
  batchDocumentIds: string[];
  actorUserId: string;
  commandId: string;
  expectedVersion: number;
}

export interface CreateQuoteProposalInput {
  companyId: string;
  conversationId: string;
  actorUserId: string;
  commandId: string;
  expectedVersion: number;
  contactName: string;
  document?: string | null;
  email?: string | null;
  serviceType: string;
  origin: string;
  destination: string;
  departureDate?: Date | null;
  departureAt?: Date | null;
  returnDate?: Date | null;
  returnAt?: Date | null;
  passengerCount: number;
  vehicleType?: string | null;
  vehicleAtDisposal: boolean;
  localTransfers: boolean;
  notes?: string | null;
}

export interface DecideQuoteProposalInput {
  companyId: string;
  quoteRequestId: string;
  actorUserId: string;
  commandId: string;
  expectedVersion: number;
  decision: 'approved' | 'rejected';
  reason?: string | null;
}

export type ManuallyAssignableQuoteStatus =
  | 'waiting-for-customer'
  | 'under-review'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export interface UpdateQuoteProposalStatusInput {
  companyId: string;
  quoteRequestId: string;
  actorUserId: string;
  commandId: string;
  expectedVersion: number;
  status: ManuallyAssignableQuoteStatus;
  reason?: string | null;
}

export abstract class WhatsAppRepository {
  abstract findWebhookChannel(
    channelId: string,
  ): Promise<WebhookChannelConfiguration | null>;
  abstract persistWebhookMessage(
    input: PersistWebhookMessageInput,
  ): Promise<PersistWebhookMessageResult>;
  abstract transition(input: TransitionCommand): Promise<unknown>;
  abstract ensureConversationForPhone(
    companyId: string,
    phoneNormalized: string,
  ): Promise<EnsureWhatsAppConversationResult>;
  abstract patchQuoteRequest(
    companyId: string,
    quoteRequestId: string,
    input: QuoteRequestPatch,
  ): Promise<unknown>;
  abstract createOutbound(input: CreateOutboundInput): Promise<unknown>;
  abstract createHumanOutbound(
    input: CreateHumanOutboundInput,
  ): Promise<unknown>;
  abstract claimEvolutionDispatch(
    input: ClaimEvolutionDispatchInput,
  ): Promise<unknown>;
  abstract recordEvolutionResult(input: EvolutionResultInput): Promise<unknown>;
  abstract markEvolutionDispatchUnknown(
    input: MarkEvolutionDispatchUnknownInput,
  ): Promise<unknown>;
  abstract completeOutboxExecution(
    input: CompleteOutboxExecutionInput,
  ): Promise<unknown>;
  abstract reconcileAutomationOutbox(
    input: ReconcileAutomationOutboxInput,
  ): Promise<unknown>;
  abstract listConversations(
    companyId: string,
    query: ConversationListQuery,
  ): Promise<unknown>;
  abstract getConversation(
    companyId: string,
    conversationId: string,
  ): Promise<unknown>;
  abstract getAutomationBatch(
    companyId: string,
    conversationId: string,
    sourceEventId: string,
    windowSeconds: number,
  ): Promise<unknown>;
  abstract listMessages(
    companyId: string,
    conversationId: string,
    query: MessageListQuery,
  ): Promise<unknown>;
  abstract listTransitions(
    companyId: string,
    conversationId: string,
    query: TransitionListQuery,
  ): Promise<unknown>;
  abstract getCurrentQuoteRequest(
    companyId: string,
    conversationId: string,
  ): Promise<unknown>;
  abstract listQuoteProposals(
    companyId: string,
    query: QuoteProposalListQuery,
  ): Promise<unknown>;
  abstract getQuoteProposalNotificationSummary(
    companyId: string,
    userId: string,
  ): Promise<QuoteProposalNotificationSummary>;
  abstract markQuoteProposalNotificationRead(
    companyId: string,
    userId: string,
  ): Promise<
    QuoteProposalNotificationSummary & {
      readAt: string;
      markedRead: number;
    }
  >;
  abstract getQuoteProposal(
    companyId: string,
    quoteRequestId: string,
  ): Promise<unknown>;
  abstract createQuoteProposal(
    input: CreateQuoteProposalInput,
  ): Promise<unknown>;
  abstract decideQuoteProposal(
    input: DecideQuoteProposalInput,
  ): Promise<unknown>;
  abstract updateQuoteProposalStatus(
    input: UpdateQuoteProposalStatusInput,
  ): Promise<unknown>;
  abstract uploadQuoteProposalDocument(
    input: UploadQuoteProposalDocumentInput,
  ): Promise<unknown>;
  abstract sendQuoteProposal(input: SendQuoteProposalInput): Promise<unknown>;
  abstract getQuoteProposalDocument(
    companyId: string,
    documentId: string,
  ): Promise<unknown>;
}

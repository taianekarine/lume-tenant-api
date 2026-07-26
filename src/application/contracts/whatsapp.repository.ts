import type { Department } from '../../domain/access/access.constants';
import type {
  DeliveryStatus,
  MessageKind,
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

export interface PersistInboundInput {
  channel: WebhookChannelConfiguration;
  externalEventId: string;
  providerMessageId: string;
  correlationId: string;
  payloadHash: string;
  phoneNormalized: string;
  displayName?: string;
  occurredAt: Date;
  kind: MessageKind;
  text?: string;
  media?: Readonly<Record<string, unknown>>;
}

export interface TransitionCommand {
  companyId: string;
  conversationId: string;
  commandId: string;
  expectedVersion: number;
  name: TransitionName;
  actorType: 'user' | 'n8n' | 'webhook' | 'system';
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
  departureAt?: Date | null;
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
  purpose?: 'main-menu';
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
  text: string;
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

export interface CompleteOutboxExecutionInput {
  companyId: string;
  eventId: string;
  commandId: string;
  executionId: string;
  aggregateType: string;
  aggregateId: string;
  outcome: 'succeeded' | 'retryable-failure' | 'terminal-failure';
  errorCode?: string;
  errorMessage?: string;
}

export interface ConversationListQuery {
  page: number;
  pageSize: number;
  state?: string;
  search?: string;
}

export interface MessageListQuery {
  page: number;
  pageSize: number;
}

export interface TransitionListQuery {
  page: number;
  pageSize: number;
}

export abstract class WhatsAppRepository {
  abstract findWebhookChannel(
    channelId: string,
  ): Promise<WebhookChannelConfiguration | null>;
  abstract persistInbound(input: PersistInboundInput): Promise<unknown>;
  abstract transition(input: TransitionCommand): Promise<unknown>;
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
  abstract completeOutboxExecution(
    input: CompleteOutboxExecutionInput,
  ): Promise<unknown>;
  abstract listConversations(
    companyId: string,
    query: ConversationListQuery,
  ): Promise<unknown>;
  abstract getConversation(
    companyId: string,
    conversationId: string,
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
}

import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  WhatsAppRepository,
  type ClaimEvolutionDispatchInput,
  type CompleteOutboxExecutionInput,
  type ConversationListQuery,
  type CreateHumanOutboundInput,
  type CreateOutboundInput,
  type CreateQuoteProposalInput,
  type DecideQuoteProposalInput,
  type EvolutionResultInput,
  type MarkEvolutionDispatchUnknownInput,
  type MessageListQuery,
  type PersistInboundInput,
  type PersistInboundResult,
  type QuoteProposalListQuery,
  type QuoteRequestPatch,
  type ReconcileAutomationOutboxInput,
  type SendQuoteProposalInput,
  type TransitionCommand,
  type TransitionListQuery,
  type UpdateQuoteProposalStatusInput,
  type UploadQuoteProposalDocumentInput,
  type WebhookChannelConfiguration,
} from '../../../application/contracts/whatsapp.repository';
import {
  AppError,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import type { Department } from '../../../domain/access/access.constants';
import {
  buildConversationClosureMessage,
  buildDepartmentContactClosureMessage,
} from '../../../domain/whatsapp/conversation-closure-message';
import {
  assertTransitionActor,
  resolveConversationTransition,
} from '../../../domain/whatsapp/conversation-transition.matrix';
import { validateQuoteProposalPdf } from '../../../domain/whatsapp/quote-proposal-pdf';
import {
  assertQuoteScheduleConsistency,
  dateOnlyFromDateTime,
  presentDateOnly,
} from '../../../domain/whatsapp/quote-schedule';
import { deterministicCommandId } from '../../../domain/whatsapp/whatsapp-automation-flow';
import type {
  ConversationSnapshot,
  ConversationState as CanonicalConversationState,
  DeliveryStatus as CanonicalDeliveryStatus,
  FlowStep as CanonicalFlowStep,
  MessageKind as CanonicalMessageKind,
  RequestStatus as CanonicalRequestStatus,
} from '../../../domain/whatsapp/whatsapp.constants';
import { UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT } from '../../../domain/whatsapp/whatsapp.constants';
import { sanitizeLogText } from '../../../shared/utils/sensitive-data';
import {
  ConversationState,
  DeliveryStatus,
  DepartmentCode,
  EvolutionDispatchState,
  FlowStep,
  IntegrationOutboxStatus,
  MessageAttemptStatus,
  MessageDirection,
  MessageKind,
  QuoteProposalDocumentStatus,
  RequestStatus,
  TransitionActorType,
  WhatsAppAutomationExecutionStatus,
  WhatsAppAutomationProvider,
  type Prisma,
} from '../prisma/generated/client';
import { PrismaService } from '../prisma/prisma.service';

const LEGACY_AUTOMATION_RECONCILIATION_REQUIRED =
  'LEGACY_AUTOMATION_RECONCILIATION_REQUIRED' as const;

const departmentToPrisma: Readonly<Record<Department, DepartmentCode>> = {
  'human-resources': DepartmentCode.HUMAN_RESOURCES,
  'personnel-department': DepartmentCode.PERSONNEL_DEPARTMENT,
  commercial: DepartmentCode.COMMERCIAL,
  purchasing: DepartmentCode.PURCHASING,
  controlling: DepartmentCode.CONTROLLING,
  maintenance: DepartmentCode.MAINTENANCE,
  monitoring: DepartmentCode.MONITORING,
  management: DepartmentCode.MANAGEMENT,
  operations: DepartmentCode.OPERATIONS,
  cleaning: DepartmentCode.CLEANING,
  financial: DepartmentCode.FINANCIAL,
  'information-technology': DepartmentCode.INFORMATION_TECHNOLOGY,
};

const departmentFromPrisma: Readonly<Record<DepartmentCode, Department>> = {
  HUMAN_RESOURCES: 'human-resources',
  PERSONNEL_DEPARTMENT: 'personnel-department',
  COMMERCIAL: 'commercial',
  PURCHASING: 'purchasing',
  CONTROLLING: 'controlling',
  MAINTENANCE: 'maintenance',
  MONITORING: 'monitoring',
  MANAGEMENT: 'management',
  OPERATIONS: 'operations',
  CLEANING: 'cleaning',
  FINANCIAL: 'financial',
  INFORMATION_TECHNOLOGY: 'information-technology',
};

const departmentContactLabels: Readonly<Partial<Record<Department, string>>> = {
  purchasing: 'Compras (Fornecedores)',
  controlling: 'Controladoria',
  'personnel-department': 'Departamento Pessoal',
  financial: 'Financeiro',
  management: 'Gerência',
  maintenance: 'Manutenção',
  monitoring: 'Monitoramento',
  operations: 'Operacional',
};

const stateToPrisma: Readonly<
  Record<CanonicalConversationState, ConversationState>
> = {
  'bot-active': ConversationState.BOT_ACTIVE,
  'waiting-for-customer': ConversationState.WAITING_FOR_CUSTOMER,
  'sent-to-human': ConversationState.SENT_TO_HUMAN,
  'human-active': ConversationState.HUMAN_ACTIVE,
  closed: ConversationState.CLOSED,
};

const stateFromPrisma: Readonly<
  Record<ConversationState, CanonicalConversationState>
> = {
  BOT_ACTIVE: 'bot-active',
  WAITING_FOR_CUSTOMER: 'waiting-for-customer',
  SENT_TO_HUMAN: 'sent-to-human',
  HUMAN_ACTIVE: 'human-active',
  CLOSED: 'closed',
};

const flowToPrisma: Readonly<Record<CanonicalFlowStep, FlowStep>> = {
  'main-menu': FlowStep.MAIN_MENU,
  'commercial-menu': FlowStep.COMMERCIAL_MENU,
  'quote-data-collection': FlowStep.QUOTE_DATA_COLLECTION,
  'quote-summary-confirmation': FlowStep.QUOTE_SUMMARY_CONFIRMATION,
  'quote-send-pending': FlowStep.QUOTE_SEND_PENDING,
  'commercial-follow-up-menu': FlowStep.COMMERCIAL_FOLLOW_UP_MENU,
  'human-service': FlowStep.HUMAN_SERVICE,
  closed: FlowStep.CLOSED,
};

const flowFromPrisma: Readonly<Record<FlowStep, CanonicalFlowStep>> = {
  MAIN_MENU: 'main-menu',
  COMMERCIAL_MENU: 'commercial-menu',
  QUOTE_DATA_COLLECTION: 'quote-data-collection',
  QUOTE_SUMMARY_CONFIRMATION: 'quote-summary-confirmation',
  QUOTE_SEND_PENDING: 'quote-send-pending',
  COMMERCIAL_FOLLOW_UP_MENU: 'commercial-follow-up-menu',
  HUMAN_SERVICE: 'human-service',
  CLOSED: 'closed',
};

const requestToPrisma: Readonly<Record<CanonicalRequestStatus, RequestStatus>> =
  {
    'not-started': RequestStatus.NOT_STARTED,
    'collecting-information': RequestStatus.COLLECTING_INFORMATION,
    'waiting-for-customer': RequestStatus.WAITING_FOR_CUSTOMER,
    'under-review': RequestStatus.UNDER_REVIEW,
    approved: RequestStatus.APPROVED,
    rejected: RequestStatus.REJECTED,
    cancelled: RequestStatus.CANCELLED,
  };

const requestFromPrisma: Readonly<
  Record<RequestStatus, CanonicalRequestStatus>
> = {
  NOT_STARTED: 'not-started',
  COLLECTING_INFORMATION: 'collecting-information',
  WAITING_FOR_CUSTOMER: 'waiting-for-customer',
  UNDER_REVIEW: 'under-review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
};

const COMMERCIAL_PENDING_QUOTES_NOTIFICATION =
  'commercial.pending-quote-proposals' as const;

function pendingQuoteProposalWhere(
  companyId: string,
): Prisma.QuoteRequestWhereInput {
  return {
    companyId,
    status: RequestStatus.UNDER_REVIEW,
    confirmedAt: { not: null },
    conversation: {
      department: DepartmentCode.COMMERCIAL,
      closedAt: null,
    },
  };
}

function quoteProposalStageWhere(
  companyId: string,
  stage: QuoteProposalListQuery['stage'],
): Prisma.QuoteRequestWhereInput {
  if (stage === 'pending') {
    return pendingQuoteProposalWhere(companyId);
  }

  const commercialConversation = {
    department: DepartmentCode.COMMERCIAL,
  };
  switch (stage) {
    case 'sent':
      return {
        companyId,
        status: RequestStatus.WAITING_FOR_CUSTOMER,
        conversation: commercialConversation,
        proposalDocuments: {
          some: { status: QuoteProposalDocumentStatus.SENT },
        },
      };
    case 'approved':
      return {
        companyId,
        status: RequestStatus.APPROVED,
        conversation: commercialConversation,
      };
    case 'cancelled':
      return {
        companyId,
        status: { in: [RequestStatus.REJECTED, RequestStatus.CANCELLED] },
        conversation: commercialConversation,
      };
  }
}

function quoteProposalFilterWhere(
  query: QuoteProposalListQuery,
): Prisma.QuoteRequestWhereInput {
  const filters: Prisma.QuoteRequestWhereInput[] = [];
  if (query.conversationId) {
    filters.push({ conversationId: query.conversationId });
  }

  const search = query.search?.trim();
  if (search) {
    const phoneSearch = search.replace(/\D/g, '');
    filters.push({
      OR: [
        { contactName: { contains: search, mode: 'insensitive' } },
        { origin: { contains: search, mode: 'insensitive' } },
        { destination: { contains: search, mode: 'insensitive' } },
        {
          conversation: {
            contact: {
              displayName: { contains: search, mode: 'insensitive' },
            },
          },
        },
        ...(phoneSearch
          ? [
              {
                conversation: {
                  contact: { phoneNormalized: { contains: phoneSearch } },
                },
              } satisfies Prisma.QuoteRequestWhereInput,
            ]
          : []),
        {
          proposalDocuments: {
            some: { fileName: { contains: search, mode: 'insensitive' } },
          },
        },
      ],
    });
  }

  const createdFrom = query.createdFrom
    ? new Date(query.createdFrom)
    : undefined;
  const createdTo = query.createdTo ? new Date(query.createdTo) : undefined;
  if (
    (createdFrom && Number.isNaN(createdFrom.valueOf())) ||
    (createdTo && Number.isNaN(createdTo.valueOf()))
  ) {
    throw validationError('O período de criação informado é inválido.');
  }
  if (createdFrom && createdTo && createdFrom > createdTo) {
    throw validationError(
      'A data inicial do filtro não pode ser posterior à data final.',
    );
  }
  if (createdFrom || createdTo) {
    filters.push({
      createdAt: {
        ...(createdFrom ? { gte: createdFrom } : {}),
        ...(createdTo ? { lte: createdTo } : {}),
      },
    });
  }

  return filters.length > 0 ? { AND: filters } : {};
}

function acceptsProposalDocuments(status: RequestStatus): boolean {
  return (
    status === RequestStatus.UNDER_REVIEW ||
    status === RequestStatus.WAITING_FOR_CUSTOMER
  );
}

function acceptsProposalDocumentsForCurrentCycle(
  quote: {
    id: string;
    status: RequestStatus;
    confirmedAt: Date | null;
  },
  currentQuote: { id: string } | null | undefined,
): boolean {
  return (
    currentQuote?.id === quote.id &&
    quote.confirmedAt !== null &&
    acceptsProposalDocuments(quote.status)
  );
}

type ClosingTransitionName = 'close' | 'close-after-rejection';

function isClosingTransition(
  name: TransitionCommand['name'],
): name is ClosingTransitionName {
  return name === 'close' || name === 'close-after-rejection';
}

const kindToPrisma: Readonly<Record<CanonicalMessageKind, MessageKind>> = {
  text: MessageKind.TEXT,
  image: MessageKind.IMAGE,
  document: MessageKind.DOCUMENT,
  audio: MessageKind.AUDIO,
  video: MessageKind.VIDEO,
  sticker: MessageKind.STICKER,
  location: MessageKind.LOCATION,
  contact: MessageKind.CONTACT,
  unknown: MessageKind.UNKNOWN,
};

const kindFromPrisma: Readonly<Record<MessageKind, CanonicalMessageKind>> = {
  TEXT: 'text',
  IMAGE: 'image',
  DOCUMENT: 'document',
  AUDIO: 'audio',
  VIDEO: 'video',
  STICKER: 'sticker',
  LOCATION: 'location',
  CONTACT: 'contact',
  UNKNOWN: 'unknown',
};

const deliveryToPrisma: Readonly<
  Record<CanonicalDeliveryStatus, DeliveryStatus>
> = {
  received: DeliveryStatus.RECEIVED,
  pending: DeliveryStatus.PENDING,
  sent: DeliveryStatus.SENT,
  delivered: DeliveryStatus.DELIVERED,
  read: DeliveryStatus.READ,
  failed: DeliveryStatus.FAILED,
};

const deliveryFromPrisma: Readonly<
  Record<DeliveryStatus, CanonicalDeliveryStatus>
> = {
  RECEIVED: 'received',
  PENDING: 'pending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
};

const actorToPrisma = {
  user: TransitionActorType.USER,
  webhook: TransitionActorType.WEBHOOK,
  system: TransitionActorType.SYSTEM,
} as const;

const conversationInclude = {
  contact: true,
  channel: { select: { id: true, name: true, phoneNumber: true } },
  assignedTo: { select: { id: true, name: true } },
  quoteRequests: { orderBy: { sequence: 'desc' as const }, take: 1 },
  _count: {
    select: {
      quoteRequests: { where: { status: RequestStatus.APPROVED } },
    },
  },
} as const;

const conversationDetailInclude = {
  ...conversationInclude,
  transitions: {
    where: {
      name: { in: ['close', 'close-after-rejection'] as string[] },
    },
    orderBy: { resultingVersion: 'desc' as const },
    take: 1,
    include: {
      actorUser: { select: { id: true, name: true } },
    },
  },
} as const;

type ConversationWithRelations = Prisma.WhatsAppConversationGetPayload<{
  include: typeof conversationInclude;
}>;

type ConversationDetailWithRelations = Prisma.WhatsAppConversationGetPayload<{
  include: typeof conversationDetailInclude;
}>;

function payload(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function correlation(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function commandFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function assertSameFingerprint(
  persisted: string,
  expected: string,
  keyName: string,
): void {
  if (persisted !== expected) {
    throw new AppError(
      'CONFLICT',
      `${keyName} já foi usado com outro conteúdo.`,
    );
  }
}

function assertQuoteComplete(quote: {
  contactName: string | null;
  serviceType: string | null;
  origin: string | null;
  destination: string | null;
  departureDate: Date | null;
  passengerCount: number | null;
}): void {
  const missing = [
    !quote.contactName?.trim() && 'contactName',
    !quote.serviceType?.trim() && 'serviceType',
    !quote.origin?.trim() && 'origin',
    !quote.destination?.trim() && 'destination',
    !quote.departureDate && 'departureDate',
    (!quote.passengerCount || quote.passengerCount < 1) && 'passengerCount',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw validationError(
      `O orçamento ainda não possui os campos obrigatórios: ${missing.join(', ')}.`,
    );
  }
}

function snapshot(row: {
  department: DepartmentCode;
  conversationState: ConversationState;
  flowStep: FlowStep;
  requestStatus: RequestStatus;
  resumeState: ConversationState | null;
  resumeFlowStep: FlowStep | null;
}): ConversationSnapshot {
  return {
    department: departmentFromPrisma[row.department],
    conversationState: stateFromPrisma[row.conversationState],
    flowStep: flowFromPrisma[row.flowStep],
    requestStatus: requestFromPrisma[row.requestStatus],
    resumeState: row.resumeState ? stateFromPrisma[row.resumeState] : null,
    resumeFlowStep: row.resumeFlowStep
      ? flowFromPrisma[row.resumeFlowStep]
      : null,
  };
}

function presentQuote(row: {
  id: string;
  sequence: number;
  status: RequestStatus;
  contactName: string | null;
  document: string | null;
  email: string | null;
  serviceType: string | null;
  origin: string | null;
  destination: string | null;
  departureDate: Date | null;
  departureAt: Date | null;
  returnDate: Date | null;
  returnAt: Date | null;
  passengerCount: number | null;
  vehicleType: string | null;
  vehicleAtDisposal: boolean | null;
  localTransfers: boolean | null;
  notes: string | null;
  structuredData: unknown;
  confirmedAt: Date | null;
  confirmedSummary: unknown;
  confirmedVersion: number | null;
  requestedByUserId: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  requestedByUser?: { id: string; name: string } | null;
  decidedByUser?: { id: string; name: string } | null;
}) {
  return {
    id: row.id,
    sequence: row.sequence,
    status: requestFromPrisma[row.status],
    contactName: row.contactName,
    document: row.document,
    email: row.email,
    serviceType: row.serviceType,
    origin: row.origin,
    destination: row.destination,
    departureDate: presentDateOnly(row.departureDate),
    departureAt: row.departureAt?.toISOString() ?? null,
    returnDate: presentDateOnly(row.returnDate),
    returnAt: row.returnAt?.toISOString() ?? null,
    passengerCount: row.passengerCount,
    vehicleType: row.vehicleType,
    vehicleAtDisposal: row.vehicleAtDisposal,
    localTransfers: row.localTransfers,
    notes: row.notes,
    structuredData: row.structuredData,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    confirmedSummary: row.confirmedSummary,
    confirmedVersion: row.confirmedVersion,
    requestedBy:
      row.requestedByUser === undefined
        ? undefined
        : row.requestedByUser
          ? {
              type: 'attendant',
              id: row.requestedByUser.id,
              name: row.requestedByUser.name,
            }
          : {
              type: 'customer',
              id: null,
              name: row.contactName?.trim() || 'Cliente via WhatsApp',
            },
    decision: {
      status:
        row.status === RequestStatus.APPROVED
          ? 'approved'
          : row.status === RequestStatus.REJECTED
            ? 'rejected'
            : row.status === RequestStatus.CANCELLED
              ? 'cancelled'
              : 'pending',
      reason:
        row.decisionReason ??
        (row.status === RequestStatus.CANCELLED
          ? 'Substituído por uma nova solicitação de orçamento.'
          : row.status === RequestStatus.REJECTED
            ? 'Motivo não informado (registro legado).'
            : null),
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decidedBy: row.decidedByUser
        ? { id: row.decidedByUser.id, name: row.decidedByUser.name }
        : null,
    },
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentProposalDocument(row: {
  id: string;
  quoteRequestId: string;
  conversationId: string;
  messageId: string | null;
  sequence: number;
  status: QuoteProposalDocumentStatus;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  providerMessageId: string | null;
  queuedAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  uploadedByUser?: { id: string; name: string } | null;
  sentByUser?: { id: string; name: string } | null;
}) {
  return {
    id: row.id,
    quoteRequestId: row.quoteRequestId,
    conversationId: row.conversationId,
    messageId: row.messageId,
    sequence: row.sequence,
    status: row.status.toLowerCase(),
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    providerMessageId: row.providerMessageId,
    queuedAt: row.queuedAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    uploadedBy: row.uploadedByUser
      ? { id: row.uploadedByUser.id, name: row.uploadedByUser.name }
      : null,
    sentBy: row.sentByUser
      ? { id: row.sentByUser.id, name: row.sentByUser.name }
      : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentConversation(row: ConversationWithRelations) {
  return {
    id: row.id,
    companyId: row.companyId,
    channel: row.channel,
    contact: {
      id: row.contact.id,
      phone: row.contact.phoneNormalized,
      displayName: row.contact.displayName,
      profilePictureUrl: row.contact.profilePictureUrl,
    },
    ...snapshot(row),
    assignedTo: row.assignedTo,
    unreadCount: row.unreadCount,
    version: row.version,
    mainMenuPresentedAt: row.mainMenuPresentedAt?.toISOString() ?? null,
    followUpMenuPresentedAt: row.followUpMenuPresentedAt?.toISOString() ?? null,
    contextualFollowUpAt: row.contextualFollowUpAt?.toISOString() ?? null,
    departmentContactOption: row.departmentContactOption,
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: row.lastOutboundAt?.toISOString() ?? null,
    lastMessagePreview: row.lastMessagePreview,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    currentQuoteRequest: row.quoteRequests[0]
      ? presentQuote(row.quoteRequests[0])
      : null,
    hasApprovedQuoteRequest: row._count.quoteRequests > 0,
  };
}

function closingReason(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const reason = (metadata as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}

function presentClosure(
  transition: ConversationDetailWithRelations['transitions'][number],
) {
  return {
    transitionId: transition.id,
    transitionName: transition.name,
    occurredAt: transition.createdAt.toISOString(),
    reason: closingReason(transition.metadata),
    actor: {
      type: transition.actorType.toLowerCase(),
      user: transition.actorUser
        ? { id: transition.actorUser.id, name: transition.actorUser.name }
        : null,
    },
  };
}

function presentConversationDetail(row: ConversationDetailWithRelations) {
  return {
    ...presentConversation(row),
    closure: row.transitions[0] ? presentClosure(row.transitions[0]) : null,
  };
}

function currentVersionConflict(currentVersion: number): AppError {
  return new AppError(
    'CONFLICT',
    'A conversa foi alterada por outro comando.',
    { currentVersion },
  );
}

function quoteConversationClosed(
  conversationId: string,
  message = 'Não é possível cadastrar proposta em um atendimento encerrado.',
): AppError {
  return new AppError('QUOTE_CONVERSATION_CLOSED', message, {
    conversationId,
  });
}

function isPrismaUniqueError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

@Injectable()
export class PrismaWhatsAppRepository extends WhatsAppRepository {
  private readonly dispatchLeaseMs: number;
  private readonly followUpInactivityMs: number;
  private readonly automationRetryBaseDelayMs: number;
  private readonly automationRetryMaximumDelayMs: number;
  private readonly preventCloseWithApprovedQuote: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    super();
    this.dispatchLeaseMs =
      config.get<number>('EVOLUTION_DISPATCH_LEASE_MS') ?? 90_000;
    this.followUpInactivityMs =
      config.get<number>('WHATSAPP_FOLLOW_UP_INACTIVITY_MS') ?? 1_800_000;
    this.automationRetryBaseDelayMs =
      config.get<number>('WHATSAPP_API_RETRY_BASE_DELAY_MS') ?? 1_000;
    this.automationRetryMaximumDelayMs =
      config.get<number>('WHATSAPP_API_RETRY_MAX_DELAY_MS') ?? 300_000;
    this.preventCloseWithApprovedQuote =
      config.get<boolean>('WHATSAPP_PREVENT_CLOSE_WITH_APPROVED_QUOTE') ??
      false;
  }

  async findWebhookChannel(
    channelId: string,
  ): Promise<WebhookChannelConfiguration | null> {
    return this.prisma.whatsAppChannel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        companyId: true,
        instanceName: true,
        webhookSecretHash: true,
        ignoreGroups: true,
        ignoreFromMe: true,
        enabled: true,
      },
    });
  }

  async persistInbound(
    input: PersistInboundInput,
  ): Promise<PersistInboundResult> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const duplicate = await transaction.integrationInbox.findUnique({
          where: {
            companyId_source_externalEventId: {
              companyId: input.channel.companyId,
              source: 'evolution',
              externalEventId: input.externalEventId,
            },
          },
        });
        if (duplicate) {
          const existingMessage = await transaction.whatsAppMessage.findUnique({
            where: {
              companyId_channelId_providerMessageId: {
                companyId: input.channel.companyId,
                channelId: input.channel.id,
                providerMessageId: input.providerMessageId,
              },
            },
          });
          return {
            accepted: true,
            duplicate: true,
            messageId: existingMessage?.id ?? null,
            conversationId: existingMessage?.conversationId ?? null,
          };
        }

        const inbox = await transaction.integrationInbox.create({
          data: {
            companyId: input.channel.companyId,
            channelId: input.channel.id,
            source: 'evolution',
            externalEventId: input.externalEventId,
            payloadHash: input.payloadHash,
            correlationId: input.correlationId,
          },
        });

        const contact = await transaction.whatsAppContact.upsert({
          where: {
            companyId_phoneNormalized: {
              companyId: input.channel.companyId,
              phoneNormalized: input.phoneNormalized,
            },
          },
          create: {
            companyId: input.channel.companyId,
            phoneNormalized: input.phoneNormalized,
            displayName: input.displayName,
          },
          update: input.displayName ? { displayName: input.displayName } : {},
        });

        // Serializa o primeiro contato por tenant/canal/contato. O índice
        // parcial da migration continua sendo a última linha de defesa.
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${`${input.channel.companyId}:${input.channel.id}:${contact.id}`})
          )
        `;

        let conversation = await transaction.whatsAppConversation.findFirst({
          where: {
            companyId: input.channel.companyId,
            channelId: input.channel.id,
            contactId: contact.id,
          },
          orderBy: { updatedAt: 'desc' },
        });

        const isFirstContact = !conversation;
        let reopenedAfterClosure = false;
        if (!conversation) {
          conversation = await transaction.whatsAppConversation.create({
            data: {
              companyId: input.channel.companyId,
              channelId: input.channel.id,
              contactId: contact.id,
              department: DepartmentCode.COMMERCIAL,
              conversationState: ConversationState.BOT_ACTIVE,
              flowStep: FlowStep.MAIN_MENU,
              requestStatus: RequestStatus.NOT_STARTED,
            },
          });
        } else if (
          conversation.closedAt !== null ||
          conversation.conversationState === ConversationState.CLOSED
        ) {
          const from = snapshot(conversation);
          const next = resolveConversationTransition({
            current: from,
            name: 'reopen-after-customer-message',
          });
          const expectedVersion = conversation.version;
          const transitionedAt = new Date();
          conversation = await transaction.whatsAppConversation.update({
            where: {
              id_companyId: {
                id: conversation.id,
                companyId: input.channel.companyId,
              },
            },
            data: {
              department: departmentToPrisma[next.department],
              conversationState: stateToPrisma[next.conversationState],
              flowStep: flowToPrisma[next.flowStep],
              requestStatus: requestToPrisma[next.requestStatus],
              assignedToUserId: null,
              resumeState: null,
              resumeFlowStep: null,
              mainMenuPresentedAt: null,
              followUpMenuPresentedAt: null,
              contextualFollowUpAt: null,
              departmentContactOption: null,
              closedAt: null,
              version: { increment: 1 },
            },
          });
          reopenedAfterClosure = true;
          await transaction.whatsAppConversationTransition.create({
            data: {
              companyId: input.channel.companyId,
              conversationId: conversation.id,
              commandId: correlation(
                'reopen-after-customer-message',
                `${input.channel.id}:${input.providerMessageId}`,
              ),
              commandFingerprint: commandFingerprint({
                conversationId: conversation.id,
                providerMessageId: input.providerMessageId,
                name: 'reopen-after-customer-message',
              }),
              name: 'reopen-after-customer-message',
              expectedVersion,
              resultingVersion: expectedVersion + 1,
              actorType: TransitionActorType.WEBHOOK,
              fromDepartment: departmentToPrisma[from.department],
              toDepartment: departmentToPrisma[next.department],
              fromState: stateToPrisma[from.conversationState],
              toState: stateToPrisma[next.conversationState],
              fromFlowStep: flowToPrisma[from.flowStep],
              toFlowStep: flowToPrisma[next.flowStep],
              fromRequestStatus: requestToPrisma[from.requestStatus],
              toRequestStatus: requestToPrisma[next.requestStatus],
              metadata: payload({
                providerMessageId: input.providerMessageId,
                reason: 'customer-message-after-closure',
              }),
              resultSnapshot: payload({
                id: conversation.id,
                ...next,
                version: expectedVersion + 1,
              }),
              createdAt: transitionedAt,
            },
          });
        }

        await this.lockCommand(
          transaction,
          input.channel.companyId,
          'whatsapp-conversation',
          conversation.id,
        );
        conversation = await transaction.whatsAppConversation.findUniqueOrThrow(
          {
            where: {
              id_companyId: {
                id: conversation.id,
                companyId: input.channel.companyId,
              },
            },
          },
        );

        let contextualTransition = false;
        let automaticResumeName:
          | 'resume-awaited-reply'
          | 'resume-contextual-contact'
          | 'proposal-response-received'
          | null = null;

        if (
          input.kind === 'text' &&
          conversation.conversationState ===
            ConversationState.WAITING_FOR_CUSTOMER &&
          conversation.flowStep === FlowStep.QUOTE_SUMMARY_CONFIRMATION &&
          conversation.requestStatus === RequestStatus.WAITING_FOR_CUSTOMER &&
          conversation.resumeState === ConversationState.BOT_ACTIVE
        ) {
          automaticResumeName = 'resume-awaited-reply';
        } else if (
          input.kind === 'text' &&
          conversation.conversationState ===
            ConversationState.WAITING_FOR_CUSTOMER &&
          conversation.flowStep === FlowStep.QUOTE_SEND_PENDING &&
          conversation.requestStatus === RequestStatus.WAITING_FOR_CUSTOMER
        ) {
          automaticResumeName = 'proposal-response-received';
        } else if (
          input.kind === 'text' &&
          conversation.contextualFollowUpAt !== null &&
          input.occurredAt >= conversation.contextualFollowUpAt &&
          (conversation.requestStatus === RequestStatus.UNDER_REVIEW ||
            conversation.requestStatus === RequestStatus.APPROVED ||
            conversation.requestStatus === RequestStatus.REJECTED) &&
          ((conversation.conversationState ===
            ConversationState.SENT_TO_HUMAN &&
            conversation.flowStep === FlowStep.QUOTE_SEND_PENDING) ||
            (conversation.conversationState === ConversationState.BOT_ACTIVE &&
              (conversation.flowStep === FlowStep.QUOTE_SEND_PENDING ||
                conversation.flowStep === FlowStep.COMMERCIAL_FOLLOW_UP_MENU)))
        ) {
          automaticResumeName = 'resume-contextual-contact';
        }

        if (automaticResumeName) {
          const next = resolveConversationTransition({
            current: snapshot(conversation),
            name: automaticResumeName,
          });
          const result = await transaction.whatsAppConversation.updateMany({
            where: {
              id: conversation.id,
              companyId: input.channel.companyId,
              version: conversation.version,
            },
            data: {
              department: departmentToPrisma[next.department],
              conversationState: stateToPrisma[next.conversationState],
              flowStep: flowToPrisma[next.flowStep],
              requestStatus: requestToPrisma[next.requestStatus],
              resumeState: next.resumeState
                ? stateToPrisma[next.resumeState]
                : null,
              resumeFlowStep: next.resumeFlowStep
                ? flowToPrisma[next.resumeFlowStep]
                : null,
              followUpMenuPresentedAt: [
                'resume-contextual-contact',
                'proposal-response-received',
              ].includes(automaticResumeName)
                ? null
                : conversation.followUpMenuPresentedAt,
              contextualFollowUpAt: [
                'resume-contextual-contact',
                'proposal-response-received',
              ].includes(automaticResumeName)
                ? null
                : conversation.contextualFollowUpAt,
              version: { increment: 1 },
            },
          });
          if (result.count !== 1) {
            throw currentVersionConflict(conversation.version);
          }
          await transaction.whatsAppConversationTransition.create({
            data: {
              companyId: input.channel.companyId,
              conversationId: conversation.id,
              commandId: correlation(
                'inbound',
                `${input.channel.id}:${input.providerMessageId}`,
              ),
              name: automaticResumeName,
              commandFingerprint: commandFingerprint({
                conversationId: conversation.id,
                name: automaticResumeName,
                providerMessageId: input.providerMessageId,
              }),
              expectedVersion: conversation.version,
              resultingVersion: conversation.version + 1,
              actorType: TransitionActorType.WEBHOOK,
              fromDepartment: conversation.department,
              toDepartment: departmentToPrisma[next.department],
              fromState: conversation.conversationState,
              toState: stateToPrisma[next.conversationState],
              fromFlowStep: conversation.flowStep,
              toFlowStep: flowToPrisma[next.flowStep],
              fromRequestStatus: conversation.requestStatus,
              toRequestStatus: requestToPrisma[next.requestStatus],
              metadata: { providerMessageId: input.providerMessageId },
              resultSnapshot: payload({
                id: conversation.id,
                ...next,
                version: conversation.version + 1,
              }),
            },
          });
          conversation =
            await transaction.whatsAppConversation.findUniqueOrThrow({
              where: {
                id_companyId: {
                  id: conversation.id,
                  companyId: input.channel.companyId,
                },
              },
            });
          contextualTransition =
            automaticResumeName === 'resume-contextual-contact';
        }

        const message = await transaction.whatsAppMessage.create({
          data: {
            companyId: input.channel.companyId,
            conversationId: conversation.id,
            channelId: input.channel.id,
            contactId: contact.id,
            providerMessageId: input.providerMessageId,
            direction: MessageDirection.INBOUND,
            deliveryStatus: DeliveryStatus.RECEIVED,
            kind: kindToPrisma[input.kind],
            text: input.text,
            media: input.media ? payload(input.media) : undefined,
            correlationId: input.correlationId,
            occurredAt: input.occurredAt,
          },
        });

        const preview =
          input.text?.trim().slice(0, 240) ??
          (input.kind === 'text' ? null : `[${input.kind}]`);
        await transaction.whatsAppConversation.update({
          where: {
            id_companyId: {
              id: conversation.id,
              companyId: input.channel.companyId,
            },
          },
          data: {
            unreadCount: { increment: 1 },
            lastInboundAt: input.occurredAt,
            lastMessagePreview: preview,
          },
        });

        const humanRouted =
          conversation.conversationState === ConversationState.HUMAN_ACTIVE ||
          conversation.conversationState === ConversationState.SENT_TO_HUMAN ||
          conversation.flowStep === FlowStep.HUMAN_SERVICE;
        const automationAllowed =
          conversation.conversationState === ConversationState.BOT_ACTIVE &&
          !humanRouted;
        const canGenerateReply = automationAllowed;
        const canSendReply = automationAllowed;

        // A mensagem já existe quando o evento publicável é criado.
        await this.createOrderedOutbox(transaction, {
          companyId: input.channel.companyId,
          topic: humanRouted
            ? 'whatsapp.inbound.human-notification'
            : 'whatsapp.inbound.persisted',
          aggregateType: 'whatsapp-conversation',
          aggregateId: conversation.id,
          correlationId: input.correlationId,
          payload: {
            eventId: input.correlationId,
            messageId: message.id,
            conversationId: conversation.id,
            channelId: input.channel.id,
            companyId: input.channel.companyId,
            contact: {
              id: contact.id,
              phone: contact.phoneNormalized,
              displayName: contact.displayName,
            },
            message: {
              providerMessageId: input.providerMessageId,
              direction: 'inbound',
              deliveryStatus: 'received',
              kind: input.kind,
              text: input.text ?? null,
              media: input.media ?? null,
              occurredAt: input.occurredAt.toISOString(),
            },
            conversation: {
              id: conversation.id,
              ...snapshot(conversation),
              version: conversation.version,
              departmentContactOption: conversation.departmentContactOption,
            },
            automationAllowed,
            canGenerateReply,
            canSendReply,
            contextualTransition,
            isFirstContact,
            reopenedAfterClosure,
          },
        });

        await transaction.integrationInbox.update({
          where: { id: inbox.id },
          data: { processedAt: new Date() },
        });

        return {
          accepted: true,
          duplicate: false,
          automationAllowed,
          canGenerateReply,
          canSendReply,
          isFirstContact,
          reopenedAfterClosure,
          messageId: message.id,
          conversationId: conversation.id,
          version: conversation.version,
        };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        const existingMessage = await this.prisma.whatsAppMessage.findUnique({
          where: {
            companyId_channelId_providerMessageId: {
              companyId: input.channel.companyId,
              channelId: input.channel.id,
              providerMessageId: input.providerMessageId,
            },
          },
        });
        if (existingMessage) {
          return {
            accepted: true,
            duplicate: true,
            messageId: existingMessage.id,
            conversationId: existingMessage.conversationId,
          };
        }
      }
      throw error;
    }
  }

  async transition(input: TransitionCommand): Promise<unknown> {
    assertTransitionActor(input.name, input.actorType);
    const fingerprint = commandFingerprint(input);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'transition',
          input.commandId,
        );
        const duplicate =
          await transaction.whatsAppConversationTransition.findUnique({
            where: {
              companyId_commandId: {
                companyId: input.companyId,
                commandId: input.commandId,
              },
            },
          });

        if (duplicate) {
          assertSameFingerprint(
            duplicate.commandFingerprint,
            fingerprint,
            'commandId',
          );
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        await this.lockCommand(
          transaction,
          input.companyId,
          'whatsapp-conversation',
          input.conversationId,
        );
        const conversation = await this.findConversationOrThrow(
          transaction,
          input.companyId,
          input.conversationId,
        );
        if (conversation.version !== input.expectedVersion) {
          throw currentVersionConflict(conversation.version);
        }
        const closing = isClosingTransition(input.name);
        let resolvedClosingReason: string | null = null;
        if (closing) {
          const rawReason = input.metadata?.reason;
          if (
            rawReason !== undefined &&
            rawReason !== null &&
            typeof rawReason !== 'string'
          ) {
            throw validationError(
              'O motivo do encerramento deve ser um texto.',
            );
          }
          const providedReason =
            typeof rawReason === 'string' ? rawReason.trim() || null : null;
          if (providedReason && providedReason.length < 3) {
            throw validationError(
              'O motivo do encerramento deve possuir pelo menos 3 caracteres.',
            );
          }
          if (providedReason && providedReason.length > 500) {
            throw validationError(
              'O motivo do encerramento deve possuir no máximo 500 caracteres.',
            );
          }

          const latestQuote = conversation.quoteRequests[0];
          const rejected =
            conversation.requestStatus === RequestStatus.REJECTED ||
            latestQuote?.status === RequestStatus.REJECTED;
          const decisionReason =
            latestQuote?.status === RequestStatus.REJECTED
              ? latestQuote.decisionReason?.trim() || null
              : null;
          resolvedClosingReason = providedReason ?? decisionReason;
          if (rejected && !resolvedClosingReason) {
            throw validationError(
              'Informe o motivo do encerramento da proposta recusada.',
            );
          }
        }
        if (
          [
            'take-over',
            'return-to-bot',
            'forward',
            'new-quote-request',
          ].includes(input.name)
        ) {
          const queuedProposal =
            await transaction.quoteProposalDocument.findFirst({
              where: {
                companyId: input.companyId,
                conversationId: input.conversationId,
                status: QuoteProposalDocumentStatus.QUEUED,
              },
              select: { id: true },
            });
          if (queuedProposal) {
            throw new AppError(
              'CONFLICT',
              'A proposta está sendo enviada. Aguarde a confirmação do provedor antes de alterar a condução.',
              { proposalDocumentId: queuedProposal.id },
            );
          }
        }

        if (input.actorType === 'user' && !input.actorUserId) {
          throw validationError(
            'Uma transição humana exige um usuário autenticado.',
          );
        }
        let actorUser: { id: string; name: string } | null = null;
        if (input.actorUserId) {
          const actor = await transaction.user.findUnique({
            where: {
              id_companyId: {
                id: input.actorUserId,
                companyId: input.companyId,
              },
            },
            select: { id: true, name: true, isActive: true },
          });
          if (!actor?.isActive) {
            throw forbidden('O ator informado não pertence ao tenant.');
          }
          actorUser = { id: actor.id, name: actor.name };
        }

        const from = snapshot(conversation);
        const to = resolveConversationTransition({
          current: from,
          name: input.name,
          targetDepartment: input.targetDepartment,
          departmentOption:
            typeof input.metadata?.departmentOption === 'string'
              ? input.metadata.departmentOption
              : undefined,
          policy: {
            preventCloseWithApprovedQuote: this.preventCloseWithApprovedQuote,
          },
        });
        const nextVersion = conversation.version + 1;
        const transitionId = randomUUID();
        const transitionedAt = new Date();
        const departmentContactCompleted =
          input.name === 'return-to-main-menu' &&
          input.metadata?.reason === 'department-contact-forwarded';
        const closureMessageText = departmentContactCompleted
          ? buildDepartmentContactClosureMessage(
              departmentContactLabels[
                input.targetDepartment ??
                  departmentFromPrisma[conversation.department]
              ] ?? 'responsável',
            )
          : closing
            ? buildConversationClosureMessage(transitionedAt)
            : null;
        const finalizationPurpose = departmentContactCompleted
          ? 'department-contact-finalization'
          : 'conversation-closure';
        const closureMessage = closureMessageText
          ? await transaction.whatsAppMessage.create({
              data: {
                companyId: input.companyId,
                conversationId: input.conversationId,
                channelId: conversation.channelId,
                contactId: conversation.contactId,
                actorUserId: input.actorUserId,
                direction: MessageDirection.OUTBOUND,
                deliveryStatus: DeliveryStatus.PENDING,
                kind: MessageKind.TEXT,
                text: closureMessageText,
                automationPurpose: departmentContactCompleted
                  ? finalizationPurpose
                  : null,
                recipientPhone: conversation.contact.phoneNormalized,
                correlationId: correlation(
                  `${finalizationPurpose}-outbound`,
                  input.commandId,
                ),
                occurredAt: transitionedAt,
              },
            })
          : null;
        const closureAttempt = closureMessage
          ? await transaction.whatsAppMessageAttempt.create({
              data: {
                companyId: input.companyId,
                messageId: closureMessage.id,
                attemptNumber: 1,
                status: MessageAttemptStatus.PENDING,
              },
            })
          : null;

        let quote = conversation.quoteRequests[0];
        let supersededQuote: {
          id: string;
          previousVersion: number;
          resultingVersion: number;
        } | null = null;
        if (
          input.name === 'new-quote-request' &&
          quote?.status === RequestStatus.UNDER_REVIEW
        ) {
          const previousVersion = quote.version;
          const cancelled = await transaction.quoteRequest.updateMany({
            where: {
              id: quote.id,
              companyId: input.companyId,
              conversationId: input.conversationId,
              status: RequestStatus.UNDER_REVIEW,
              version: previousVersion,
            },
            data: {
              status: RequestStatus.CANCELLED,
              decisionReason:
                'Substituído por uma nova solicitação de orçamento.',
              decidedAt: new Date(),
              version: { increment: 1 },
            },
          });
          if (cancelled.count !== 1) {
            const latest = await transaction.quoteRequest.findUniqueOrThrow({
              where: {
                id_companyId: {
                  id: quote.id,
                  companyId: input.companyId,
                },
              },
              select: { version: true },
            });
            throw new AppError(
              'CONFLICT',
              'A solicitação anterior foi alterada durante a abertura do novo ciclo.',
              { currentVersion: latest.version },
            );
          }
          supersededQuote = {
            id: quote.id,
            previousVersion,
            resultingVersion: previousVersion + 1,
          };
        }
        if (
          input.name === 'new-quote-request' ||
          input.name === 'start-quote'
        ) {
          const latest = await transaction.quoteRequest.aggregate({
            where: {
              companyId: input.companyId,
              conversationId: input.conversationId,
            },
            _max: { sequence: true },
          });
          quote = await transaction.quoteRequest.create({
            data: {
              companyId: input.companyId,
              conversationId: input.conversationId,
              sequence: (latest._max.sequence ?? 0) + 1,
              status: RequestStatus.COLLECTING_INFORMATION,
            },
          });
        }
        if (
          ['present-quote-summary', 'correct-quote', 'confirm-quote'].includes(
            input.name,
          )
        ) {
          if (!quote) {
            throw validationError(
              'A conversa não possui uma solicitação de orçamento ativa.',
            );
          }
          if (
            input.name === 'present-quote-summary' ||
            input.name === 'confirm-quote'
          ) {
            assertQuoteComplete(quote);
          }
          quote = await transaction.quoteRequest.update({
            where: {
              id_companyId: { id: quote.id, companyId: input.companyId },
            },
            data: {
              status: requestToPrisma[to.requestStatus],
              ...(input.name === 'confirm-quote'
                ? {
                    confirmedAt: new Date(),
                    confirmedVersion: quote.version + 1,
                    confirmedSummary: payload({
                      contactName: quote.contactName,
                      document: quote.document,
                      email: quote.email,
                      serviceType: quote.serviceType,
                      origin: quote.origin,
                      destination: quote.destination,
                      departureDate: presentDateOnly(quote.departureDate),
                      departureAt: quote.departureAt?.toISOString() ?? null,
                      returnDate: presentDateOnly(quote.returnDate),
                      returnAt: quote.returnAt?.toISOString() ?? null,
                      passengerCount: quote.passengerCount,
                      vehicleType: quote.vehicleType,
                      vehicleAtDisposal: quote.vehicleAtDisposal,
                      localTransfers: quote.localTransfers,
                      notes: quote.notes,
                      structuredData: quote.structuredData,
                    }),
                  }
                : {}),
              version: { increment: 1 },
            },
          });
        }

        const clearsDepartmentContactOption =
          [
            'present-main-menu',
            'select-commercial',
            'return-to-main-menu',
            'take-over',
            'return-to-bot',
            'forward',
          ].includes(input.name) || closing;
        const nextAssignedToUserId =
          to.conversationState === 'human-active'
            ? input.name === 'take-over'
              ? input.actorUserId
              : conversation.assignedToUserId
            : null;
        if (to.conversationState === 'human-active' && !nextAssignedToUserId) {
          throw validationError(
            'Assuma a conversa antes de executar esta ação.',
          );
        }
        const update = await transaction.whatsAppConversation.updateMany({
          where: {
            id: input.conversationId,
            companyId: input.companyId,
            version: input.expectedVersion,
          },
          data: {
            department: departmentToPrisma[to.department],
            conversationState: stateToPrisma[to.conversationState],
            flowStep: flowToPrisma[to.flowStep],
            requestStatus: requestToPrisma[to.requestStatus],
            resumeState: to.resumeState ? stateToPrisma[to.resumeState] : null,
            resumeFlowStep: to.resumeFlowStep
              ? flowToPrisma[to.resumeFlowStep]
              : null,
            departmentContactOption:
              input.name === 'start-department-contact'
                ? (input.metadata?.departmentOption as string)
                : clearsDepartmentContactOption
                  ? null
                  : conversation.departmentContactOption,
            followUpMenuPresentedAt: closing
              ? null
              : input.name === 'confirm-quote' ||
                  ([
                    'return-to-bot',
                    'resume-contextual-contact',
                    'select-commercial',
                  ].includes(input.name) &&
                    to.flowStep === 'commercial-follow-up-menu')
                ? null
                : conversation.followUpMenuPresentedAt,
            contextualFollowUpAt:
              input.name === 'confirm-quote'
                ? new Date(Date.now() + this.followUpInactivityMs)
                : closing
                  ? null
                  : input.name === 'return-to-bot' &&
                      to.flowStep === 'commercial-follow-up-menu'
                    ? new Date(0)
                    : input.name === 'resume-contextual-contact'
                      ? null
                      : conversation.contextualFollowUpAt,
            mainMenuPresentedAt: closing
              ? null
              : conversation.mainMenuPresentedAt,
            assignedToUserId: nextAssignedToUserId,
            unreadCount:
              input.name === 'mark-read' ||
              closing ||
              departmentContactCompleted
                ? 0
                : conversation.unreadCount,
            ...(closureMessageText
              ? { lastMessagePreview: closureMessageText.slice(0, 240) }
              : {}),
            closedAt: closing ? transitionedAt : conversation.closedAt,
            version: { increment: 1 },
          },
        });
        if (update.count !== 1) {
          const latest =
            await transaction.whatsAppConversation.findUniqueOrThrow({
              where: {
                id_companyId: {
                  id: input.conversationId,
                  companyId: input.companyId,
                },
              },
              select: { version: true },
            });
          throw currentVersionConflict(latest.version);
        }

        const updated = await this.findConversationOrThrow(
          transaction,
          input.companyId,
          input.conversationId,
        );
        if (closureMessage && closureAttempt && closureMessageText) {
          await this.createOrderedOutbox(transaction, {
            companyId: input.companyId,
            topic: 'whatsapp.outbound.requested',
            aggregateType: 'whatsapp-conversation',
            aggregateId: input.conversationId,
            correlationId: correlation(
              `${finalizationPurpose}-request`,
              input.commandId,
            ),
            payload: {
              eventId: closureMessage.id,
              commandId: closureMessage.id,
              messageId: closureMessage.id,
              attemptId: closureAttempt.id,
              conversationId: input.conversationId,
              channelId: conversation.channelId,
              companyId: input.companyId,
              contact: {
                id: conversation.contact.id,
                phone: conversation.contact.phoneNormalized,
                displayName: conversation.contact.displayName,
              },
              message: {
                providerMessageId: null,
                direction: 'outbound',
                deliveryStatus: 'pending',
                kind: 'text',
                text: closureMessageText,
                media: null,
                occurredAt: closureMessage.occurredAt.toISOString(),
              },
              conversation: {
                id: updated.id,
                ...snapshot(updated),
                version: updated.version,
              },
              automatic: departmentContactCompleted,
              automationAllowed: false,
              canGenerateReply: false,
              canSendReply: true,
              contextualTransition: false,
              isFirstContact: false,
            },
          });
        }
        const closure = closing
          ? {
              transitionId,
              transitionName: input.name,
              occurredAt: transitionedAt.toISOString(),
              reason: resolvedClosingReason,
              actor: {
                type: input.actorType,
                user: actorUser,
              },
              messageId: closureMessage?.id ?? null,
            }
          : null;
        const persistedResult = {
          ...presentConversation(updated),
          ...(closing ? { closure } : {}),
        };
        const transitionMetadata = {
          ...(input.metadata ?? {}),
          ...(closing ? { reason: resolvedClosingReason } : {}),
          quoteRequestId: quote?.id ?? null,
          ...(supersededQuote
            ? {
                supersededQuoteRequest: {
                  id: supersededQuote.id,
                  fromStatus: 'under-review',
                  toStatus: 'cancelled',
                  previousVersion: supersededQuote.previousVersion,
                  resultingVersion: supersededQuote.resultingVersion,
                },
              }
            : {}),
        };
        await transaction.whatsAppConversationTransition.create({
          data: {
            id: transitionId,
            companyId: input.companyId,
            conversationId: input.conversationId,
            commandId: input.commandId,
            commandFingerprint: fingerprint,
            name: input.name,
            expectedVersion: input.expectedVersion,
            resultingVersion: nextVersion,
            actorType: actorToPrisma[input.actorType],
            actorUserId: input.actorUserId,
            fromDepartment: conversation.department,
            toDepartment: departmentToPrisma[to.department],
            fromState: conversation.conversationState,
            toState: stateToPrisma[to.conversationState],
            fromFlowStep: conversation.flowStep,
            toFlowStep: flowToPrisma[to.flowStep],
            fromRequestStatus: conversation.requestStatus,
            toRequestStatus: requestToPrisma[to.requestStatus],
            metadata: payload(transitionMetadata),
            resultSnapshot: payload(persistedResult),
            createdAt: transitionedAt,
          },
        });
        if (closing) {
          await transaction.tenantAuditLog.create({
            data: {
              companyId: input.companyId,
              actorUserId: input.actorUserId,
              action: 'whatsapp.conversation.close',
              targetType: 'whatsapp-conversation',
              targetId: input.conversationId,
              metadata: payload({
                transitionId,
                transitionName: input.name,
                commandId: input.commandId,
                expectedVersion: input.expectedVersion,
                resultingVersion: nextVersion,
                reason: resolvedClosingReason,
                occurredAt: transitionedAt.toISOString(),
              }),
              createdAt: transitionedAt,
            },
          });
        }
        if (supersededQuote && quote) {
          await transaction.tenantAuditLog.create({
            data: {
              companyId: input.companyId,
              actorUserId: input.actorUserId,
              action: 'whatsapp.quote-request.superseded',
              targetType: 'quote-request',
              targetId: supersededQuote.id,
              metadata: payload({
                conversationId: input.conversationId,
                newQuoteRequestId: quote.id,
                transitionId,
                commandId: input.commandId,
                fromStatus: 'under-review',
                toStatus: 'cancelled',
                previousVersion: supersededQuote.previousVersion,
                resultingVersion: supersededQuote.resultingVersion,
                occurredAt: transitionedAt.toISOString(),
              }),
              createdAt: transitionedAt,
            },
          });
        }
        return { ...persistedResult, idempotent: false };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayTransition(input, fingerprint);
      }
      throw error;
    }
  }

  async patchQuoteRequest(
    companyId: string,
    quoteRequestId: string,
    input: QuoteRequestPatch,
  ): Promise<unknown> {
    const fingerprint = commandFingerprint({
      companyId,
      quoteRequestId,
      ...input,
    });
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          companyId,
          'api.quote-patch',
          input.commandId,
        );
        const duplicate = await transaction.integrationInbox.findUnique({
          where: {
            companyId_source_externalEventId: {
              companyId,
              source: 'api.quote-patch',
              externalEventId: input.commandId,
            },
          },
        });
        const current = await transaction.quoteRequest.findUnique({
          where: { id_companyId: { id: quoteRequestId, companyId } },
        });
        if (!current) throw notFound('Solicitação de orçamento');
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Comando de orçamento incompleto.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }
        if (current.confirmedAt) {
          throw validationError(
            'Um orçamento confirmado é imutável; inicie new-quote-request.',
          );
        }
        if (current.version !== input.expectedVersion) {
          throw new AppError(
            'CONFLICT',
            'A solicitação foi alterada por outro comando.',
            { currentVersion: current.version },
          );
        }

        await transaction.integrationInbox.create({
          data: {
            companyId,
            source: 'api.quote-patch',
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation('quote-patch', input.commandId),
          },
        });

        const currentStructured =
          current.structuredData &&
          typeof current.structuredData === 'object' &&
          !Array.isArray(current.structuredData)
            ? (current.structuredData as Record<string, unknown>)
            : {};
        assertQuoteScheduleConsistency({
          departureDate:
            input.departureDate === undefined
              ? current.departureDate
              : input.departureDate,
          departureAt:
            input.departureAt === undefined
              ? current.departureAt
              : input.departureAt,
          returnDate:
            input.returnDate === undefined
              ? current.returnDate
              : input.returnDate,
          returnAt:
            input.returnAt === undefined ? current.returnAt : input.returnAt,
        });
        const result = await transaction.quoteRequest.updateMany({
          where: {
            id: quoteRequestId,
            companyId,
            version: input.expectedVersion,
          },
          data: {
            ...(input.contactName === undefined
              ? {}
              : { contactName: input.contactName?.trim() || null }),
            ...(input.document === undefined
              ? {}
              : { document: input.document?.replace(/\D/g, '') || null }),
            ...(input.email === undefined
              ? {}
              : { email: input.email?.trim().toLowerCase() || null }),
            ...(input.serviceType === undefined
              ? {}
              : { serviceType: input.serviceType?.trim() || null }),
            ...(input.origin === undefined
              ? {}
              : { origin: input.origin?.trim() || null }),
            ...(input.destination === undefined
              ? {}
              : { destination: input.destination?.trim() || null }),
            ...(input.departureDate === undefined
              ? {}
              : { departureDate: input.departureDate }),
            ...(input.departureAt === undefined
              ? {}
              : { departureAt: input.departureAt }),
            ...(input.returnDate === undefined
              ? {}
              : { returnDate: input.returnDate }),
            ...(input.returnAt === undefined
              ? {}
              : { returnAt: input.returnAt }),
            ...(input.passengerCount === undefined
              ? {}
              : { passengerCount: input.passengerCount }),
            ...(input.vehicleType === undefined
              ? {}
              : { vehicleType: input.vehicleType?.trim() || null }),
            ...(input.vehicleAtDisposal === undefined
              ? {}
              : { vehicleAtDisposal: input.vehicleAtDisposal }),
            ...(input.localTransfers === undefined
              ? {}
              : { localTransfers: input.localTransfers }),
            ...(input.notes === undefined
              ? {}
              : { notes: input.notes?.trim() || null }),
            ...(input.structuredData === undefined
              ? {}
              : {
                  structuredData: payload({
                    ...currentStructured,
                    ...input.structuredData,
                  }),
                }),
            version: { increment: 1 },
          },
        });
        if (result.count !== 1) {
          const latest = await transaction.quoteRequest.findUniqueOrThrow({
            where: { id_companyId: { id: quoteRequestId, companyId } },
            select: { version: true },
          });
          throw new AppError(
            'CONFLICT',
            'A solicitação foi alterada por outro comando.',
            { currentVersion: latest.version },
          );
        }
        const persistedResult = presentQuote(
          await transaction.quoteRequest.findUniqueOrThrow({
            where: { id_companyId: { id: quoteRequestId, companyId } },
          }),
        );
        await transaction.integrationInbox.update({
          where: {
            companyId_source_externalEventId: {
              companyId,
              source: 'api.quote-patch',
              externalEventId: input.commandId,
            },
          },
          data: {
            processedAt: new Date(),
            resultSnapshot: payload(persistedResult),
          },
        });
        return {
          ...persistedResult,
          idempotent: false,
        };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          companyId,
          'api.quote-patch',
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async createOutbound(input: CreateOutboundInput): Promise<unknown> {
    const fingerprint = commandFingerprint(input);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'api.outbound-command',
          input.commandId,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'api.outbound-command',
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        const messageCorrelation = correlation('outbound', input.commandId);
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Comando outbound incompleto.');
          }
          return this.presentCurrentOutboundReplay(
            transaction,
            input.companyId,
            duplicate.resultSnapshot as Record<string, unknown>,
          );
        }

        const conversation = await this.findConversationOrThrow(
          transaction,
          input.companyId,
          input.conversationId,
        );
        if (conversation.version !== input.expectedVersion) {
          throw currentVersionConflict(conversation.version);
        }
        const unsupportedMessageKindReply =
          input.purpose === 'unsupported-message-kind';
        if (
          conversation.conversationState !== ConversationState.BOT_ACTIVE ||
          conversation.flowStep === FlowStep.HUMAN_SERVICE ||
          conversation.assignedToUserId !== null
        ) {
          throw forbidden(
            'Envio automático permitido somente em conversationState=bot-active.',
          );
        }
        if (!input.text?.trim() && !input.media) {
          throw validationError('A mensagem outbound exige texto ou mídia.');
        }
        if (unsupportedMessageKindReply) {
          const unsupportedText = input.text?.trim() ?? '';
          if (
            input.kind !== 'text' ||
            !unsupportedText.endsWith(UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT) ||
            input.media !== undefined ||
            input.recipientPhone !== undefined ||
            !input.inReplyToMessageId
          ) {
            throw validationError(
              'A resposta a conteúdo não textual exige purpose, texto fixo e inReplyToMessageId canônicos.',
            );
          }
          const inbound = await transaction.whatsAppMessage.findUnique({
            where: {
              id_companyId: {
                id: input.inReplyToMessageId,
                companyId: input.companyId,
              },
            },
            select: {
              conversationId: true,
              direction: true,
              kind: true,
            },
          });
          if (
            !inbound ||
            inbound.conversationId !== input.conversationId ||
            inbound.direction !== MessageDirection.INBOUND ||
            inbound.kind === MessageKind.TEXT
          ) {
            throw validationError(
              'inReplyToMessageId deve identificar um inbound não textual desta conversa.',
            );
          }
        } else if (input.inReplyToMessageId !== undefined) {
          throw validationError(
            'inReplyToMessageId é permitido somente para unsupported-message-kind.',
          );
        }
        const recipientPhone =
          input.purpose === 'department-notification'
            ? input.recipientPhone?.replace(/\D/g, '')
            : conversation.contact.phoneNormalized;
        if (
          input.purpose === 'department-notification' &&
          (!recipientPhone || !/^\d{10,15}$/.test(recipientPhone))
        ) {
          throw validationError(
            'A notificação de departamento exige um telefone de destinatário válido.',
          );
        }
        if (
          input.purpose !== 'department-notification' &&
          input.recipientPhone
        ) {
          throw validationError(
            'O destinatário alternativo é permitido apenas para notificações de departamento.',
          );
        }

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: conversation.channelId,
            source: 'api.outbound-command',
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation('outbound-inbox', input.commandId),
          },
        });

        // O status pending e a tentativa existem antes de qualquer chamada Evolution.
        const message = await transaction.whatsAppMessage.create({
          data: {
            companyId: input.companyId,
            conversationId: input.conversationId,
            channelId: conversation.channelId,
            contactId: conversation.contactId,
            direction: MessageDirection.OUTBOUND,
            deliveryStatus: DeliveryStatus.PENDING,
            kind: kindToPrisma[input.kind],
            text: input.text?.trim(),
            media: input.media ? payload(input.media) : undefined,
            automationPurpose: input.purpose,
            recipientPhone,
            correlationId: messageCorrelation,
            occurredAt: new Date(),
          },
        });
        const attempt = await transaction.whatsAppMessageAttempt.create({
          data: {
            companyId: input.companyId,
            messageId: message.id,
            attemptNumber: 1,
            status: MessageAttemptStatus.PENDING,
          },
        });
        const persistedResult = this.presentMessage(
          { ...message, attempts: [attempt] },
          false,
        );
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: new Date(),
            resultSnapshot: payload(persistedResult),
          },
        });
        return persistedResult;
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        const replay = (await this.replayInbox(
          input.companyId,
          'api.outbound-command',
          input.commandId,
          fingerprint,
          'commandId',
        )) as Record<string, unknown>;
        return this.presentCurrentOutboundReplay(
          this.prisma,
          input.companyId,
          replay,
        );
      }
      throw error;
    }
  }

  async createHumanOutbound(input: CreateHumanOutboundInput): Promise<unknown> {
    const inputHash = commandFingerprint({
      ...input,
      text: input.text.trim(),
    });
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'panel.outbound-command',
          input.idempotencyKey,
        );
        const normalizedText = input.text.trim();
        if (!normalizedText) {
          throw validationError('A mensagem humana não pode estar vazia.');
        }

        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'panel.outbound-command',
            externalEventId: input.idempotencyKey,
          },
        };
        const messageCorrelation = correlation(
          'human-outbound',
          input.idempotencyKey,
        );
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            inputHash,
            'idempotencyKey',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Comando humano incompleto.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        await this.lockCommand(
          transaction,
          input.companyId,
          'whatsapp-conversation',
          input.conversationId,
        );
        const conversation = await this.findConversationOrThrow(
          transaction,
          input.companyId,
          input.conversationId,
        );
        if (conversation.version !== input.expectedVersion) {
          throw currentVersionConflict(conversation.version);
        }
        if (
          conversation.conversationState !== ConversationState.HUMAN_ACTIVE ||
          conversation.assignedToUserId !== input.actorUserId
        ) {
          throw forbidden(
            'A resposta exige atendimento humano ativo atribuído ao usuário.',
          );
        }

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: conversation.channelId,
            source: 'panel.outbound-command',
            externalEventId: input.idempotencyKey,
            payloadHash: inputHash,
            correlationId: correlation(
              'human-outbound-inbox',
              input.idempotencyKey,
            ),
          },
        });

        const message = await transaction.whatsAppMessage.create({
          data: {
            companyId: input.companyId,
            conversationId: input.conversationId,
            channelId: conversation.channelId,
            contactId: conversation.contactId,
            actorUserId: input.actorUserId,
            direction: MessageDirection.OUTBOUND,
            deliveryStatus: DeliveryStatus.PENDING,
            kind: MessageKind.TEXT,
            text: normalizedText,
            recipientPhone: conversation.contact.phoneNormalized,
            correlationId: messageCorrelation,
            occurredAt: new Date(),
          },
        });
        const attempt = await transaction.whatsAppMessageAttempt.create({
          data: {
            companyId: input.companyId,
            messageId: message.id,
            attemptNumber: 1,
            status: MessageAttemptStatus.PENDING,
          },
        });
        const updatedCount = await transaction.whatsAppConversation.updateMany({
          where: {
            id: input.conversationId,
            companyId: input.companyId,
            version: input.expectedVersion,
          },
          data: {
            lastMessagePreview: normalizedText.slice(0, 240),
            version: { increment: 1 },
          },
        });
        if (updatedCount.count !== 1) {
          const latest =
            await transaction.whatsAppConversation.findUniqueOrThrow({
              where: {
                id_companyId: {
                  id: input.conversationId,
                  companyId: input.companyId,
                },
              },
              select: { version: true },
            });
          throw currentVersionConflict(latest.version);
        }

        const updatedConversation = await this.findConversationOrThrow(
          transaction,
          input.companyId,
          input.conversationId,
        );
        await this.createOrderedOutbox(transaction, {
          companyId: input.companyId,
          topic: 'whatsapp.outbound.requested',
          aggregateType: 'whatsapp-conversation',
          aggregateId: input.conversationId,
          correlationId: correlation(
            'human-outbound-request',
            input.idempotencyKey,
          ),
          payload: {
            eventId: input.commandId,
            commandId: input.commandId,
            messageId: message.id,
            attemptId: attempt.id,
            conversationId: input.conversationId,
            channelId: conversation.channelId,
            companyId: input.companyId,
            contact: {
              id: conversation.contact.id,
              phone: conversation.contact.phoneNormalized,
              displayName: conversation.contact.displayName,
            },
            message: {
              providerMessageId: null,
              direction: 'outbound',
              deliveryStatus: 'pending',
              kind: 'text',
              text: normalizedText,
              media: null,
              occurredAt: message.occurredAt.toISOString(),
            },
            conversation: {
              id: updatedConversation.id,
              ...snapshot(updatedConversation),
              version: updatedConversation.version,
            },
            automatic: false,
            automationAllowed: false,
            canGenerateReply: false,
            canSendReply: true,
            contextualTransition: false,
            isFirstContact: false,
          },
        });
        await transaction.tenantAuditLog.create({
          data: {
            companyId: input.companyId,
            actorUserId: input.actorUserId,
            action: 'whatsapp.message.send',
            targetType: 'whatsapp-message',
            targetId: message.id,
            metadata: payload({
              conversationId: input.conversationId,
              commandId: input.commandId,
              idempotencyKey: input.idempotencyKey,
            }),
          },
        });
        const persistedResult = {
          message: this.presentMessage(
            {
              ...message,
              actorUser: conversation.assignedTo,
              attempts: [attempt],
            },
            false,
          ),
          conversation: presentConversation(updatedConversation),
        };
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: new Date(),
            resultSnapshot: payload(persistedResult),
          },
        });

        return {
          ...persistedResult,
          idempotent: false,
        };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          input.companyId,
          'panel.outbound-command',
          input.idempotencyKey,
          inputHash,
          'idempotencyKey',
        );
      }
      throw error;
    }
  }

  async claimEvolutionDispatch(
    input: ClaimEvolutionDispatchInput,
  ): Promise<unknown> {
    const fingerprint = commandFingerprint(input);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'evolution-attempt',
          `${input.messageId}:${input.attemptId}`,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'api.evolution-claim',
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        if (!duplicate) {
          await transaction.integrationInbox.create({
            data: {
              companyId: input.companyId,
              source: 'api.evolution-claim',
              externalEventId: input.commandId,
              payloadHash: fingerprint,
              correlationId: correlation('evolution-claim', input.commandId),
            },
          });
        }
        const completeClaim = async (result: Record<string, unknown>) => {
          await transaction.integrationInbox.update({
            where: inboxKey,
            data: {
              processedAt: new Date(),
              resultSnapshot: payload(result),
            },
          });
          return result;
        };
        const message = await transaction.whatsAppMessage.findUnique({
          where: {
            id_companyId: { id: input.messageId, companyId: input.companyId },
          },
          select: {
            id: true,
            direction: true,
            deliveryStatus: true,
          },
        });
        if (!message) throw notFound('Mensagem');
        if (message.direction !== MessageDirection.OUTBOUND) {
          throw validationError(
            'Somente mensagens outbound podem ser reservadas para envio.',
          );
        }

        const attempt = await transaction.whatsAppMessageAttempt.findUnique({
          where: {
            id_companyId: { id: input.attemptId, companyId: input.companyId },
          },
        });
        if (!attempt || attempt.messageId !== input.messageId) {
          throw notFound('Tentativa de envio');
        }
        const now = new Date();
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Claim Evolution incompleto.');
          }
          if (
            attempt.dispatchState === EvolutionDispatchState.LEASED &&
            attempt.dispatchLeaseUntil &&
            attempt.dispatchLeaseUntil <= now
          ) {
            const unknown = await transaction.whatsAppMessageAttempt.update({
              where: {
                id_companyId: {
                  id: attempt.id,
                  companyId: input.companyId,
                },
              },
              data: {
                dispatchState: EvolutionDispatchState.UNKNOWN,
                dispatchLeaseUntil: null,
              },
            });
            const result = await completeClaim({
              shouldSend: false,
              requiresReconciliation: true,
              state: 'unknown',
              messageId: message.id,
              attemptId: unknown.id,
              claimedAt: unknown.dispatchClaimedAt?.toISOString() ?? null,
            });
            return {
              ...result,
              alreadyClaimed: true,
              idempotent: true,
            };
          }
          if (attempt.dispatchState === EvolutionDispatchState.UNKNOWN) {
            const result = await completeClaim({
              shouldSend: false,
              requiresReconciliation: true,
              state: 'unknown',
              messageId: message.id,
              attemptId: attempt.id,
              claimedAt: attempt.dispatchClaimedAt?.toISOString() ?? null,
            });
            return {
              ...result,
              alreadyClaimed: true,
              idempotent: true,
            };
          }
          const currentState = attempt.dispatchState.toLowerCase();
          const result = await completeClaim({
            shouldSend: false,
            state: currentState,
            messageId: message.id,
            attemptId: attempt.id,
            claimedAt: attempt.dispatchClaimedAt?.toISOString() ?? null,
            ...(attempt.dispatchLeaseUntil
              ? { leaseUntil: attempt.dispatchLeaseUntil.toISOString() }
              : {}),
          });
          return {
            ...result,
            alreadyClaimed: true,
            idempotent: true,
          };
        }
        if (attempt.dispatchClaimId === input.commandId) {
          assertSameFingerprint(
            attempt.dispatchFingerprint ?? '',
            fingerprint,
            'commandId',
          );
        }
        if (
          attempt.status !== MessageAttemptStatus.PENDING ||
          message.deliveryStatus !== DeliveryStatus.PENDING
        ) {
          return completeClaim({
            shouldSend: false,
            state: attempt.dispatchState.toLowerCase(),
            messageId: message.id,
            attemptId: attempt.id,
            claimedAt: attempt.dispatchClaimedAt?.toISOString() ?? null,
          });
        }

        if (
          attempt.dispatchState === EvolutionDispatchState.LEASED &&
          attempt.dispatchLeaseUntil &&
          attempt.dispatchLeaseUntil <= now
        ) {
          const unknown = await transaction.whatsAppMessageAttempt.update({
            where: {
              id_companyId: { id: attempt.id, companyId: input.companyId },
            },
            data: {
              dispatchState: EvolutionDispatchState.UNKNOWN,
              dispatchLeaseUntil: null,
            },
          });
          return completeClaim({
            shouldSend: false,
            requiresReconciliation: true,
            state: 'unknown',
            messageId: message.id,
            attemptId: unknown.id,
            claimedAt: unknown.dispatchClaimedAt?.toISOString() ?? null,
          });
        }

        if (attempt.dispatchState === EvolutionDispatchState.LEASED) {
          return completeClaim({
            shouldSend: false,
            state: 'leased',
            messageId: message.id,
            attemptId: attempt.id,
            claimedAt: attempt.dispatchClaimedAt?.toISOString() ?? null,
            leaseUntil: attempt.dispatchLeaseUntil?.toISOString() ?? null,
          });
        }
        if (
          attempt.dispatchState === EvolutionDispatchState.UNKNOWN &&
          input.reconciliation !== 'confirmed-not-sent'
        ) {
          return completeClaim({
            shouldSend: false,
            requiresReconciliation: true,
            state: 'unknown',
            messageId: message.id,
            attemptId: attempt.id,
            claimedAt: attempt.dispatchClaimedAt?.toISOString() ?? null,
          });
        }
        if (
          attempt.dispatchState !== EvolutionDispatchState.READY &&
          attempt.dispatchState !== EvolutionDispatchState.UNKNOWN
        ) {
          return completeClaim({
            shouldSend: false,
            state: attempt.dispatchState.toLowerCase(),
            messageId: message.id,
            attemptId: attempt.id,
            claimedAt: attempt.dispatchClaimedAt?.toISOString() ?? null,
          });
        }

        const leaseUntil = new Date(now.valueOf() + this.dispatchLeaseMs);
        const claimed = await transaction.whatsAppMessageAttempt.update({
          where: {
            id_companyId: { id: attempt.id, companyId: input.companyId },
          },
          data: {
            dispatchClaimId: input.commandId,
            dispatchFingerprint: fingerprint,
            dispatchClaimedAt: now,
            dispatchState: EvolutionDispatchState.LEASED,
            dispatchOwnerId: input.ownerId,
            dispatchLeaseUntil: leaseUntil,
            errorCode: null,
            errorMessage: null,
          },
        });
        return completeClaim({
          shouldSend: true,
          state: 'leased',
          messageId: message.id,
          attemptId: attempt.id,
          claimedAt: claimed.dispatchClaimedAt?.toISOString() ?? null,
          leaseUntil: claimed.dispatchLeaseUntil?.toISOString() ?? null,
        });
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        const replay = (await this.replayInbox(
          input.companyId,
          'api.evolution-claim',
          input.commandId,
          fingerprint,
          'commandId',
        )) as Record<string, unknown>;
        return {
          ...replay,
          shouldSend: false,
          alreadyClaimed: true,
        };
      }
      throw error;
    }
  }

  async recordEvolutionResult(input: EvolutionResultInput): Promise<unknown> {
    const fingerprint = commandFingerprint(input);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'evolution-attempt',
          `${input.messageId}:${input.attemptId}`,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'api.evolution-result',
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        const message = await transaction.whatsAppMessage.findUnique({
          where: {
            id_companyId: { id: input.messageId, companyId: input.companyId },
          },
          include: {
            actorUser: { select: { id: true, name: true } },
            attempts: { orderBy: { attemptNumber: 'asc' } },
          },
        });
        if (!message) throw notFound('Mensagem');
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Resultado Evolution incompleto.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }
        if (message.direction !== MessageDirection.OUTBOUND) {
          throw validationError(
            'Resultados Evolution só podem atualizar mensagens outbound.',
          );
        }
        const attempt = message.attempts.find(
          (candidate) => candidate.id === input.attemptId,
        );
        if (!attempt) throw notFound('Tentativa de envio');
        if (attempt.dispatchState === EvolutionDispatchState.READY) {
          throw validationError(
            'A tentativa precisa de claim antes de registrar o resultado.',
          );
        }
        const requestedStatus = deliveryToPrisma[input.status];
        const statusRank: Readonly<Record<DeliveryStatus, number>> = {
          RECEIVED: 0,
          PENDING: 0,
          SENT: 1,
          DELIVERED: 2,
          READ: 3,
          FAILED: -1,
        };
        const finalStatus =
          message.deliveryStatus !== DeliveryStatus.PENDING &&
          (requestedStatus === DeliveryStatus.FAILED ||
            statusRank[requestedStatus] < statusRank[message.deliveryStatus])
            ? message.deliveryStatus
            : requestedStatus;
        const proposalDocument =
          message.automationPurpose === 'quote-proposal'
            ? await transaction.quoteProposalDocument.findUnique({
                where: {
                  messageId_companyId: {
                    messageId: message.id,
                    companyId: input.companyId,
                  },
                },
              })
            : null;
        if (
          proposalDocument &&
          finalStatus !== DeliveryStatus.FAILED &&
          !input.providerMessageId?.trim()
        ) {
          throw validationError(
            'A confirmação de envio da proposta exige providerMessageId.',
          );
        }

        if (
          proposalDocument &&
          proposalDocument.status !== QuoteProposalDocumentStatus.SENT
        ) {
          await this.lockCommand(
            transaction,
            input.companyId,
            'whatsapp-conversation',
            message.conversationId,
          );
          await this.lockCommand(
            transaction,
            input.companyId,
            'quote-proposal-delivery',
            proposalDocument.id,
          );
          const [conversation, quote] = await Promise.all([
            transaction.whatsAppConversation.findUniqueOrThrow({
              where: {
                id_companyId: {
                  id: message.conversationId,
                  companyId: input.companyId,
                },
              },
            }),
            transaction.quoteRequest.findUniqueOrThrow({
              where: {
                id_companyId: {
                  id: proposalDocument.quoteRequestId,
                  companyId: input.companyId,
                },
              },
            }),
          ]);
          if (
            proposalDocument.status !== QuoteProposalDocumentStatus.QUEUED ||
            quote.status !== RequestStatus.UNDER_REVIEW ||
            quote.conversationId !== conversation.id
          ) {
            throw new AppError(
              'CONFLICT',
              'A proposta não está mais no estado consistente aguardando confirmação do provedor.',
              {
                proposalDocumentStatus: proposalDocument.status.toLowerCase(),
                quoteRequestStatus: quote.status.toLowerCase(),
              },
            );
          }
          resolveConversationTransition({
            current: snapshot(conversation),
            name: 'proposal-delivery-confirmed',
          });
        }

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: message.channelId,
            source: 'api.evolution-result',
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation('evolution-result', input.commandId),
          },
        });
        await transaction.whatsAppMessageAttempt.update({
          where: {
            id_companyId: { id: attempt.id, companyId: input.companyId },
          },
          data: {
            status:
              finalStatus === DeliveryStatus.FAILED
                ? MessageAttemptStatus.FAILED
                : MessageAttemptStatus.SUCCEEDED,
            providerMessageId: input.providerMessageId,
            errorCode:
              finalStatus === DeliveryStatus.FAILED
                ? input.errorCode?.slice(0, 80)
                : null,
            errorMessage:
              finalStatus === DeliveryStatus.FAILED && input.errorMessage
                ? sanitizeLogText(input.errorMessage)
                : null,
            completedAt: new Date(),
            dispatchState:
              finalStatus === DeliveryStatus.FAILED
                ? EvolutionDispatchState.FAILED
                : EvolutionDispatchState.SUCCEEDED,
            dispatchLeaseUntil: null,
          },
        });
        const updated = await transaction.whatsAppMessage.update({
          where: {
            id_companyId: { id: input.messageId, companyId: input.companyId },
          },
          data: {
            deliveryStatus: finalStatus,
            providerMessageId: input.providerMessageId,
          },
          include: {
            actorUser: { select: { id: true, name: true } },
            attempts: { orderBy: { attemptNumber: 'asc' } },
          },
        });
        if (proposalDocument) {
          if (proposalDocument.status !== QuoteProposalDocumentStatus.SENT) {
            const now = new Date();
            const documentUpdated =
              await transaction.quoteProposalDocument.updateMany({
                where: {
                  id: proposalDocument.id,
                  companyId: input.companyId,
                  messageId: message.id,
                  status: QuoteProposalDocumentStatus.QUEUED,
                },
                data:
                  finalStatus === DeliveryStatus.FAILED
                    ? {
                        status: QuoteProposalDocumentStatus.FAILED,
                        providerMessageId: null,
                        sentAt: null,
                      }
                    : {
                        status: QuoteProposalDocumentStatus.SENT,
                        providerMessageId: input.providerMessageId?.trim(),
                        sentAt: now,
                      },
              });
            if (documentUpdated.count !== 1) {
              throw new AppError(
                'CONFLICT',
                'O documento da proposta não está mais aguardando confirmação.',
              );
            }
            await this.completeQuoteProposalBatchIfReady(transaction, {
              companyId: input.companyId,
              conversationId: message.conversationId,
              quoteRequestId: proposalDocument.quoteRequestId,
              triggeringDocumentId: proposalDocument.id,
              deliveryBatchId: proposalDocument.deliveryBatchId,
            });
          }
        } else if (
          finalStatus !== DeliveryStatus.FAILED &&
          message.automationPurpose !== 'department-notification'
        ) {
          await transaction.whatsAppConversation.update({
            where: {
              id_companyId: {
                id: message.conversationId,
                companyId: input.companyId,
              },
            },
            data: {
              lastOutboundAt: new Date(),
              lastMessagePreview:
                message.text?.slice(0, 240) ??
                `[${kindFromPrisma[message.kind]}]`,
              ...(message.automationPurpose === 'main-menu'
                ? { mainMenuPresentedAt: new Date() }
                : {}),
              ...(message.automationPurpose === 'commercial-follow-up-menu'
                ? { followUpMenuPresentedAt: new Date() }
                : {}),
            },
          });
        }
        const persistedResult = this.presentMessage(updated, false);
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: new Date(),
            resultSnapshot: payload(persistedResult),
          },
        });
        return persistedResult;
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          input.companyId,
          'api.evolution-result',
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async markEvolutionDispatchUnknown(
    input: MarkEvolutionDispatchUnknownInput,
  ): Promise<unknown> {
    const errorMessage = sanitizeLogText(input.errorMessage).slice(0, 500);
    return this.prisma.$transaction(async (transaction) => {
      await this.lockCommand(
        transaction,
        input.companyId,
        'evolution-attempt',
        `${input.messageId}:${input.attemptId}`,
      );
      const attempt = await transaction.whatsAppMessageAttempt.findUnique({
        where: {
          id_companyId: {
            id: input.attemptId,
            companyId: input.companyId,
          },
        },
      });
      if (!attempt || attempt.messageId !== input.messageId) {
        throw notFound('Tentativa de envio');
      }
      if (attempt.dispatchState === EvolutionDispatchState.UNKNOWN) {
        return {
          messageId: input.messageId,
          attemptId: input.attemptId,
          state: 'unknown',
          idempotent: true,
        };
      }
      if (
        attempt.dispatchState !== EvolutionDispatchState.LEASED ||
        attempt.dispatchOwnerId !== input.ownerId
      ) {
        throw new AppError(
          'CONFLICT',
          'A tentativa não pertence à execução que solicitou a reconciliação.',
        );
      }
      await transaction.whatsAppMessageAttempt.update({
        where: {
          id_companyId: {
            id: input.attemptId,
            companyId: input.companyId,
          },
        },
        data: {
          dispatchState: EvolutionDispatchState.UNKNOWN,
          dispatchLeaseUntil: null,
          errorCode: input.errorCode.slice(0, 80),
          errorMessage,
        },
      });
      return {
        messageId: input.messageId,
        attemptId: input.attemptId,
        state: 'unknown',
        requiresReconciliation: true,
      };
    });
  }

  async completeOutboxExecution(
    input: CompleteOutboxExecutionInput,
  ): Promise<unknown> {
    const automationProvider = WhatsAppAutomationProvider.API;
    const completionSource = 'api.outbox-completion';
    const completionCorrelationPrefix = 'api-outbox-completion';
    const consumedSourceEventIds = [
      ...new Set(
        (input.consumedSourceEventIds ?? [])
          .map((sourceEventId) => sourceEventId.trim())
          .filter(Boolean),
      ),
    ];
    if (consumedSourceEventIds.length > 50) {
      throw validationError(
        'Uma conclusão pode incorporar no máximo 50 eventos inbound.',
      );
    }
    const fingerprint = commandFingerprint(input);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          `${completionSource}-command`,
          input.commandId,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: completionSource,
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Conclusão de outbox incompleta.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        await this.lockCommand(
          transaction,
          input.companyId,
          'api.outbox-event',
          input.eventId,
        );
        const event = await transaction.integrationOutbox.findFirst({
          where: { id: input.eventId, companyId: input.companyId },
        });
        if (!event) throw notFound('Evento de outbox');
        if (
          event.aggregateType !== input.aggregateType ||
          event.aggregateId !== input.aggregateId
        ) {
          throw new AppError(
            'CONFLICT',
            'O agregado informado não corresponde ao evento.',
          );
        }
        if (event.status !== IntegrationOutboxStatus.PROCESSING) {
          throw new AppError(
            'CONFLICT',
            'O evento já foi concluído ou não possui execução aceita.',
            { status: event.status.toLowerCase() },
          );
        }
        if (event.executionId !== input.executionId) {
          throw new AppError(
            'CONFLICT',
            'executionId não corresponde à execução atual do evento.',
          );
        }
        if (
          event.processingProvider !== null &&
          event.processingProvider !== automationProvider
        ) {
          throw new AppError(
            'CONFLICT',
            'A execução pertence a outro provedor de automação.',
          );
        }
        if (
          consumedSourceEventIds.length > 0 &&
          (input.outcome !== 'succeeded' ||
            event.topic !== 'whatsapp.inbound.persisted')
        ) {
          throw validationError(
            'Somente uma conclusão inbound bem-sucedida pode incorporar eventos do mesmo lote.',
          );
        }
        if (
          input.outcome === 'succeeded' &&
          event.topic === 'whatsapp.outbound.requested'
        ) {
          const eventPayload =
            event.payload &&
            typeof event.payload === 'object' &&
            !Array.isArray(event.payload)
              ? (event.payload as Record<string, unknown>)
              : {};
          const messageId =
            typeof eventPayload.messageId === 'string'
              ? eventPayload.messageId
              : null;
          const attemptId =
            typeof eventPayload.attemptId === 'string'
              ? eventPayload.attemptId
              : null;
          if (!messageId || !attemptId) {
            throw new AppError(
              'CONFLICT',
              'O evento outbound não identifica a mensagem e a tentativa de envio.',
            );
          }
          const [outboundMessage, outboundAttempt] = await Promise.all([
            transaction.whatsAppMessage.findUnique({
              where: {
                id_companyId: {
                  id: messageId,
                  companyId: input.companyId,
                },
              },
              select: { direction: true, deliveryStatus: true },
            }),
            transaction.whatsAppMessageAttempt.findUnique({
              where: {
                id_companyId: {
                  id: attemptId,
                  companyId: input.companyId,
                },
              },
              select: {
                messageId: true,
                status: true,
                dispatchState: true,
              },
            }),
          ]);
          const positiveDeliveryConfirmed =
            outboundMessage?.direction === MessageDirection.OUTBOUND &&
            (
              [
                DeliveryStatus.SENT,
                DeliveryStatus.DELIVERED,
                DeliveryStatus.READ,
              ] as DeliveryStatus[]
            ).includes(outboundMessage.deliveryStatus);
          const positiveAttemptConfirmed =
            outboundAttempt?.messageId === messageId &&
            outboundAttempt.status === MessageAttemptStatus.SUCCEEDED &&
            outboundAttempt.dispatchState === EvolutionDispatchState.SUCCEEDED;
          const terminalFailureConfirmed =
            outboundMessage?.direction === MessageDirection.OUTBOUND &&
            outboundMessage.deliveryStatus === DeliveryStatus.FAILED &&
            outboundAttempt?.messageId === messageId &&
            outboundAttempt.status === MessageAttemptStatus.FAILED &&
            outboundAttempt.dispatchState === EvolutionDispatchState.FAILED;
          if (!(
            (positiveDeliveryConfirmed && positiveAttemptConfirmed) ||
            terminalFailureConfirmed
          )) {
            throw new AppError(
              'CONFLICT',
              'O workflow não pode concluir o evento antes de persistir o resultado da Evolution.',
              {
                deliveryStatus:
                  outboundMessage?.deliveryStatus.toLowerCase() ?? 'missing',
                attemptStatus:
                  outboundAttempt?.status.toLowerCase() ?? 'missing',
              },
            );
          }
        }

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            source: completionSource,
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation(
              completionCorrelationPrefix,
              input.commandId,
            ),
          },
        });

        const attempts = event.attempts;
        const retryableFailureExhausted =
          input.outcome === 'retryable-failure' &&
          attempts >= event.maxAttempts;
        const now = new Date();
        const retryDelay = Math.min(
          this.automationRetryBaseDelayMs * 2 ** Math.max(0, attempts - 1),
          this.automationRetryMaximumDelayMs,
        );
        const failure = sanitizeLogText(
          `${input.errorCode ?? input.outcome}: ${input.errorMessage ?? ''}`,
        ).slice(0, 500);
        const updated = await transaction.integrationOutbox.update({
          where: { id: event.id },
          data:
            input.outcome === 'succeeded'
              ? {
                  status: IntegrationOutboxStatus.DELIVERED,
                  attempts,
                  deliveredAt: now,
                  executionLeaseUntil: null,
                  lockedAt: null,
                  lockId: null,
                  lastError: null,
                }
              : input.outcome === 'retryable-failure' &&
                  !retryableFailureExhausted
                ? {
                    status: IntegrationOutboxStatus.PENDING,
                    attempts,
                    availableAt: new Date(now.valueOf() + retryDelay),
                    processingProvider: null,
                    executionId: null,
                    acceptedAt: null,
                    executionLeaseUntil: null,
                    lockedAt: null,
                    lockId: null,
                    lastError: failure,
                  }
                : {
                    status: IntegrationOutboxStatus.DEAD,
                    attempts,
                    ...(retryableFailureExhausted
                      ? { executionId: null, acceptedAt: null }
                      : {}),
                    executionLeaseUntil: null,
                    lockedAt: null,
                    lockId: null,
                    lastError: failure,
                  },
        });
        const executionStatus =
          input.outcome === 'succeeded'
            ? WhatsAppAutomationExecutionStatus.SUCCEEDED
            : input.outcome === 'retryable-failure' &&
                !retryableFailureExhausted
              ? WhatsAppAutomationExecutionStatus.RETRYABLE_FAILURE
              : WhatsAppAutomationExecutionStatus.TERMINAL_FAILURE;
        const auditedExecution =
          await transaction.whatsAppAutomationExecution.updateMany({
            where: {
              companyId: input.companyId,
              executionId: input.executionId,
              provider: automationProvider,
            },
            data: {
              status: executionStatus,
              acceptedAt: event.acceptedAt ?? now,
              completedAt: now,
              errorCode:
                input.outcome === 'succeeded'
                  ? null
                  : (input.errorCode ?? input.outcome).slice(0, 80),
              errorMessage:
                input.outcome === 'succeeded' ? null : failure.slice(0, 500),
            },
          });
        if (event.processingProvider !== null && auditedExecution.count !== 1) {
          throw new AppError(
            'CONFLICT',
            'A execução não possui o registro de auditoria esperado.',
          );
        }
        const consumedEvents =
          consumedSourceEventIds.length > 0
            ? await transaction.integrationOutbox.findMany({
                where: {
                  id: { not: event.id },
                  companyId: input.companyId,
                  aggregateType: event.aggregateType,
                  aggregateId: event.aggregateId,
                  topic: 'whatsapp.inbound.persisted',
                  correlationId: { in: consumedSourceEventIds },
                  status: IntegrationOutboxStatus.PENDING,
                },
                select: { id: true, attempts: true },
              })
            : [];
        const consumed =
          consumedEvents.length > 0
            ? await transaction.integrationOutbox.updateMany({
                where: {
                  id: { in: consumedEvents.map((item) => item.id) },
                  companyId: input.companyId,
                  status: IntegrationOutboxStatus.PENDING,
                },
                data: {
                  status: IntegrationOutboxStatus.DELIVERED,
                  processingProvider: automationProvider,
                  deliveredAt: now,
                  executionId: null,
                  acceptedAt: null,
                  executionLeaseUntil: null,
                  lockedAt: null,
                  lockId: null,
                  lastError: null,
                },
              })
            : { count: 0 };
        if (consumed.count !== consumedEvents.length) {
          throw new AppError(
            'CONFLICT',
            'Os eventos incorporados ao lote foram alterados durante a conclusão.',
          );
        }
        if (consumedEvents.length > 0) {
          await transaction.whatsAppAutomationExecution.createMany({
            data: consumedEvents.map((consumedEvent) => ({
              companyId: input.companyId,
              outboxEventId: consumedEvent.id,
              executionId: deterministicCommandId(
                input.executionId,
                `consumed:${consumedEvent.id}`,
              ),
              provider: automationProvider,
              status: WhatsAppAutomationExecutionStatus.SUCCEEDED,
              attemptNumber: Math.max(1, consumedEvent.attempts),
              startedAt: now,
              acceptedAt: now,
              completedAt: now,
            })),
            skipDuplicates: true,
          });
        }
        const persistedResult = {
          eventId: updated.id,
          executionId: input.executionId,
          aggregateType: updated.aggregateType,
          aggregateId: updated.aggregateId,
          aggregateSequence: updated.aggregateSequence,
          outcome: input.outcome,
          status: updated.status.toLowerCase(),
          attempts: updated.attempts,
          consumedEventCount: consumed.count,
        };
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: now,
            resultSnapshot: payload(persistedResult),
          },
        });
        return { ...persistedResult, idempotent: false };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          input.companyId,
          completionSource,
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async reconcileAutomationOutbox(
    input: ReconcileAutomationOutboxInput,
  ): Promise<unknown> {
    const evidence = input.evidence.trim();
    if (evidence.length < 10 || evidence.length > 500) {
      throw validationError(
        'A reconciliação exige uma evidência entre 10 e 500 caracteres.',
      );
    }
    if (
      input.resolution !== 'confirmed-sent' &&
      input.resolution !== 'confirmed-not-sent' &&
      input.resolution !== 'confirmed-processed' &&
      input.resolution !== 'confirmed-not-processed'
    ) {
      throw validationError('A resolução de reconciliação é inválida.');
    }
    const providerMessageId = input.providerMessageId?.trim();
    if (
      input.resolution !== 'confirmed-sent' &&
      providerMessageId !== undefined
    ) {
      throw validationError(
        'Somente um envio confirmado pode informar identificador do provedor.',
      );
    }
    if (
      input.resolution === 'confirmed-sent' &&
      (!providerMessageId || providerMessageId.length > 160)
    ) {
      throw validationError(
        'O envio confirmado exige um identificador válido do provedor.',
      );
    }
    const normalizedInput = {
      ...input,
      evidence,
      ...(providerMessageId ? { providerMessageId } : {}),
    };
    const fingerprint = commandFingerprint(normalizedInput);
    const inboxSource = 'whatsapp.automation-reconciliation';

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'whatsapp-automation-reconciliation',
          input.eventId,
        );
        const lockedEvent = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM integration_outbox
          WHERE id = CAST(${input.eventId} AS uuid)
            AND company_id = CAST(${input.companyId} AS uuid)
          FOR UPDATE
        `;
        if (lockedEvent.length !== 1) throw notFound('Evento de outbox');

        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: inboxSource,
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Reconciliação incompleta.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        const event = await transaction.integrationOutbox.findUnique({
          where: {
            id_companyId: {
              id: input.eventId,
              companyId: input.companyId,
            },
          },
        });
        if (!event) throw notFound('Evento de outbox');
        if (event.status !== IntegrationOutboxStatus.DEAD) {
          throw new AppError(
            'CONFLICT',
            'Somente um evento isolado pode ser reconciliado.',
          );
        }

        const eventPayload =
          event.payload &&
          typeof event.payload === 'object' &&
          !Array.isArray(event.payload)
            ? (event.payload as Record<string, unknown>)
            : {};
        const inboundTopic =
          event.topic === 'whatsapp.inbound.persisted' ||
          event.topic === 'whatsapp.inbound.human-notification';
        const inboundResolution =
          input.resolution === 'confirmed-processed' ||
          input.resolution === 'confirmed-not-processed';
        if (inboundTopic) {
          if (
            !inboundResolution ||
            event.lastError !== LEGACY_AUTOMATION_RECONCILIATION_REQUIRED ||
            event.processingProvider === null
          ) {
            throw new AppError(
              'CONFLICT',
              'O evento inbound não foi isolado por uma troca de provedor.',
            );
          }
          const channelId =
            typeof eventPayload.channelId === 'string'
              ? eventPayload.channelId
              : undefined;
          await transaction.integrationInbox.create({
            data: {
              companyId: input.companyId,
              ...(channelId ? { channelId } : {}),
              source: inboxSource,
              externalEventId: input.commandId,
              payloadHash: fingerprint,
              correlationId: correlation(
                'whatsapp-automation-reconciliation',
                input.commandId,
              ),
            },
          });

          const now = new Date();
          const confirmedProcessed = input.resolution === 'confirmed-processed';
          const previousProvider =
            event.processingProvider === WhatsAppAutomationProvider.API
              ? 'api'
              : 'legacy';
          await transaction.integrationOutbox.update({
            where: {
              id_companyId: { id: event.id, companyId: input.companyId },
            },
            data: confirmedProcessed
              ? {
                  status: IntegrationOutboxStatus.DELIVERED,
                  deliveredAt: now,
                  executionId: null,
                  acceptedAt: null,
                  executionLeaseUntil: null,
                  lockedAt: null,
                  lockId: null,
                  lastError: null,
                }
              : {
                  status: IntegrationOutboxStatus.PENDING,
                  attempts: 0,
                  availableAt: now,
                  processingProvider: null,
                  executionId: null,
                  acceptedAt: null,
                  executionLeaseUntil: null,
                  deliveredAt: null,
                  lockedAt: null,
                  lockId: null,
                  lastError: null,
                },
          });
          const persistedResult = {
            eventId: event.id,
            topic: event.topic,
            resolution: input.resolution,
            status: confirmedProcessed ? 'delivered' : 'pending',
            previousProvider,
            evidence,
            reconciledBy: {
              id: input.serviceIdentityId,
              name: input.serviceIdentityName,
            },
            reconciledAt: now.toISOString(),
          };
          await transaction.integrationInbox.update({
            where: inboxKey,
            data: {
              processedAt: now,
              resultSnapshot: payload(persistedResult),
            },
          });
          return { ...persistedResult, idempotent: false };
        }
        if (
          event.topic !== 'whatsapp.outbound.requested' ||
          inboundResolution
        ) {
          throw new AppError(
            'CONFLICT',
            'A resolução não corresponde ao tipo do evento isolado.',
          );
        }
        const messageId =
          typeof eventPayload.messageId === 'string'
            ? eventPayload.messageId
            : null;
        const attemptId =
          typeof eventPayload.attemptId === 'string'
            ? eventPayload.attemptId
            : null;
        if (!messageId || !attemptId) {
          throw new AppError(
            'CONFLICT',
            'O evento isolado não identifica a mensagem e a tentativa.',
          );
        }
        await this.lockCommand(
          transaction,
          input.companyId,
          'evolution-attempt',
          `${messageId}:${attemptId}`,
        );
        await this.lockCommand(
          transaction,
          input.companyId,
          'evolution-message-attempts',
          messageId,
        );

        const [message, attempt, attemptNumbers] = await Promise.all([
          transaction.whatsAppMessage.findUnique({
            where: {
              id_companyId: { id: messageId, companyId: input.companyId },
            },
          }),
          transaction.whatsAppMessageAttempt.findUnique({
            where: {
              id_companyId: { id: attemptId, companyId: input.companyId },
            },
          }),
          transaction.whatsAppMessageAttempt.aggregate({
            where: { companyId: input.companyId, messageId },
            _max: { attemptNumber: true },
          }),
        ]);
        if (!message || message.direction !== MessageDirection.OUTBOUND) {
          throw new AppError(
            'CONFLICT',
            'O evento isolado não aponta para uma mensagem de saída válida.',
          );
        }
        if (!attempt || attempt.messageId !== message.id) {
          throw new AppError(
            'CONFLICT',
            'O evento isolado não aponta para uma tentativa válida.',
          );
        }

        const now = new Date();
        const expiredLease =
          attempt.dispatchState === EvolutionDispatchState.LEASED &&
          attempt.dispatchLeaseUntil !== null &&
          attempt.dispatchLeaseUntil <= now;
        const confirmedLocalConfigurationFailure =
          input.resolution === 'confirmed-not-sent' &&
          attempt.status === MessageAttemptStatus.FAILED &&
          attempt.dispatchState === EvolutionDispatchState.FAILED &&
          attempt.errorCode === 'EVOLUTION_CONFIGURATION_INVALID' &&
          message.deliveryStatus === DeliveryStatus.FAILED &&
          attempt.providerMessageId === null &&
          message.providerMessageId === null;
        const confirmedSentAlreadyPersisted =
          input.resolution === 'confirmed-sent' &&
          attempt.status === MessageAttemptStatus.SUCCEEDED &&
          attempt.dispatchState === EvolutionDispatchState.SUCCEEDED &&
          (
            [
              DeliveryStatus.SENT,
              DeliveryStatus.DELIVERED,
              DeliveryStatus.READ,
            ] as DeliveryStatus[]
          ).includes(message.deliveryStatus) &&
          attempt.providerMessageId === providerMessageId &&
          message.providerMessageId === providerMessageId;
        const awaitingReconciliation =
          attempt.dispatchState === EvolutionDispatchState.UNKNOWN ||
          expiredLease ||
          confirmedLocalConfigurationFailure ||
          confirmedSentAlreadyPersisted;
        if (!awaitingReconciliation) {
          throw new AppError(
            'CONFLICT',
            'A tentativa não está aguardando reconciliação.',
          );
        }
        const compatibleConfirmedSentState =
          (attempt.status === MessageAttemptStatus.PENDING &&
            (
              [
                DeliveryStatus.PENDING,
                DeliveryStatus.SENT,
                DeliveryStatus.DELIVERED,
                DeliveryStatus.READ,
              ] as DeliveryStatus[]
            ).includes(message.deliveryStatus)) ||
          confirmedSentAlreadyPersisted;
        const compatibleConfirmedNotSentState =
          (attempt.status === MessageAttemptStatus.PENDING &&
            message.deliveryStatus === DeliveryStatus.PENDING) ||
          confirmedLocalConfigurationFailure;
        if (
          (input.resolution === 'confirmed-sent' &&
            !compatibleConfirmedSentState) ||
          (input.resolution === 'confirmed-not-sent' &&
            !compatibleConfirmedNotSentState)
        ) {
          throw new AppError(
            'CONFLICT',
            'A mensagem ou a tentativa já possui um resultado incompatível.',
          );
        }
        if (
          input.resolution === 'confirmed-not-sent' &&
          (attempt.providerMessageId !== null ||
            message.providerMessageId !== null)
        ) {
          throw new AppError(
            'CONFLICT',
            'A ausência de envio não pode ser confirmada após um resultado positivo do provedor.',
          );
        }
        if (
          input.resolution === 'confirmed-sent' &&
          ((attempt.providerMessageId !== null &&
            attempt.providerMessageId !== providerMessageId) ||
            (message.providerMessageId !== null &&
              message.providerMessageId !== providerMessageId))
        ) {
          throw new AppError(
            'CONFLICT',
            'O identificador confirmado diverge do resultado já persistido.',
          );
        }

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: message.channelId,
            source: inboxSource,
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation(
              'whatsapp-automation-reconciliation',
              input.commandId,
            ),
          },
        });

        let nextAttemptId: string | null = null;
        let dispatchGeneration: string | null = null;
        if (input.resolution === 'confirmed-sent') {
          const finalDeliveryStatus = (
            [
              DeliveryStatus.SENT,
              DeliveryStatus.DELIVERED,
              DeliveryStatus.READ,
            ] as DeliveryStatus[]
          ).includes(message.deliveryStatus)
            ? message.deliveryStatus
            : DeliveryStatus.SENT;
          const proposalDocument =
            message.automationPurpose === 'quote-proposal'
              ? await transaction.quoteProposalDocument.findUnique({
                  where: {
                    messageId_companyId: {
                      messageId: message.id,
                      companyId: input.companyId,
                    },
                  },
                })
              : null;
          if (
            proposalDocument &&
            proposalDocument.status !== QuoteProposalDocumentStatus.QUEUED &&
            proposalDocument.status !== QuoteProposalDocumentStatus.SENT
          ) {
            throw new AppError(
              'CONFLICT',
              'A proposta não está mais aguardando confirmação de envio.',
            );
          }
          if (
            proposalDocument?.providerMessageId &&
            proposalDocument.providerMessageId !== providerMessageId
          ) {
            throw new AppError(
              'CONFLICT',
              'O identificador confirmado diverge da proposta persistida.',
            );
          }

          if (!confirmedSentAlreadyPersisted) {
            await transaction.whatsAppMessageAttempt.update({
              where: {
                id_companyId: { id: attempt.id, companyId: input.companyId },
              },
              data: {
                status: MessageAttemptStatus.SUCCEEDED,
                providerMessageId,
                errorCode: null,
                errorMessage: null,
                completedAt: now,
                dispatchState: EvolutionDispatchState.SUCCEEDED,
                dispatchLeaseUntil: null,
              },
            });
            await transaction.whatsAppMessage.update({
              where: {
                id_companyId: { id: message.id, companyId: input.companyId },
              },
              data: {
                deliveryStatus: finalDeliveryStatus,
                providerMessageId,
              },
            });
          }
          if (proposalDocument?.status === QuoteProposalDocumentStatus.QUEUED) {
            await this.lockCommand(
              transaction,
              input.companyId,
              'quote-proposal-delivery',
              proposalDocument.id,
            );
            const documentUpdated =
              await transaction.quoteProposalDocument.updateMany({
                where: {
                  id: proposalDocument.id,
                  companyId: input.companyId,
                  messageId: message.id,
                  status: QuoteProposalDocumentStatus.QUEUED,
                },
                data: {
                  status: QuoteProposalDocumentStatus.SENT,
                  providerMessageId,
                  sentAt: now,
                },
              });
            if (documentUpdated.count !== 1) {
              throw new AppError(
                'CONFLICT',
                'A proposta foi alterada durante a reconciliação.',
              );
            }
            await this.completeQuoteProposalBatchIfReady(transaction, {
              companyId: input.companyId,
              conversationId: message.conversationId,
              quoteRequestId: proposalDocument.quoteRequestId,
              triggeringDocumentId: proposalDocument.id,
              deliveryBatchId: proposalDocument.deliveryBatchId,
            });
          } else if (
            !confirmedSentAlreadyPersisted &&
            !proposalDocument &&
            message.automationPurpose !== 'department-notification'
          ) {
            await transaction.whatsAppConversation.update({
              where: {
                id_companyId: {
                  id: message.conversationId,
                  companyId: input.companyId,
                },
              },
              data: {
                lastOutboundAt: now,
                lastMessagePreview:
                  message.text?.slice(0, 240) ??
                  `[${kindFromPrisma[message.kind]}]`,
                ...(message.automationPurpose === 'main-menu'
                  ? { mainMenuPresentedAt: now }
                  : {}),
                ...(message.automationPurpose === 'commercial-follow-up-menu'
                  ? { followUpMenuPresentedAt: now }
                  : {}),
              },
            });
          }
          await transaction.integrationOutbox.update({
            where: {
              id_companyId: { id: event.id, companyId: input.companyId },
            },
            data: {
              status: IntegrationOutboxStatus.DELIVERED,
              deliveredAt: now,
              executionLeaseUntil: null,
              lockedAt: null,
              lockId: null,
              lastError: null,
            },
          });
        } else {
          await transaction.whatsAppMessageAttempt.update({
            where: {
              id_companyId: { id: attempt.id, companyId: input.companyId },
            },
            data: {
              status: MessageAttemptStatus.FAILED,
              errorCode: 'CONFIRMED_NOT_SENT',
              errorMessage: sanitizeLogText(evidence),
              completedAt: now,
              dispatchState: EvolutionDispatchState.FAILED,
              dispatchLeaseUntil: null,
            },
          });
          if (message.deliveryStatus === DeliveryStatus.FAILED) {
            await transaction.whatsAppMessage.update({
              where: {
                id_companyId: {
                  id: message.id,
                  companyId: input.companyId,
                },
              },
              data: { deliveryStatus: DeliveryStatus.PENDING },
            });
          }
          const nextAttempt = await transaction.whatsAppMessageAttempt.create({
            data: {
              companyId: input.companyId,
              messageId: message.id,
              attemptNumber:
                Math.max(
                  attempt.attemptNumber,
                  attemptNumbers._max.attemptNumber ?? 0,
                ) + 1,
              status: MessageAttemptStatus.PENDING,
              dispatchState: EvolutionDispatchState.READY,
            },
          });
          nextAttemptId = nextAttempt.id;
          dispatchGeneration = randomUUID();
          await transaction.integrationOutbox.update({
            where: {
              id_companyId: { id: event.id, companyId: input.companyId },
            },
            data: {
              payload: payload({
                ...eventPayload,
                eventId: dispatchGeneration,
                commandId: dispatchGeneration,
                attemptId: nextAttempt.id,
                dispatchGeneration,
              }),
              status: IntegrationOutboxStatus.PENDING,
              attempts: 0,
              availableAt: now,
              processingProvider: null,
              executionId: null,
              acceptedAt: null,
              executionLeaseUntil: null,
              deliveredAt: null,
              lockedAt: null,
              lockId: null,
              lastError: null,
            },
          });
        }

        const persistedResult = {
          eventId: event.id,
          messageId: message.id,
          previousAttemptId: attempt.id,
          ...(nextAttemptId ? { nextAttemptId } : {}),
          ...(dispatchGeneration ? { dispatchGeneration } : {}),
          resolution: input.resolution,
          status:
            input.resolution === 'confirmed-sent' ? 'delivered' : 'pending',
          providerMessageId:
            input.resolution === 'confirmed-sent' ? providerMessageId : null,
          evidence,
          reconciledBy: {
            id: input.serviceIdentityId,
            name: input.serviceIdentityName,
          },
          reconciledAt: now.toISOString(),
        };
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: now,
            resultSnapshot: payload(persistedResult),
          },
        });
        return { ...persistedResult, idempotent: false };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          input.companyId,
          inboxSource,
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async listQuoteProposals(
    companyId: string,
    query: QuoteProposalListQuery,
  ): Promise<unknown> {
    const pending = query.stage === 'pending';
    const filters = quoteProposalFilterWhere(query);
    const where: Prisma.QuoteRequestWhereInput = {
      AND: [quoteProposalStageWhere(companyId, query.stage), filters],
    };
    const stageWhere = (
      stage: QuoteProposalListQuery['stage'],
    ): Prisma.QuoteRequestWhereInput => ({
      AND: [quoteProposalStageWhere(companyId, stage), filters],
    });
    const [
      rows,
      total,
      pendingTotal,
      sentTotal,
      approvedTotal,
      cancelledTotal,
      cancellationReasonRows,
    ] = await this.prisma.$transaction([
      this.prisma.quoteRequest.findMany({
        where,
        include: {
          conversation: { include: conversationInclude },
          requestedByUser: { select: { id: true, name: true } },
          decidedByUser: { select: { id: true, name: true } },
          proposalDocuments: {
            ...(pending
              ? {}
              : { where: { status: QuoteProposalDocumentStatus.SENT } }),
            orderBy: pending
              ? [{ sequence: 'desc' }]
              : [{ sentAt: 'desc' }, { sequence: 'desc' }],
            include: {
              uploadedByUser: { select: { id: true, name: true } },
              sentByUser: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: pending
          ? [{ updatedAt: 'asc' }, { id: 'asc' }]
          : [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.quoteRequest.count({ where }),
      this.prisma.quoteRequest.count({ where: stageWhere('pending') }),
      this.prisma.quoteRequest.count({ where: stageWhere('sent') }),
      this.prisma.quoteRequest.count({ where: stageWhere('approved') }),
      this.prisma.quoteRequest.count({ where: stageWhere('cancelled') }),
      this.prisma.quoteRequest.groupBy({
        by: ['status', 'decisionReason'],
        where: stageWhere('cancelled'),
        orderBy: [{ status: 'asc' }, { decisionReason: 'asc' }],
        _count: { _all: true },
      }),
    ]);
    const cancellationReasonCounts = new Map<string, number>();
    for (const row of cancellationReasonRows) {
      const reason =
        row.decisionReason?.trim() ||
        (row.status === RequestStatus.CANCELLED
          ? 'Substituído por uma nova solicitação de orçamento.'
          : 'Motivo não informado (registro legado).');
      cancellationReasonCounts.set(
        reason,
        (cancellationReasonCounts.get(reason) ?? 0) +
          (typeof row._count === 'object' ? (row._count._all ?? 0) : 0),
      );
    }
    return {
      items: rows.map((row) => ({
        id: row.id,
        stage: query.stage,
        quoteRequest: presentQuote(row),
        conversation: presentConversation(row.conversation),
        proposalDocument: row.proposalDocuments[0]
          ? presentProposalDocument(row.proposalDocuments[0])
          : null,
        documents: row.proposalDocuments.map(presentProposalDocument),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
      summary: {
        pending: pendingTotal,
        sent: sentTotal,
        approved: approvedTotal,
        cancelled: cancelledTotal,
        cancellationReasons: Array.from(
          cancellationReasonCounts,
          ([reason, count]) => ({ reason, count }),
        ).sort(
          (left, right) =>
            right.count - left.count ||
            left.reason.localeCompare(right.reason, 'pt-BR'),
        ),
      },
      filters: {
        search: query.search ?? null,
        createdFrom: query.createdFrom ?? null,
        createdTo: query.createdTo ?? null,
      },
    };
  }

  async getQuoteProposalNotificationSummary(companyId: string, userId: string) {
    const pendingQuotes = await this.prisma.quoteRequest.findMany({
      where: pendingQuoteProposalWhere(companyId),
      select: {
        version: true,
        notificationReads: {
          where: {
            companyId,
            userId,
            notificationKey: COMMERCIAL_PENDING_QUOTES_NOTIFICATION,
          },
          select: { quoteVersion: true },
        },
      },
    });
    return {
      notificationId: COMMERCIAL_PENDING_QUOTES_NOTIFICATION,
      pendingTotal: pendingQuotes.length,
      unreadTotal: pendingQuotes.filter(
        (quote) =>
          !quote.notificationReads.some(
            (receipt) => receipt.quoteVersion === quote.version,
          ),
      ).length,
    };
  }

  async markQuoteProposalNotificationRead(companyId: string, userId: string) {
    return this.prisma.$transaction(async (transaction) => {
      const pendingQuotes = await transaction.quoteRequest.findMany({
        where: pendingQuoteProposalWhere(companyId),
        select: { id: true, version: true },
      });
      const readAt = new Date();
      const result =
        pendingQuotes.length === 0
          ? { count: 0 }
          : await transaction.quoteNotificationRead.createMany({
              data: pendingQuotes.map((quote) => ({
                companyId,
                userId,
                quoteRequestId: quote.id,
                notificationKey: COMMERCIAL_PENDING_QUOTES_NOTIFICATION,
                quoteVersion: quote.version,
                readAt,
              })),
              skipDuplicates: true,
            });
      return {
        notificationId: COMMERCIAL_PENDING_QUOTES_NOTIFICATION,
        pendingTotal: pendingQuotes.length,
        unreadTotal: 0,
        markedRead: result.count,
        readAt: readAt.toISOString(),
      };
    });
  }

  async getQuoteProposal(
    companyId: string,
    quoteRequestId: string,
  ): Promise<unknown> {
    const row = await this.prisma.quoteRequest.findUnique({
      where: { id_companyId: { id: quoteRequestId, companyId } },
      include: {
        conversation: { include: conversationInclude },
        requestedByUser: { select: { id: true, name: true } },
        decidedByUser: { select: { id: true, name: true } },
        proposalDocuments: {
          orderBy: { sequence: 'desc' },
          include: {
            uploadedByUser: { select: { id: true, name: true } },
            sentByUser: { select: { id: true, name: true } },
          },
        },
      },
    });
    if (!row || row.conversation.department !== DepartmentCode.COMMERCIAL) {
      throw notFound('Proposta comercial');
    }
    return {
      id: row.id,
      quoteRequest: presentQuote(row),
      conversation: presentConversation(row.conversation),
      proposalDocument: row.proposalDocuments[0]
        ? presentProposalDocument(row.proposalDocuments[0])
        : null,
      documents: row.proposalDocuments.map(presentProposalDocument),
    };
  }

  async createQuoteProposal(input: CreateQuoteProposalInput): Promise<unknown> {
    const normalized = {
      ...input,
      contactName: input.contactName.trim(),
      document: input.document?.trim() || null,
      email: input.email?.trim().toLowerCase() || null,
      serviceType: input.serviceType.trim(),
      origin: input.origin.trim(),
      destination: input.destination.trim(),
      departureAt: input.departureAt ?? null,
      departureDate:
        input.departureDate ??
        (input.departureAt ? dateOnlyFromDateTime(input.departureAt) : null),
      returnAt: input.returnAt ?? null,
      returnDate:
        input.returnDate ??
        (input.returnAt ? dateOnlyFromDateTime(input.returnAt) : null),
      vehicleType: input.vehicleType?.trim() || null,
      notes: input.notes?.trim() || null,
    };
    if (
      !normalized.contactName ||
      !normalized.serviceType ||
      !normalized.origin ||
      !normalized.destination
    ) {
      throw validationError(
        'Nome, tipo de serviço, origem e destino são obrigatórios.',
      );
    }
    assertQuoteScheduleConsistency(normalized, {
      requireDepartureDate: true,
    });
    if (
      normalized.departureAt &&
      normalized.returnAt &&
      normalized.returnAt < normalized.departureAt
    ) {
      throw validationError(
        'A data de retorno não pode ser anterior à data de saída.',
      );
    }
    if (
      normalized.departureDate &&
      normalized.returnDate &&
      normalized.returnDate < normalized.departureDate
    ) {
      throw validationError(
        'A data de retorno não pode ser anterior à data de saída.',
      );
    }

    const fingerprint = commandFingerprint(normalized);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'panel.quote-proposal-create',
          input.commandId,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'panel.quote-proposal-create',
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Criação da proposta incompleta.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        await this.lockCommand(
          transaction,
          input.companyId,
          'whatsapp-conversation',
          input.conversationId,
        );
        const conversation = await transaction.whatsAppConversation.findUnique({
          where: {
            id_companyId: {
              id: input.conversationId,
              companyId: input.companyId,
            },
          },
          include: {
            quoteRequests: {
              orderBy: { sequence: 'desc' },
              take: 1,
            },
          },
        });
        if (
          !conversation ||
          conversation.department !== DepartmentCode.COMMERCIAL
        ) {
          throw notFound('Conversa comercial');
        }
        if (conversation.closedAt) {
          throw quoteConversationClosed(conversation.id);
        }
        if (conversation.version !== input.expectedVersion) {
          throw currentVersionConflict(conversation.version);
        }
        if (
          conversation.assignedToUserId &&
          conversation.assignedToUserId !== input.actorUserId
        ) {
          throw forbidden('A conversa está atribuída a outro atendente.');
        }
        if (
          conversation.quoteRequests[0]?.status === RequestStatus.UNDER_REVIEW
        ) {
          throw validationError(
            'Já existe uma solicitação aguardando proposta para este cliente.',
          );
        }
        const actor = await transaction.user.findUnique({
          where: {
            id_companyId: {
              id: input.actorUserId,
              companyId: input.companyId,
            },
          },
          select: { id: true, name: true, isActive: true },
        });
        if (!actor?.isActive) {
          throw forbidden('O atendente não pertence ao tenant.');
        }
        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: conversation.channelId,
            source: 'panel.quote-proposal-create',
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation(
              'quote-proposal-create',
              input.commandId,
            ),
          },
        });

        const nextSequence = (conversation.quoteRequests[0]?.sequence ?? 0) + 1;
        const requestedAt = new Date();
        const confirmedSummary = {
          contactName: normalized.contactName,
          document: normalized.document,
          email: normalized.email,
          serviceType: normalized.serviceType,
          origin: normalized.origin,
          destination: normalized.destination,
          departureDate: presentDateOnly(normalized.departureDate),
          departureAt: normalized.departureAt?.toISOString() ?? null,
          returnDate: presentDateOnly(normalized.returnDate),
          returnAt: normalized.returnAt?.toISOString() ?? null,
          passengerCount: normalized.passengerCount,
          vehicleType: normalized.vehicleType,
          vehicleAtDisposal: normalized.vehicleAtDisposal,
          localTransfers: normalized.localTransfers,
          notes: normalized.notes,
          source: 'attendant-panel',
        };
        const quote = await transaction.quoteRequest.create({
          data: {
            companyId: input.companyId,
            conversationId: conversation.id,
            sequence: nextSequence,
            status: RequestStatus.UNDER_REVIEW,
            contactName: normalized.contactName,
            document: normalized.document,
            email: normalized.email,
            serviceType: normalized.serviceType,
            origin: normalized.origin,
            destination: normalized.destination,
            departureDate: normalized.departureDate,
            departureAt: normalized.departureAt,
            returnDate: normalized.returnDate,
            returnAt: normalized.returnAt,
            passengerCount: normalized.passengerCount,
            vehicleType: normalized.vehicleType,
            vehicleAtDisposal: normalized.vehicleAtDisposal,
            localTransfers: normalized.localTransfers,
            notes: normalized.notes,
            structuredData: payload({ source: 'attendant-panel' }),
            confirmedAt: requestedAt,
            confirmedSummary: payload(confirmedSummary),
            confirmedVersion: 1,
            requestedByUserId: actor.id,
          },
          include: {
            requestedByUser: { select: { id: true, name: true } },
            decidedByUser: { select: { id: true, name: true } },
          },
        });

        const updatedCount = await transaction.whatsAppConversation.updateMany({
          where: {
            id: conversation.id,
            companyId: input.companyId,
            version: input.expectedVersion,
          },
          data: {
            conversationState: ConversationState.HUMAN_ACTIVE,
            flowStep: FlowStep.QUOTE_SEND_PENDING,
            requestStatus: RequestStatus.UNDER_REVIEW,
            resumeState: null,
            resumeFlowStep: FlowStep.COMMERCIAL_FOLLOW_UP_MENU,
            assignedToUserId: actor.id,
            contextualFollowUpAt: null,
            lastMessagePreview: `Nova solicitação de orçamento #${nextSequence}.`,
            version: { increment: 1 },
          },
        });
        if (updatedCount.count !== 1) {
          const latest =
            await transaction.whatsAppConversation.findUniqueOrThrow({
              where: {
                id_companyId: {
                  id: conversation.id,
                  companyId: input.companyId,
                },
              },
              select: { version: true },
            });
          throw currentVersionConflict(latest.version);
        }
        const updatedConversation = await this.findConversationOrThrow(
          transaction,
          input.companyId,
          conversation.id,
        );
        if (
          conversation.conversationState !== ConversationState.HUMAN_ACTIVE ||
          conversation.assignedToUserId !== actor.id
        ) {
          await transaction.whatsAppConversationTransition.create({
            data: {
              companyId: input.companyId,
              conversationId: conversation.id,
              commandId: correlation(
                'quote-proposal-create-human-take-over',
                input.commandId,
              ),
              commandFingerprint: fingerprint,
              name: 'take-over',
              expectedVersion: conversation.version,
              resultingVersion: updatedConversation.version,
              actorType: TransitionActorType.USER,
              actorUserId: actor.id,
              fromDepartment: conversation.department,
              toDepartment: conversation.department,
              fromState: conversation.conversationState,
              toState: ConversationState.HUMAN_ACTIVE,
              fromFlowStep: conversation.flowStep,
              toFlowStep: FlowStep.QUOTE_SEND_PENDING,
              fromRequestStatus: conversation.requestStatus,
              toRequestStatus: RequestStatus.UNDER_REVIEW,
              metadata: payload({
                source: 'quote-proposal-create',
                quoteRequestId: quote.id,
              }),
              resultSnapshot: payload(presentConversation(updatedConversation)),
            },
          });
        }
        await transaction.tenantAuditLog.create({
          data: {
            companyId: input.companyId,
            actorUserId: actor.id,
            action: 'whatsapp.quote-proposal.create',
            targetType: 'quote-request',
            targetId: quote.id,
            metadata: payload({
              conversationId: conversation.id,
              sequence: nextSequence,
              commandId: input.commandId,
            }),
          },
        });
        const persistedResult = {
          id: quote.id,
          stage: 'pending',
          quoteRequest: presentQuote(quote),
          conversation: presentConversation(updatedConversation),
          proposalDocument: null,
        };
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: requestedAt,
            resultSnapshot: payload(persistedResult),
          },
        });
        return { ...persistedResult, idempotent: false };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          input.companyId,
          'panel.quote-proposal-create',
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async decideQuoteProposal(input: DecideQuoteProposalInput): Promise<unknown> {
    const reason = input.reason?.trim() || null;
    if (input.decision === 'rejected' && (!reason || reason.length < 3)) {
      throw validationError(
        'Informe um breve motivo, com pelo menos 3 caracteres, para recusar a proposta.',
      );
    }
    const fingerprint = commandFingerprint({ ...input, reason });
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'panel.quote-proposal-decision',
          input.commandId,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'panel.quote-proposal-decision',
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Decisão da proposta incompleta.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        const quoteLocator = await transaction.quoteRequest.findUnique({
          where: {
            id_companyId: {
              id: input.quoteRequestId,
              companyId: input.companyId,
            },
          },
          select: { conversationId: true },
        });
        if (!quoteLocator) throw notFound('Proposta comercial');
        await this.lockCommand(
          transaction,
          input.companyId,
          'whatsapp-conversation',
          quoteLocator.conversationId,
        );
        const quote = await transaction.quoteRequest.findUnique({
          where: {
            id_companyId: {
              id: input.quoteRequestId,
              companyId: input.companyId,
            },
          },
          include: {
            conversation: {
              include: {
                ...conversationInclude,
                quoteRequests: {
                  orderBy: { sequence: 'desc' },
                  take: 1,
                },
              },
            },
            proposalDocuments: {
              where: { status: QuoteProposalDocumentStatus.SENT },
              orderBy: [{ sentAt: 'desc' }, { sequence: 'desc' }],
              take: 1,
              include: {
                uploadedByUser: { select: { id: true, name: true } },
                sentByUser: { select: { id: true, name: true } },
              },
            },
          },
        });
        if (
          !quote ||
          quote.conversation.department !== DepartmentCode.COMMERCIAL
        ) {
          throw notFound('Proposta comercial');
        }
        if (quote.conversation.closedAt) {
          throw quoteConversationClosed(
            quote.conversation.id,
            'Não é possível alterar uma proposta de atendimento encerrado.',
          );
        }
        if (!quote.proposalDocuments[0]) {
          throw validationError(
            'A proposta só pode ser aprovada ou recusada após a confirmação do envio.',
          );
        }
        if (
          quote.status === RequestStatus.APPROVED ||
          quote.status === RequestStatus.REJECTED
        ) {
          throw new AppError(
            'CONFLICT',
            'A decisão desta proposta é final e não pode ser alterada.',
          );
        }
        if (quote.conversation.version !== input.expectedVersion) {
          throw currentVersionConflict(quote.conversation.version);
        }
        const actor = await transaction.user.findUnique({
          where: {
            id_companyId: {
              id: input.actorUserId,
              companyId: input.companyId,
            },
          },
          select: { id: true, name: true, isActive: true },
        });
        if (!actor?.isActive) {
          throw forbidden('O atendente não pertence ao tenant.');
        }
        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: quote.conversation.channelId,
            source: 'panel.quote-proposal-decision',
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation(
              'quote-proposal-decision',
              input.commandId,
            ),
          },
        });
        const decidedAt = new Date();
        const decisionStatus =
          input.decision === 'approved'
            ? RequestStatus.APPROVED
            : RequestStatus.REJECTED;
        const updatedQuote = await transaction.quoteRequest.update({
          where: {
            id_companyId: {
              id: quote.id,
              companyId: input.companyId,
            },
          },
          data: {
            status: decisionStatus,
            decisionReason: input.decision === 'rejected' ? reason : null,
            decidedAt,
            decidedByUserId: actor.id,
            version: { increment: 1 },
          },
          include: {
            requestedByUser: { select: { id: true, name: true } },
            decidedByUser: { select: { id: true, name: true } },
          },
        });

        const isCurrentRequest =
          quote.conversation.quoteRequests[0]?.id === quote.id;
        if (isCurrentRequest) {
          const updatedConversation =
            await transaction.whatsAppConversation.updateMany({
              where: {
                id: quote.conversationId,
                companyId: input.companyId,
                version: input.expectedVersion,
              },
              data: {
                requestStatus: decisionStatus,
                lastMessagePreview:
                  input.decision === 'approved'
                    ? 'Proposta aprovada.'
                    : 'Proposta recusada.',
                version: { increment: 1 },
              },
            });
          if (updatedConversation.count !== 1) {
            const latest =
              await transaction.whatsAppConversation.findUniqueOrThrow({
                where: {
                  id_companyId: {
                    id: quote.conversationId,
                    companyId: input.companyId,
                  },
                },
                select: { version: true },
              });
            throw currentVersionConflict(latest.version);
          }
        }
        const finalConversation = await this.findConversationOrThrow(
          transaction,
          input.companyId,
          quote.conversationId,
        );
        await transaction.tenantAuditLog.create({
          data: {
            companyId: input.companyId,
            actorUserId: actor.id,
            action: `whatsapp.quote-proposal.${input.decision}`,
            targetType: 'quote-request',
            targetId: quote.id,
            metadata: payload({
              conversationId: quote.conversationId,
              commandId: input.commandId,
              reason: input.decision === 'rejected' ? reason : null,
            }),
          },
        });
        const persistedResult = {
          id: updatedQuote.id,
          stage: input.decision === 'approved' ? 'approved' : 'cancelled',
          quoteRequest: presentQuote(updatedQuote),
          conversation: presentConversation(finalConversation),
          proposalDocument: presentProposalDocument(quote.proposalDocuments[0]),
        };
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: decidedAt,
            resultSnapshot: payload(persistedResult),
          },
        });
        return { ...persistedResult, idempotent: false };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          input.companyId,
          'panel.quote-proposal-decision',
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async updateQuoteProposalStatus(
    input: UpdateQuoteProposalStatusInput,
  ): Promise<unknown> {
    const reason = input.reason?.trim() || null;
    if (input.status === 'cancelled' && (!reason || reason.length < 3)) {
      throw validationError(
        'Informe um breve motivo, com pelo menos 3 caracteres, para cancelar o orçamento.',
      );
    }
    const fingerprint = commandFingerprint({ ...input, reason });

    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'panel.quote-proposal-status',
          input.commandId,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'panel.quote-proposal-status',
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError(
              'CONFLICT',
              'Alteração do status comercial incompleta.',
            );
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        const quoteLocator = await transaction.quoteRequest.findUnique({
          where: {
            id_companyId: {
              id: input.quoteRequestId,
              companyId: input.companyId,
            },
          },
          select: { conversationId: true },
        });
        if (!quoteLocator) throw notFound('Orçamento comercial');

        await this.lockCommand(
          transaction,
          input.companyId,
          'whatsapp-conversation',
          quoteLocator.conversationId,
        );
        const quote = await transaction.quoteRequest.findUnique({
          where: {
            id_companyId: {
              id: input.quoteRequestId,
              companyId: input.companyId,
            },
          },
          include: {
            conversation: {
              include: {
                ...conversationInclude,
                quoteRequests: {
                  orderBy: { sequence: 'desc' },
                  take: 1,
                },
              },
            },
            proposalDocuments: {
              where: { status: QuoteProposalDocumentStatus.SENT },
              orderBy: [{ sentAt: 'desc' }, { sequence: 'desc' }],
              include: {
                uploadedByUser: { select: { id: true, name: true } },
                sentByUser: { select: { id: true, name: true } },
              },
            },
          },
        });
        if (
          !quote ||
          quote.conversation.department !== DepartmentCode.COMMERCIAL ||
          quote.conversation.quoteRequests[0]?.id !== quote.id
        ) {
          throw notFound('Orçamento comercial atual');
        }
        if (quote.conversation.closedAt) {
          throw quoteConversationClosed(
            quote.conversation.id,
            'Não é possível alterar o status de um atendimento encerrado.',
          );
        }
        if (quote.conversation.version !== input.expectedVersion) {
          throw currentVersionConflict(quote.conversation.version);
        }
        if (quote.conversation.assignedToUserId !== input.actorUserId) {
          throw forbidden(
            'Assuma o atendimento antes de alterar o status comercial.',
          );
        }
        if (
          quote.status === RequestStatus.APPROVED ||
          quote.status === RequestStatus.REJECTED ||
          quote.status === RequestStatus.CANCELLED
        ) {
          throw new AppError(
            'CONFLICT',
            'O status final deste orçamento não pode ser alterado.',
          );
        }
        if (requestFromPrisma[quote.status] === input.status) {
          throw validationError(
            'O orçamento já está no status comercial selecionado.',
          );
        }
        if (
          input.status === 'waiting-for-customer' &&
          quote.proposalDocuments.length === 0
        ) {
          throw validationError(
            'O status Aguardando cliente exige ao menos uma proposta entregue.',
          );
        }

        const actor = await transaction.user.findUnique({
          where: {
            id_companyId: {
              id: input.actorUserId,
              companyId: input.companyId,
            },
          },
          select: { id: true, name: true, isActive: true },
        });
        if (!actor?.isActive) {
          throw forbidden('O atendente não pertence ao tenant.');
        }
        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: quote.conversation.channelId,
            source: 'panel.quote-proposal-status',
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation(
              'quote-proposal-status',
              input.commandId,
            ),
          },
        });

        const changedAt = new Date();
        const targetStatus = requestToPrisma[input.status];
        const quoteUpdate = await transaction.quoteRequest.updateMany({
          where: {
            id: quote.id,
            companyId: input.companyId,
            version: quote.version,
          },
          data: {
            status: targetStatus,
            decisionReason: input.status === 'cancelled' ? reason : null,
            decidedAt: input.status === 'cancelled' ? changedAt : null,
            decidedByUserId:
              input.status === 'cancelled' ? input.actorUserId : null,
            version: { increment: 1 },
          },
        });
        if (quoteUpdate.count !== 1) {
          const latest = await transaction.quoteRequest.findUniqueOrThrow({
            where: {
              id_companyId: {
                id: quote.id,
                companyId: input.companyId,
              },
            },
            select: { version: true },
          });
          throw new AppError(
            'CONFLICT',
            'O orçamento foi alterado por outro comando.',
            { currentQuoteVersion: latest.version },
          );
        }

        const conversationUpdate =
          await transaction.whatsAppConversation.updateMany({
            where: {
              id: quote.conversationId,
              companyId: input.companyId,
              version: input.expectedVersion,
            },
            data: {
              requestStatus: targetStatus,
              lastMessagePreview:
                input.status === 'cancelled'
                  ? 'Orçamento cancelado pelo atendente.'
                  : input.status === 'under-review'
                    ? 'Orçamento em análise comercial.'
                    : 'Proposta entregue; aguardando retorno do cliente.',
              version: { increment: 1 },
            },
          });
        if (conversationUpdate.count !== 1) {
          const latest =
            await transaction.whatsAppConversation.findUniqueOrThrow({
              where: {
                id_companyId: {
                  id: quote.conversationId,
                  companyId: input.companyId,
                },
              },
              select: { version: true },
            });
          throw currentVersionConflict(latest.version);
        }

        const [updatedQuote, finalConversation] = await Promise.all([
          transaction.quoteRequest.findUniqueOrThrow({
            where: {
              id_companyId: {
                id: quote.id,
                companyId: input.companyId,
              },
            },
            include: {
              requestedByUser: { select: { id: true, name: true } },
              decidedByUser: { select: { id: true, name: true } },
            },
          }),
          this.findConversationOrThrow(
            transaction,
            input.companyId,
            quote.conversationId,
          ),
        ]);
        await transaction.tenantAuditLog.create({
          data: {
            companyId: input.companyId,
            actorUserId: input.actorUserId,
            action: 'whatsapp.quote-proposal.status-change',
            targetType: 'quote-request',
            targetId: quote.id,
            metadata: payload({
              conversationId: quote.conversationId,
              commandId: input.commandId,
              fromStatus: requestFromPrisma[quote.status],
              toStatus: input.status,
              reason,
              occurredAt: changedAt.toISOString(),
            }),
          },
        });
        const persistedResult = {
          id: updatedQuote.id,
          stage:
            input.status === 'cancelled'
              ? 'cancelled'
              : input.status === 'waiting-for-customer'
                ? 'sent'
                : 'pending',
          quoteRequest: presentQuote(updatedQuote),
          conversation: presentConversation(finalConversation),
          proposalDocument: quote.proposalDocuments[0]
            ? presentProposalDocument(quote.proposalDocuments[0])
            : null,
          documents: quote.proposalDocuments.map(presentProposalDocument),
        };
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: changedAt,
            resultSnapshot: payload(persistedResult),
          },
        });
        return { ...persistedResult, idempotent: false };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          input.companyId,
          'panel.quote-proposal-status',
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async uploadQuoteProposalDocument(
    input: UploadQuoteProposalDocumentInput,
  ): Promise<unknown> {
    const validatedFile = validateQuoteProposalPdf(input.file);
    const fingerprint = commandFingerprint({
      companyId: input.companyId,
      quoteRequestId: input.quoteRequestId,
      actorUserId: input.actorUserId,
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
      fileName: validatedFile.fileName,
      mimeType: input.file.mimeType.toLowerCase(),
      sizeBytes: input.file.sizeBytes,
      sha256: validatedFile.sha256,
    });
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'panel.quote-proposal-upload',
          input.commandId,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'panel.quote-proposal-upload',
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Upload da proposta incompleto.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        const quoteLocator = await transaction.quoteRequest.findUnique({
          where: {
            id_companyId: {
              id: input.quoteRequestId,
              companyId: input.companyId,
            },
          },
          select: { conversationId: true },
        });
        if (!quoteLocator) {
          throw notFound('Solicitação de orçamento');
        }
        await this.lockCommand(
          transaction,
          input.companyId,
          'whatsapp-conversation',
          quoteLocator.conversationId,
        );
        const quote = await transaction.quoteRequest.findUnique({
          where: {
            id_companyId: {
              id: input.quoteRequestId,
              companyId: input.companyId,
            },
          },
          include: {
            conversation: {
              include: {
                quoteRequests: {
                  orderBy: [{ sequence: 'desc' }, { id: 'desc' }],
                  take: 1,
                  select: { id: true },
                },
              },
            },
          },
        });
        if (
          !quote ||
          quote.conversation.department !== DepartmentCode.COMMERCIAL
        ) {
          throw notFound('Solicitação de orçamento');
        }
        if (quote.conversation.closedAt) {
          throw quoteConversationClosed(quote.conversation.id);
        }
        if (
          !acceptsProposalDocumentsForCurrentCycle(
            quote,
            quote.conversation.quoteRequests[0],
          )
        ) {
          throw validationError(
            'A proposta só pode ser anexada enquanto o orçamento aguarda proposta.',
          );
        }
        if (quote.conversation.version !== input.expectedVersion) {
          throw currentVersionConflict(quote.conversation.version);
        }
        const actor = await transaction.user.findUnique({
          where: {
            id_companyId: {
              id: input.actorUserId,
              companyId: input.companyId,
            },
          },
          select: { id: true, name: true, isActive: true },
        });
        if (!actor?.isActive) {
          throw forbidden('O atendente não pertence ao tenant.');
        }
        const activeBatchDocuments =
          await transaction.quoteProposalDocument.count({
            where: {
              companyId: input.companyId,
              quoteRequestId: input.quoteRequestId,
              deliveryBatchId: { not: null },
              status: {
                in: [
                  QuoteProposalDocumentStatus.UPLOADED,
                  QuoteProposalDocumentStatus.QUEUED,
                  QuoteProposalDocumentStatus.FAILED,
                ],
              },
            },
          });
        if (activeBatchDocuments > 0) {
          throw new AppError(
            'CONFLICT',
            'Conclua ou reenvie o lote atual antes de adicionar outro documento.',
          );
        }

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: quote.conversation.channelId,
            source: 'panel.quote-proposal-upload',
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation(
              'quote-proposal-upload',
              input.commandId,
            ),
          },
        });
        const latest = await transaction.quoteProposalDocument.aggregate({
          where: {
            companyId: input.companyId,
            quoteRequestId: input.quoteRequestId,
          },
          _max: { sequence: true },
        });
        const document = await transaction.quoteProposalDocument.create({
          data: {
            companyId: input.companyId,
            conversationId: quote.conversationId,
            quoteRequestId: input.quoteRequestId,
            uploadedByUserId: input.actorUserId,
            sequence: (latest._max.sequence ?? 0) + 1,
            fileName: validatedFile.fileName,
            mimeType: 'application/pdf',
            sizeBytes: input.file.sizeBytes,
            sha256: validatedFile.sha256,
            content: Uint8Array.from(input.file.content),
          },
          include: {
            uploadedByUser: { select: { id: true, name: true } },
            sentByUser: { select: { id: true, name: true } },
          },
        });
        await transaction.tenantAuditLog.create({
          data: {
            companyId: input.companyId,
            actorUserId: input.actorUserId,
            action: 'whatsapp.quote-proposal.upload',
            targetType: 'quote-proposal-document',
            targetId: document.id,
            metadata: payload({
              quoteRequestId: input.quoteRequestId,
              conversationId: quote.conversationId,
              commandId: input.commandId,
              fileName: document.fileName,
              sizeBytes: document.sizeBytes,
              sha256: document.sha256,
            }),
          },
        });
        const persistedResult = {
          proposalDocument: presentProposalDocument(document),
          conversation: {
            id: quote.conversation.id,
            version: quote.conversation.version,
          },
        };
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: new Date(),
            resultSnapshot: payload(persistedResult),
          },
        });
        return { ...persistedResult, idempotent: false };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          input.companyId,
          'panel.quote-proposal-upload',
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async sendQuoteProposal(input: SendQuoteProposalInput): Promise<unknown> {
    const uniqueBatchDocumentIds = new Set(input.batchDocumentIds);
    if (
      input.batchDocumentIds.length < 1 ||
      input.batchDocumentIds.length > 10 ||
      uniqueBatchDocumentIds.size !== input.batchDocumentIds.length ||
      !uniqueBatchDocumentIds.has(input.proposalDocumentId)
    ) {
      throw validationError(
        'O lote deve informar de 1 a 10 documentos únicos e incluir o PDF enviado.',
      );
    }
    const fingerprint = commandFingerprint(input);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'panel.quote-proposal-send',
          input.commandId,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'panel.quote-proposal-send',
            externalEventId: input.commandId,
          },
        };
        const duplicate = await transaction.integrationInbox.findUnique({
          where: inboxKey,
        });
        if (duplicate) {
          assertSameFingerprint(
            duplicate.payloadHash,
            fingerprint,
            'commandId',
          );
          if (!duplicate.resultSnapshot) {
            throw new AppError('CONFLICT', 'Envio da proposta incompleto.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        const quoteLocator = await transaction.quoteRequest.findUnique({
          where: {
            id_companyId: {
              id: input.quoteRequestId,
              companyId: input.companyId,
            },
          },
          select: { conversationId: true },
        });
        if (!quoteLocator) {
          throw notFound('Solicitação de orçamento');
        }
        await this.lockCommand(
          transaction,
          input.companyId,
          'whatsapp-conversation',
          quoteLocator.conversationId,
        );
        const quote = await transaction.quoteRequest.findUnique({
          where: {
            id_companyId: {
              id: input.quoteRequestId,
              companyId: input.companyId,
            },
          },
          include: {
            conversation: {
              include: {
                contact: true,
                channel: {
                  select: { id: true, name: true, phoneNumber: true },
                },
                assignedTo: { select: { id: true, name: true } },
                quoteRequests: {
                  orderBy: { sequence: 'desc' },
                  take: 1,
                },
              },
            },
          },
        });
        if (
          !quote ||
          quote.conversation.department !== DepartmentCode.COMMERCIAL
        ) {
          throw notFound('Solicitação de orçamento');
        }
        const conversation = quote.conversation;
        if (conversation.closedAt) {
          throw quoteConversationClosed(
            conversation.id,
            'Não é possível enviar proposta em um atendimento encerrado.',
          );
        }
        if (
          !acceptsProposalDocumentsForCurrentCycle(
            quote,
            conversation.quoteRequests[0],
          )
        ) {
          throw validationError(
            'A proposta só pode ser enviada pela fila comercial Aguardando proposta.',
          );
        }
        if (
          conversation.assignedToUserId &&
          conversation.assignedToUserId !== input.actorUserId
        ) {
          throw forbidden('A conversa está atribuída a outro atendente.');
        }
        if (conversation.version !== input.expectedVersion) {
          throw currentVersionConflict(conversation.version);
        }
        const actor = await transaction.user.findUnique({
          where: {
            id_companyId: {
              id: input.actorUserId,
              companyId: input.companyId,
            },
          },
          select: { id: true, name: true, isActive: true },
        });
        if (!actor?.isActive) {
          throw forbidden('O atendente não pertence ao tenant.');
        }
        const document = await transaction.quoteProposalDocument.findUnique({
          where: {
            id_companyId: {
              id: input.proposalDocumentId,
              companyId: input.companyId,
            },
          },
        });
        if (
          !document ||
          document.quoteRequestId !== input.quoteRequestId ||
          document.conversationId !== conversation.id
        ) {
          throw notFound('Documento da proposta');
        }
        if (
          document.status !== QuoteProposalDocumentStatus.UPLOADED &&
          document.status !== QuoteProposalDocumentStatus.FAILED
        ) {
          throw validationError(
            'Somente um documento ainda não enviado ou com falha pode ser confirmado.',
          );
        }
        const batchDocuments = await transaction.quoteProposalDocument.findMany(
          {
            where: {
              companyId: input.companyId,
              quoteRequestId: input.quoteRequestId,
              conversationId: conversation.id,
              id: { in: input.batchDocumentIds },
            },
            select: { id: true, deliveryBatchId: true, status: true },
          },
        );
        if (
          batchDocuments.length !== input.batchDocumentIds.length ||
          batchDocuments.some(
            (item) =>
              item.deliveryBatchId !== null &&
              item.deliveryBatchId !== input.batchId,
          )
        ) {
          throw new AppError(
            'CONFLICT',
            'Os documentos informados não pertencem integralmente a este lote.',
          );
        }
        const existingBatchDocuments =
          await transaction.quoteProposalDocument.findMany({
            where: {
              companyId: input.companyId,
              quoteRequestId: input.quoteRequestId,
              deliveryBatchId: input.batchId,
            },
            select: { id: true },
          });
        if (
          existingBatchDocuments.length === 0 &&
          batchDocuments.some(
            (item) =>
              item.status !== QuoteProposalDocumentStatus.UPLOADED &&
              item.status !== QuoteProposalDocumentStatus.FAILED,
          )
        ) {
          throw validationError(
            'Um novo lote aceita somente documentos ainda não enviados ou com falha.',
          );
        }
        if (
          existingBatchDocuments.length > 0 &&
          (existingBatchDocuments.length !== input.batchDocumentIds.length ||
            existingBatchDocuments.some(
              (item) => !uniqueBatchDocumentIds.has(item.id),
            ))
        ) {
          throw new AppError(
            'CONFLICT',
            'A composição deste lote não pode ser alterada após o primeiro envio.',
          );
        }
        const competingBatch =
          await transaction.quoteProposalDocument.findFirst({
            where: {
              companyId: input.companyId,
              quoteRequestId: input.quoteRequestId,
              deliveryBatchId: { not: null, notIn: [input.batchId] },
              status: {
                in: [
                  QuoteProposalDocumentStatus.UPLOADED,
                  QuoteProposalDocumentStatus.QUEUED,
                  QuoteProposalDocumentStatus.FAILED,
                ],
              },
            },
            select: { deliveryBatchId: true },
          });
        if (competingBatch) {
          throw new AppError(
            'CONFLICT',
            'Existe outro lote de proposta aguardando conclusão.',
          );
        }
        await transaction.quoteProposalDocument.updateMany({
          where: {
            companyId: input.companyId,
            quoteRequestId: input.quoteRequestId,
            id: { in: input.batchDocumentIds },
            deliveryBatchId: null,
          },
          data: { deliveryBatchId: input.batchId },
        });

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: conversation.channelId,
            source: 'panel.quote-proposal-send',
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation(
              'quote-proposal-send-inbox',
              input.commandId,
            ),
          },
        });
        const caption = 'Segue o orçamento solicitado.';
        const occurredAt = new Date();
        const media = {
          documentId: document.id,
          fileName: document.fileName,
          mimetype: document.mimeType,
          sizeBytes: document.sizeBytes,
          sha256: document.sha256,
          caption,
        };
        const message = await transaction.whatsAppMessage.create({
          data: {
            companyId: input.companyId,
            conversationId: conversation.id,
            channelId: conversation.channelId,
            contactId: conversation.contactId,
            actorUserId: input.actorUserId,
            direction: MessageDirection.OUTBOUND,
            deliveryStatus: DeliveryStatus.PENDING,
            kind: MessageKind.DOCUMENT,
            text: caption,
            media: payload(media),
            automationPurpose: 'quote-proposal',
            recipientPhone: conversation.contact.phoneNormalized,
            correlationId: correlation(
              'quote-proposal-outbound',
              input.commandId,
            ),
            occurredAt,
          },
        });
        const attempt = await transaction.whatsAppMessageAttempt.create({
          data: {
            companyId: input.companyId,
            messageId: message.id,
            attemptNumber: 1,
            status: MessageAttemptStatus.PENDING,
          },
        });
        const queuedDocument = await transaction.quoteProposalDocument.update({
          where: {
            id_companyId: {
              id: document.id,
              companyId: input.companyId,
            },
          },
          data: {
            status: QuoteProposalDocumentStatus.QUEUED,
            messageId: message.id,
            deliveryBatchId: input.batchId,
            queuedAt: occurredAt,
            sentByUserId: input.actorUserId,
            providerMessageId: null,
            sentAt: null,
          },
          include: {
            uploadedByUser: { select: { id: true, name: true } },
            sentByUser: { select: { id: true, name: true } },
          },
        });
        if (quote.status === RequestStatus.WAITING_FOR_CUSTOMER) {
          await transaction.quoteRequest.update({
            where: {
              id_companyId: {
                id: quote.id,
                companyId: input.companyId,
              },
            },
            data: {
              status: RequestStatus.UNDER_REVIEW,
              version: { increment: 1 },
            },
          });
        }
        const updatedCount = await transaction.whatsAppConversation.updateMany({
          where: {
            id: conversation.id,
            companyId: input.companyId,
            version: input.expectedVersion,
          },
          data: {
            conversationState: ConversationState.HUMAN_ACTIVE,
            flowStep: FlowStep.QUOTE_SEND_PENDING,
            requestStatus: RequestStatus.UNDER_REVIEW,
            assignedToUserId: input.actorUserId,
            resumeState: null,
            resumeFlowStep: FlowStep.COMMERCIAL_FOLLOW_UP_MENU,
            lastMessagePreview: 'Orçamento em PDF aguardando envio.',
            version: { increment: 1 },
          },
        });
        if (updatedCount.count !== 1) {
          const latest =
            await transaction.whatsAppConversation.findUniqueOrThrow({
              where: {
                id_companyId: {
                  id: conversation.id,
                  companyId: input.companyId,
                },
              },
              select: { version: true },
            });
          throw currentVersionConflict(latest.version);
        }
        const updatedConversation = await this.findConversationOrThrow(
          transaction,
          input.companyId,
          conversation.id,
        );
        if (
          conversation.conversationState !== ConversationState.HUMAN_ACTIVE ||
          conversation.assignedToUserId !== input.actorUserId
        ) {
          await transaction.whatsAppConversationTransition.create({
            data: {
              companyId: input.companyId,
              conversationId: conversation.id,
              commandId: correlation(
                'quote-proposal-human-take-over',
                input.commandId,
              ),
              commandFingerprint: fingerprint,
              name: 'take-over',
              expectedVersion: conversation.version,
              resultingVersion: updatedConversation.version,
              actorType: TransitionActorType.USER,
              actorUserId: input.actorUserId,
              fromDepartment: conversation.department,
              toDepartment: conversation.department,
              fromState: conversation.conversationState,
              toState: ConversationState.HUMAN_ACTIVE,
              fromFlowStep: conversation.flowStep,
              toFlowStep: FlowStep.QUOTE_SEND_PENDING,
              fromRequestStatus: conversation.requestStatus,
              toRequestStatus: RequestStatus.UNDER_REVIEW,
              metadata: payload({
                source: 'quote-proposal-send',
                quoteRequestId: quote.id,
                proposalDocumentId: document.id,
              }),
              resultSnapshot: payload(presentConversation(updatedConversation)),
            },
          });
        }
        await this.createOrderedOutbox(transaction, {
          companyId: input.companyId,
          topic: 'whatsapp.outbound.requested',
          aggregateType: 'whatsapp-conversation',
          aggregateId: conversation.id,
          correlationId: correlation(
            'quote-proposal-outbound-request',
            input.commandId,
          ),
          payload: {
            eventId: input.commandId,
            commandId: input.commandId,
            messageId: message.id,
            attemptId: attempt.id,
            conversationId: conversation.id,
            channelId: conversation.channelId,
            companyId: input.companyId,
            contact: {
              id: conversation.contact.id,
              phone: conversation.contact.phoneNormalized,
              displayName: conversation.contact.displayName,
            },
            message: {
              providerMessageId: null,
              direction: 'outbound',
              deliveryStatus: 'pending',
              kind: 'document',
              text: caption,
              media,
              occurredAt: message.occurredAt.toISOString(),
            },
            conversation: {
              id: updatedConversation.id,
              ...snapshot(updatedConversation),
              version: updatedConversation.version,
            },
            automatic: false,
            automationAllowed: false,
            canGenerateReply: false,
            canSendReply: true,
            contextualTransition: false,
            isFirstContact: false,
          },
        });
        await transaction.tenantAuditLog.create({
          data: {
            companyId: input.companyId,
            actorUserId: input.actorUserId,
            action: 'whatsapp.quote-proposal.send',
            targetType: 'quote-proposal-document',
            targetId: document.id,
            metadata: payload({
              quoteRequestId: quote.id,
              conversationId: conversation.id,
              messageId: message.id,
              commandId: input.commandId,
              sha256: document.sha256,
            }),
          },
        });
        const persistedResult = {
          message: this.presentMessage(
            { ...message, actorUser: actor, attempts: [attempt] },
            false,
          ),
          conversation: presentConversation(updatedConversation),
          proposalDocument: presentProposalDocument(queuedDocument),
        };
        await transaction.integrationInbox.update({
          where: inboxKey,
          data: {
            processedAt: occurredAt,
            resultSnapshot: payload(persistedResult),
          },
        });
        return { ...persistedResult, idempotent: false };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        return this.replayInbox(
          input.companyId,
          'panel.quote-proposal-send',
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async getQuoteProposalDocument(
    companyId: string,
    documentId: string,
  ): Promise<unknown> {
    const document = await this.prisma.quoteProposalDocument.findUnique({
      where: { id_companyId: { id: documentId, companyId } },
    });
    if (!document) throw notFound('Documento da proposta');
    return {
      ...presentProposalDocument(document),
      content: Buffer.from(document.content),
    };
  }

  async listConversations(
    companyId: string,
    query: ConversationListQuery,
  ): Promise<unknown> {
    if (
      query.requestStatus &&
      query.department &&
      query.department !== 'commercial'
    ) {
      throw validationError(
        'O status da solicitação pertence somente à fila Comercial.',
      );
    }
    const department = query.requestStatus
      ? DepartmentCode.COMMERCIAL
      : query.department
        ? departmentToPrisma[query.department]
        : undefined;
    const state = query.state ? stateToPrisma[query.state] : undefined;
    const requestStatus = query.requestStatus
      ? requestToPrisma[query.requestStatus]
      : undefined;
    const search = query.search?.trim();
    const where: Prisma.WhatsAppConversationWhereInput = {
      companyId,
      ...(department ? { department } : {}),
      ...(state ? { conversationState: state } : {}),
      ...(requestStatus ? { requestStatus } : {}),
      ...(search
        ? {
            contact: {
              OR: [
                { displayName: { contains: search, mode: 'insensitive' } },
                { phoneNormalized: { contains: search } },
              ],
            },
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.whatsAppConversation.findMany({
        where,
        include: conversationInclude,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.whatsAppConversation.count({ where }),
    ]);
    return {
      data: rows.map(presentConversation),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async getConversation(
    companyId: string,
    conversationId: string,
  ): Promise<unknown> {
    const conversation = await this.prisma.whatsAppConversation.findUnique({
      where: {
        id_companyId: {
          id: conversationId,
          companyId,
        },
      },
      include: conversationDetailInclude,
    });
    if (!conversation) throw notFound('Conversa');
    return presentConversationDetail(conversation);
  }

  async getAutomationBatch(
    companyId: string,
    conversationId: string,
    sourceEventId: string,
    windowSeconds: number,
  ): Promise<unknown> {
    if (
      !Number.isInteger(windowSeconds) ||
      windowSeconds < 1 ||
      windowSeconds > 300
    ) {
      throw validationError(
        'A janela do lote de automação deve estar entre 1 e 300 segundos.',
      );
    }
    const conversation = await this.prisma.whatsAppConversation.findUnique({
      where: { id_companyId: { id: conversationId, companyId } },
      include: conversationDetailInclude,
    });
    if (!conversation) throw notFound('Conversa');

    const anchor = await this.prisma.whatsAppMessage.findUnique({
      where: {
        companyId_correlationId: {
          companyId,
          correlationId: sourceEventId,
        },
      },
      select: {
        id: true,
        conversationId: true,
        direction: true,
        kind: true,
        correlationId: true,
        text: true,
        occurredAt: true,
        createdAt: true,
      },
    });
    if (
      !anchor ||
      anchor.conversationId !== conversationId ||
      anchor.direction !== MessageDirection.INBOUND
    ) {
      throw notFound('Mensagem inicial do lote de automação');
    }

    const windowEndsAt = new Date(
      anchor.createdAt.valueOf() + windowSeconds * 1_000,
    );
    const messages =
      anchor.kind === MessageKind.TEXT
        ? await this.prisma.whatsAppMessage.findMany({
            where: {
              companyId,
              conversationId,
              direction: MessageDirection.INBOUND,
              kind: MessageKind.TEXT,
              createdAt: {
                gte: anchor.createdAt,
                lte: windowEndsAt,
              },
            },
            select: {
              id: true,
              correlationId: true,
              kind: true,
              text: true,
              occurredAt: true,
              createdAt: true,
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 50,
          })
        : [anchor];
    const shouldRecoverPendingQuestion =
      anchor.kind !== MessageKind.TEXT &&
      (conversation.flowStep === FlowStep.QUOTE_DATA_COLLECTION ||
        conversation.flowStep === FlowStep.QUOTE_SUMMARY_CONFIRMATION);
    const pendingQuestion = shouldRecoverPendingQuestion
      ? await this.prisma.whatsAppMessage.findFirst({
          where: {
            companyId,
            conversationId,
            direction: MessageDirection.OUTBOUND,
            kind: MessageKind.TEXT,
            deliveryStatus: { not: DeliveryStatus.FAILED },
            automationPurpose: { not: 'unsupported-message-kind' },
            createdAt: { lt: anchor.createdAt },
            text: { not: null },
          },
          select: { text: true },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        })
      : null;

    return {
      conversation: presentConversationDetail(conversation),
      batch: {
        sourceEventId,
        windowStartedAt: anchor.createdAt.toISOString(),
        windowEndsAt: windowEndsAt.toISOString(),
        pendingQuestion: pendingQuestion?.text?.trim() || null,
        messages: messages.map((message) => ({
          messageId: message.id,
          sourceEventId: message.correlationId,
          kind: kindFromPrisma[message.kind],
          text: message.text,
          occurredAt: message.occurredAt.toISOString(),
          persistedAt: message.createdAt.toISOString(),
        })),
      },
    };
  }

  async listMessages(
    companyId: string,
    conversationId: string,
    query: MessageListQuery,
  ): Promise<unknown> {
    const conversation = await this.prisma.whatsAppConversation.findUnique({
      where: { id_companyId: { id: conversationId, companyId } },
      select: { id: true },
    });
    if (!conversation) throw notFound('Conversa');
    const where = {
      companyId,
      conversationId,
      OR: [
        { automationPurpose: null },
        { automationPurpose: { not: 'department-notification' } },
      ],
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.whatsAppMessage.findMany({
        where,
        include: {
          actorUser: { select: { id: true, name: true } },
          attempts: { orderBy: { attemptNumber: 'asc' } },
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.whatsAppMessage.count({ where }),
    ]);
    return {
      data: rows.map((row) => this.presentMessage(row, false)),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async listTransitions(
    companyId: string,
    conversationId: string,
    query: TransitionListQuery,
  ): Promise<unknown> {
    const conversation = await this.prisma.whatsAppConversation.findUnique({
      where: { id_companyId: { id: conversationId, companyId } },
      select: { id: true },
    });
    if (!conversation) throw notFound('Conversa');
    const where = { companyId, conversationId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.whatsAppConversationTransition.findMany({
        where,
        include: {
          actorUser: { select: { id: true, name: true } },
        },
        orderBy: [{ resultingVersion: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.whatsAppConversationTransition.count({ where }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        commandId: row.commandId,
        name: row.name,
        expectedVersion: row.expectedVersion,
        resultingVersion: row.resultingVersion,
        actorType: row.actorType.toLowerCase(),
        actorUserId: row.actorUserId,
        actor: {
          type: row.actorType.toLowerCase(),
          user: row.actorUser
            ? { id: row.actorUser.id, name: row.actorUser.name }
            : null,
        },
        from: {
          department: departmentFromPrisma[row.fromDepartment],
          conversationState: stateFromPrisma[row.fromState],
          flowStep: flowFromPrisma[row.fromFlowStep],
          requestStatus: requestFromPrisma[row.fromRequestStatus],
        },
        to: {
          department: departmentFromPrisma[row.toDepartment],
          conversationState: stateFromPrisma[row.toState],
          flowStep: flowFromPrisma[row.toFlowStep],
          requestStatus: requestFromPrisma[row.toRequestStatus],
        },
        metadata: row.metadata,
        createdAt: row.createdAt.toISOString(),
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async getCurrentQuoteRequest(
    companyId: string,
    conversationId: string,
  ): Promise<unknown> {
    const conversation = await this.prisma.whatsAppConversation.findUnique({
      where: { id_companyId: { id: conversationId, companyId } },
      select: { id: true },
    });
    if (!conversation) throw notFound('Conversa');
    const quote = await this.prisma.quoteRequest.findFirst({
      where: { companyId, conversationId },
      orderBy: { sequence: 'desc' },
    });
    if (!quote) throw notFound('Solicitação de orçamento');
    return presentQuote(quote);
  }

  private async completeQuoteProposalBatchIfReady(
    transaction: Prisma.TransactionClient,
    input: {
      companyId: string;
      conversationId: string;
      quoteRequestId: string;
      triggeringDocumentId: string;
      deliveryBatchId: string | null;
    },
  ): Promise<void> {
    if (!input.deliveryBatchId) {
      throw new AppError(
        'CONFLICT',
        'O documento da proposta não possui lote de entrega.',
      );
    }
    const pendingTotal = await transaction.quoteProposalDocument.count({
      where: {
        companyId: input.companyId,
        quoteRequestId: input.quoteRequestId,
        deliveryBatchId: input.deliveryBatchId,
        status: {
          in: [
            QuoteProposalDocumentStatus.UPLOADED,
            QuoteProposalDocumentStatus.QUEUED,
          ],
        },
      },
    });
    if (pendingTotal > 0) return;
    const failedTotal = await transaction.quoteProposalDocument.count({
      where: {
        companyId: input.companyId,
        quoteRequestId: input.quoteRequestId,
        deliveryBatchId: input.deliveryBatchId,
        status: QuoteProposalDocumentStatus.FAILED,
      },
    });
    if (failedTotal > 0) return;

    const [conversation, quote] = await Promise.all([
      transaction.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: input.conversationId,
            companyId: input.companyId,
          },
        },
      }),
      transaction.quoteRequest.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: input.quoteRequestId,
            companyId: input.companyId,
          },
        },
      }),
    ]);
    if (
      quote.conversationId !== conversation.id ||
      quote.status !== RequestStatus.UNDER_REVIEW
    ) {
      return;
    }

    const sentDocuments = await transaction.quoteProposalDocument.findMany({
      where: {
        companyId: input.companyId,
        quoteRequestId: quote.id,
        deliveryBatchId: input.deliveryBatchId,
        status: QuoteProposalDocumentStatus.SENT,
      },
      orderBy: [{ sentAt: 'desc' }, { sequence: 'desc' }],
      select: {
        id: true,
        messageId: true,
        providerMessageId: true,
        sentAt: true,
      },
    });
    if (sentDocuments.length === 0) return;

    const next = resolveConversationTransition({
      current: snapshot(conversation),
      name: 'proposal-delivery-confirmed',
    });
    const quoteUpdated = await transaction.quoteRequest.updateMany({
      where: {
        id: quote.id,
        companyId: input.companyId,
        conversationId: conversation.id,
        version: quote.version,
        status: RequestStatus.UNDER_REVIEW,
      },
      data: {
        status: RequestStatus.WAITING_FOR_CUSTOMER,
        version: { increment: 1 },
      },
    });
    if (quoteUpdated.count !== 1) {
      throw new AppError(
        'CONFLICT',
        'A solicitação vinculada à proposta foi alterada durante a confirmação.',
        { currentVersion: quote.version },
      );
    }

    const completedAt = sentDocuments[0].sentAt ?? new Date();
    const nextVersion = conversation.version + 1;
    const transitioned = await transaction.whatsAppConversation.updateMany({
      where: {
        id: conversation.id,
        companyId: input.companyId,
        version: conversation.version,
        department: DepartmentCode.COMMERCIAL,
        conversationState: {
          in: [
            ConversationState.BOT_ACTIVE,
            ConversationState.SENT_TO_HUMAN,
            ConversationState.HUMAN_ACTIVE,
          ],
        },
        flowStep: FlowStep.QUOTE_SEND_PENDING,
        requestStatus: RequestStatus.UNDER_REVIEW,
      },
      data: {
        conversationState: stateToPrisma[next.conversationState],
        flowStep: flowToPrisma[next.flowStep],
        requestStatus: requestToPrisma[next.requestStatus],
        resumeState: null,
        resumeFlowStep: null,
        assignedToUserId: null,
        contextualFollowUpAt: null,
        lastOutboundAt: completedAt,
        lastMessagePreview:
          sentDocuments.length === 1
            ? 'Orçamento em PDF enviado.'
            : `${sentDocuments.length} PDFs de orçamento enviados.`,
        version: { increment: 1 },
      },
    });
    if (transitioned.count !== 1) {
      throw currentVersionConflict(conversation.version);
    }

    const resultSnapshot = {
      id: conversation.id,
      ...next,
      version: nextVersion,
    };
    await transaction.whatsAppConversationTransition.create({
      data: {
        companyId: input.companyId,
        conversationId: conversation.id,
        commandId: correlation(
          'quote-proposal-batch-delivered',
          input.triggeringDocumentId,
        ),
        commandFingerprint: commandFingerprint({
          quoteRequestId: quote.id,
          proposalDocumentIds: sentDocuments.map((document) => document.id),
          triggeringDocumentId: input.triggeringDocumentId,
        }),
        name: 'proposal-delivery-confirmed',
        expectedVersion: conversation.version,
        resultingVersion: nextVersion,
        actorType: TransitionActorType.SYSTEM,
        fromDepartment: conversation.department,
        toDepartment: departmentToPrisma[next.department],
        fromState: conversation.conversationState,
        toState: stateToPrisma[next.conversationState],
        fromFlowStep: conversation.flowStep,
        toFlowStep: flowToPrisma[next.flowStep],
        fromRequestStatus: conversation.requestStatus,
        toRequestStatus: requestToPrisma[next.requestStatus],
        metadata: payload({
          quoteRequestId: quote.id,
          proposalDocumentIds: sentDocuments.map((document) => document.id),
          messageIds: sentDocuments.map((document) => document.messageId),
          providerMessageIds: sentDocuments.map(
            (document) => document.providerMessageId,
          ),
        }),
        resultSnapshot: payload(resultSnapshot),
      },
    });
  }

  private async lockCommand(
    transaction: Prisma.TransactionClient,
    companyId: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtext(${`${companyId}:${namespace}:${key}`})
      )
    `;
  }

  private async createOrderedOutbox(
    transaction: Prisma.TransactionClient,
    input: {
      companyId: string;
      topic: string;
      aggregateType: string;
      aggregateId: string;
      correlationId: string;
      payload: unknown;
    },
  ): Promise<void> {
    await this.lockCommand(
      transaction,
      input.companyId,
      'integration-outbox',
      `${input.aggregateType}:${input.aggregateId}`,
    );
    const latest = await transaction.integrationOutbox.aggregate({
      where: {
        companyId: input.companyId,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
      },
      _max: { aggregateSequence: true },
    });
    await transaction.integrationOutbox.create({
      data: {
        ...input,
        aggregateSequence: (latest._max.aggregateSequence ?? 0) + 1,
        payload: payload(input.payload),
      },
    });
  }

  private async replayTransition(
    input: TransitionCommand,
    fingerprint: string,
  ): Promise<unknown> {
    const transition =
      await this.prisma.whatsAppConversationTransition.findUnique({
        where: {
          companyId_commandId: {
            companyId: input.companyId,
            commandId: input.commandId,
          },
        },
      });
    if (!transition) {
      throw new AppError(
        'CONFLICT',
        'Não foi possível reconciliar a concorrência da transição.',
      );
    }
    assertSameFingerprint(
      transition.commandFingerprint,
      fingerprint,
      'commandId',
    );
    return {
      ...(transition.resultSnapshot as Record<string, unknown>),
      idempotent: true,
    };
  }

  private async replayInbox(
    companyId: string,
    source: string,
    externalEventId: string,
    fingerprint: string,
    keyName: string,
  ): Promise<unknown> {
    const inbox = await this.prisma.integrationInbox.findUnique({
      where: {
        companyId_source_externalEventId: {
          companyId,
          source,
          externalEventId,
        },
      },
    });
    if (!inbox) {
      throw new AppError(
        'CONFLICT',
        'Não foi possível reconciliar a concorrência do comando.',
      );
    }
    assertSameFingerprint(inbox.payloadHash, fingerprint, keyName);
    if (!inbox.resultSnapshot) {
      throw new AppError('CONFLICT', 'O comando concorrente está incompleto.');
    }
    return {
      ...(inbox.resultSnapshot as Record<string, unknown>),
      idempotent: true,
    };
  }

  private async presentCurrentOutboundReplay(
    client: Prisma.TransactionClient | PrismaService,
    companyId: string,
    snapshot: Record<string, unknown>,
  ): Promise<unknown> {
    const messageId = snapshot.id;
    if (typeof messageId !== 'string') {
      throw new AppError(
        'CONFLICT',
        'O snapshot do comando outbound não contém a mensagem.',
      );
    }
    const message = await client.whatsAppMessage.findUnique({
      where: { id_companyId: { id: messageId, companyId } },
      include: {
        actorUser: { select: { id: true, name: true } },
        attempts: { orderBy: { attemptNumber: 'asc' } },
      },
    });
    if (!message) throw notFound('Mensagem outbound');
    return this.presentMessage(message, true);
  }

  private async findConversationOrThrow(
    client: Prisma.TransactionClient | PrismaService,
    companyId: string,
    conversationId: string,
  ): Promise<ConversationWithRelations> {
    const conversation = await client.whatsAppConversation.findUnique({
      where: { id_companyId: { id: conversationId, companyId } },
      include: conversationInclude,
    });
    if (!conversation) throw notFound('Conversa');
    return conversation;
  }

  private presentMessage(
    row: {
      id: string;
      conversationId: string;
      actorUserId: string | null;
      providerMessageId: string | null;
      direction: MessageDirection;
      deliveryStatus: DeliveryStatus;
      kind: MessageKind;
      text: string | null;
      media: unknown;
      automationPurpose: string | null;
      recipientPhone: string | null;
      correlationId: string;
      occurredAt: Date;
      createdAt: Date;
      updatedAt: Date;
      actorUser?: { id: string; name: string } | null;
      attempts: Array<{
        id: string;
        attemptNumber: number;
        status: MessageAttemptStatus;
        providerMessageId: string | null;
        errorCode: string | null;
        errorMessage: string | null;
        dispatchClaimId: string | null;
        dispatchFingerprint: string | null;
        dispatchClaimedAt: Date | null;
        dispatchState: EvolutionDispatchState;
        dispatchOwnerId: string | null;
        dispatchLeaseUntil: Date | null;
        startedAt: Date;
        completedAt: Date | null;
      }>;
    },
    idempotent: boolean,
  ) {
    return {
      id: row.id,
      conversationId: row.conversationId,
      providerMessageId: row.providerMessageId,
      direction:
        row.direction === MessageDirection.INBOUND ? 'inbound' : 'outbound',
      deliveryStatus: deliveryFromPrisma[row.deliveryStatus],
      kind: kindFromPrisma[row.kind],
      text: row.text,
      media: row.media,
      automationPurpose: row.automationPurpose,
      recipientPhone: row.recipientPhone,
      sentBy: row.actorUser
        ? { id: row.actorUser.id, name: row.actorUser.name }
        : null,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt.toISOString(),
      attempts: row.attempts.map((attempt) => ({
        id: attempt.id,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status.toLowerCase(),
        providerMessageId: attempt.providerMessageId,
        errorCode: attempt.errorCode,
        errorMessage: attempt.errorMessage,
        dispatchState: attempt.dispatchState.toLowerCase(),
        dispatchClaimedAt: attempt.dispatchClaimedAt?.toISOString() ?? null,
        dispatchLeaseUntil: attempt.dispatchLeaseUntil?.toISOString() ?? null,
        startedAt: attempt.startedAt.toISOString(),
        completedAt: attempt.completedAt?.toISOString() ?? null,
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      idempotent,
    };
  }
}

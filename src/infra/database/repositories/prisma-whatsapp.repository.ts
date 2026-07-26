import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  WhatsAppRepository,
  type ClaimEvolutionDispatchInput,
  type CompleteOutboxExecutionInput,
  type ConversationListQuery,
  type CreateHumanOutboundInput,
  type CreateOutboundInput,
  type EvolutionResultInput,
  type MessageListQuery,
  type PersistInboundInput,
  type QuoteRequestPatch,
  type TransitionCommand,
  type TransitionListQuery,
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
  assertTransitionActor,
  resolveConversationTransition,
} from '../../../domain/whatsapp/conversation-transition.matrix';
import type {
  ConversationSnapshot,
  ConversationState as CanonicalConversationState,
  DeliveryStatus as CanonicalDeliveryStatus,
  FlowStep as CanonicalFlowStep,
  MessageKind as CanonicalMessageKind,
  RequestStatus as CanonicalRequestStatus,
} from '../../../domain/whatsapp/whatsapp.constants';
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
  RequestStatus,
  TransitionActorType,
  type Prisma,
} from '../prisma/generated/client';
import { PrismaService } from '../prisma/prisma.service';

const departmentToPrisma: Readonly<Record<Department, DepartmentCode>> = {
  'human-resources': DepartmentCode.HUMAN_RESOURCES,
  'personnel-department': DepartmentCode.PERSONNEL_DEPARTMENT,
  commercial: DepartmentCode.COMMERCIAL,
  purchasing: DepartmentCode.PURCHASING,
  maintenance: DepartmentCode.MAINTENANCE,
  monitoring: DepartmentCode.MONITORING,
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
  MAINTENANCE: 'maintenance',
  MONITORING: 'monitoring',
  OPERATIONS: 'operations',
  CLEANING: 'cleaning',
  FINANCIAL: 'financial',
  INFORMATION_TECHNOLOGY: 'information-technology',
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
  n8n: TransitionActorType.N8N,
  webhook: TransitionActorType.WEBHOOK,
  system: TransitionActorType.SYSTEM,
} as const;

const conversationInclude = {
  contact: true,
  channel: { select: { id: true, name: true, phoneNumber: true } },
  assignedTo: { select: { id: true, name: true } },
  quoteRequests: { orderBy: { sequence: 'desc' as const }, take: 1 },
} as const;

type ConversationWithRelations = Prisma.WhatsAppConversationGetPayload<{
  include: typeof conversationInclude;
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
  departureAt: Date | null;
  passengerCount: number | null;
}): void {
  const missing = [
    !quote.contactName?.trim() && 'contactName',
    !quote.serviceType?.trim() && 'serviceType',
    !quote.origin?.trim() && 'origin',
    !quote.destination?.trim() && 'destination',
    !quote.departureAt && 'departureAt',
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
  departureAt: Date | null;
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
  version: number;
  createdAt: Date;
  updatedAt: Date;
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
    departureAt: row.departureAt?.toISOString() ?? null,
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
    version: row.version,
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
    contextualFollowUpAt: row.contextualFollowUpAt?.toISOString() ?? null,
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: row.lastOutboundAt?.toISOString() ?? null,
    lastMessagePreview: row.lastMessagePreview,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    currentQuoteRequest: row.quoteRequests[0]
      ? presentQuote(row.quoteRequests[0])
      : null,
  };
}

function currentVersionConflict(currentVersion: number): AppError {
  return new AppError(
    'CONFLICT',
    'A conversa foi alterada por outro comando.',
    { currentVersion },
  );
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
  private readonly n8nRetryBaseDelayMs: number;
  private readonly n8nRetryMaximumDelayMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    super();
    this.dispatchLeaseMs =
      config.get<number>('EVOLUTION_DISPATCH_LEASE_MS') ?? 90_000;
    this.followUpInactivityMs =
      config.get<number>('WHATSAPP_FOLLOW_UP_INACTIVITY_MS') ?? 1_800_000;
    this.n8nRetryBaseDelayMs =
      config.get<number>('N8N_RETRY_BASE_DELAY_MS') ?? 1_000;
    this.n8nRetryMaximumDelayMs =
      config.get<number>('N8N_RETRY_MAX_DELAY_MS') ?? 300_000;
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

  async persistInbound(input: PersistInboundInput): Promise<unknown> {
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
            closedAt: null,
          },
          orderBy: { updatedAt: 'desc' },
        });

        const isFirstContact = !conversation;
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
        }

        let contextualTransition = false;
        let automaticResumeName:
          'resume-awaited-reply' | 'resume-contextual-contact' | null = null;

        if (
          conversation.conversationState ===
            ConversationState.WAITING_FOR_CUSTOMER &&
          conversation.flowStep === FlowStep.QUOTE_SUMMARY_CONFIRMATION &&
          conversation.requestStatus === RequestStatus.WAITING_FOR_CUSTOMER &&
          conversation.resumeState === ConversationState.BOT_ACTIVE
        ) {
          automaticResumeName = 'resume-awaited-reply';
        } else if (
          conversation.conversationState === ConversationState.SENT_TO_HUMAN &&
          conversation.flowStep === FlowStep.QUOTE_SEND_PENDING &&
          conversation.contextualFollowUpAt !== null &&
          input.occurredAt >= conversation.contextualFollowUpAt &&
          (conversation.requestStatus === RequestStatus.UNDER_REVIEW ||
            conversation.requestStatus === RequestStatus.APPROVED)
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
              contextualFollowUpAt:
                automaticResumeName === 'resume-contextual-contact'
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
            },
            automationAllowed,
            canGenerateReply,
            canSendReply,
            contextualTransition,
            isFirstContact,
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

        const conversation = await this.findConversationOrThrow(
          transaction,
          input.companyId,
          input.conversationId,
        );
        if (conversation.version !== input.expectedVersion) {
          throw currentVersionConflict(conversation.version);
        }

        if (input.actorType === 'user' && !input.actorUserId) {
          throw validationError(
            'Uma transição humana exige um usuário autenticado.',
          );
        }
        if (input.actorUserId) {
          const actor = await transaction.user.findUnique({
            where: {
              id_companyId: {
                id: input.actorUserId,
                companyId: input.companyId,
              },
            },
            select: { id: true, isActive: true },
          });
          if (!actor?.isActive) {
            throw forbidden('O ator informado não pertence ao tenant.');
          }
        }

        const from = snapshot(conversation);
        const to = resolveConversationTransition({
          current: from,
          name: input.name,
          targetDepartment: input.targetDepartment,
        });
        const nextVersion = conversation.version + 1;

        let quote = conversation.quoteRequests[0];
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
                      departureAt: quote.departureAt?.toISOString() ?? null,
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
            contextualFollowUpAt:
              input.name === 'confirm-quote'
                ? new Date(Date.now() + this.followUpInactivityMs)
                : input.name === 'resume-contextual-contact'
                  ? null
                  : conversation.contextualFollowUpAt,
            assignedToUserId:
              input.name === 'take-over'
                ? input.actorUserId
                : ['return-to-bot', 'forward'].includes(input.name)
                  ? null
                  : conversation.assignedToUserId,
            unreadCount:
              input.name === 'mark-read' ? 0 : conversation.unreadCount,
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
        const persistedResult = presentConversation(updated);
        await transaction.whatsAppConversationTransition.create({
          data: {
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
            metadata: payload({
              ...(input.metadata ?? {}),
              quoteRequestId: quote?.id ?? null,
            }),
            resultSnapshot: payload(persistedResult),
          },
        });
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
          'n8n.quote-patch',
          input.commandId,
        );
        const duplicate = await transaction.integrationInbox.findUnique({
          where: {
            companyId_source_externalEventId: {
              companyId,
              source: 'n8n.quote-patch',
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
            source: 'n8n.quote-patch',
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
            ...(input.departureAt === undefined
              ? {}
              : { departureAt: input.departureAt }),
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
              source: 'n8n.quote-patch',
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
          'n8n.quote-patch',
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
          'n8n.outbound-command',
          input.commandId,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'n8n.outbound-command',
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
        if (conversation.conversationState !== ConversationState.BOT_ACTIVE) {
          throw forbidden(
            'Envio automático permitido somente em conversationState=bot-active.',
          );
        }
        if (!input.text?.trim() && !input.media) {
          throw validationError('A mensagem outbound exige texto ou mídia.');
        }

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: conversation.channelId,
            source: 'n8n.outbound-command',
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
          'n8n.outbound-command',
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
            direction: MessageDirection.OUTBOUND,
            deliveryStatus: DeliveryStatus.PENDING,
            kind: MessageKind.TEXT,
            text: normalizedText,
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
            { ...message, attempts: [attempt] },
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
            source: 'n8n.evolution-claim',
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
              source: 'n8n.evolution-claim',
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
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            shouldSend: false,
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
          'n8n.evolution-claim',
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
            source: 'n8n.evolution-result',
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
          include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
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

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            channelId: message.channelId,
            source: 'n8n.evolution-result',
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
          include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
        });
        if (finalStatus !== DeliveryStatus.FAILED) {
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
          'n8n.evolution-result',
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async completeOutboxExecution(
    input: CompleteOutboxExecutionInput,
  ): Promise<unknown> {
    const fingerprint = commandFingerprint(input);
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await this.lockCommand(
          transaction,
          input.companyId,
          'n8n.outbox-completion-command',
          input.commandId,
        );
        const inboxKey = {
          companyId_source_externalEventId: {
            companyId: input.companyId,
            source: 'n8n.outbox-completion',
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
            throw new AppError('CONFLICT', 'Completion n8n incompleto.');
          }
          return {
            ...(duplicate.resultSnapshot as Record<string, unknown>),
            idempotent: true,
          };
        }

        await this.lockCommand(
          transaction,
          input.companyId,
          'n8n.outbox-event',
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

        await transaction.integrationInbox.create({
          data: {
            companyId: input.companyId,
            source: 'n8n.outbox-completion',
            externalEventId: input.commandId,
            payloadHash: fingerprint,
            correlationId: correlation(
              'n8n-outbox-completion',
              input.commandId,
            ),
          },
        });

        const completedBeforeAck = event.lockId !== null;
        const attempts = Math.min(
          event.maxAttempts,
          event.attempts + (completedBeforeAck ? 1 : 0),
        );
        const now = new Date();
        const retryDelay = Math.min(
          this.n8nRetryBaseDelayMs * 2 ** Math.max(0, attempts - 1),
          this.n8nRetryMaximumDelayMs,
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
              : input.outcome === 'retryable-failure'
                ? {
                    status: IntegrationOutboxStatus.PENDING,
                    attempts,
                    availableAt: new Date(now.valueOf() + retryDelay),
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
                    executionLeaseUntil: null,
                    lockedAt: null,
                    lockId: null,
                    lastError: failure,
                  },
        });
        const persistedResult = {
          eventId: updated.id,
          executionId: input.executionId,
          aggregateType: updated.aggregateType,
          aggregateId: updated.aggregateId,
          aggregateSequence: updated.aggregateSequence,
          outcome: input.outcome,
          status: updated.status.toLowerCase(),
          attempts: updated.attempts,
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
          'n8n.outbox-completion',
          input.commandId,
          fingerprint,
          'commandId',
        );
      }
      throw error;
    }
  }

  async listConversations(
    companyId: string,
    query: ConversationListQuery,
  ): Promise<unknown> {
    const canonicalState = query.state as
      CanonicalConversationState | undefined;
    const state = canonicalState ? stateToPrisma[canonicalState] : undefined;
    const search = query.search?.trim();
    const where: Prisma.WhatsAppConversationWhereInput = {
      companyId,
      ...(state ? { conversationState: state } : {}),
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
    return presentConversation(
      await this.findConversationOrThrow(
        this.prisma,
        companyId,
        conversationId,
      ),
    );
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
    const where = { companyId, conversationId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.whatsAppMessage.findMany({
        where,
        include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
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
      include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
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
      providerMessageId: string | null;
      direction: MessageDirection;
      deliveryStatus: DeliveryStatus;
      kind: MessageKind;
      text: string | null;
      media: unknown;
      correlationId: string;
      occurredAt: Date;
      createdAt: Date;
      updatedAt: Date;
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

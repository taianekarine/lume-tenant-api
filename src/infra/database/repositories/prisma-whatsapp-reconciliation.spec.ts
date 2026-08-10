import { ConfigService } from '@nestjs/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReconcileAutomationOutboxInput } from '../../../application/contracts/whatsapp.repository';
import {
  DeliveryStatus,
  EvolutionDispatchState,
  IntegrationOutboxStatus,
  MessageAttemptStatus,
  MessageDirection,
  MessageKind,
  WhatsAppAutomationProvider,
} from '../prisma/generated/client';
import type { PrismaService } from '../prisma/prisma.service';
import { PrismaWhatsAppRepository } from './prisma-whatsapp.repository';

const LEGACY_AUTOMATION_RECONCILIATION_REQUIRED =
  'LEGACY_AUTOMATION_RECONCILIATION_REQUIRED';

const ids = {
  company: '00000000-0000-4000-8000-000000000001',
  event: '00000000-0000-4000-8000-000000000002',
  command: '00000000-0000-4000-8000-000000000003',
  message: '00000000-0000-4000-8000-000000000004',
  attempt: '00000000-0000-4000-8000-000000000005',
  nextAttempt: '00000000-0000-4000-8000-000000000006',
  channel: '00000000-0000-4000-8000-000000000007',
  conversation: '00000000-0000-4000-8000-000000000008',
  service: '00000000-0000-4000-8000-000000000009',
};

function reconciliation(
  overrides: Partial<ReconcileAutomationOutboxInput> = {},
): ReconcileAutomationOutboxInput {
  return {
    companyId: ids.company,
    eventId: ids.event,
    commandId: ids.command,
    resolution: 'confirmed-not-sent',
    evidence: 'Consulta operacional confirmou ausência do envio.',
    serviceIdentityId: ids.service,
    serviceIdentityName: 'Operação interna',
    ...overrides,
  };
}

function createHarness() {
  let inbox: Record<string, unknown> | null = null;
  const event = {
    id: ids.event,
    companyId: ids.company,
    topic: 'whatsapp.outbound.requested',
    aggregateType: 'whatsapp-conversation',
    aggregateId: ids.conversation,
    aggregateSequence: 1,
    correlationId: 'outbound:test',
    payload: { messageId: ids.message, attemptId: ids.attempt },
    status: IntegrationOutboxStatus.DEAD,
    attempts: 1,
    maxAttempts: 8,
    availableAt: new Date(0),
    lockedAt: null,
    lockId: null,
    executionId: null,
    acceptedAt: null,
    executionLeaseUntil: null,
    processingProvider: null as WhatsAppAutomationProvider | null,
    deliveredAt: null,
    lastError: 'Requer reconciliação',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const message = {
    id: ids.message,
    companyId: ids.company,
    conversationId: ids.conversation,
    channelId: ids.channel,
    contactId: '00000000-0000-4000-8000-000000000010',
    actorUserId: null,
    providerMessageId: null as string | null,
    direction: MessageDirection.OUTBOUND,
    deliveryStatus: DeliveryStatus.PENDING,
    kind: MessageKind.TEXT,
    text: 'Mensagem de teste',
    media: null,
    automationPurpose: 'department-notification',
    recipientPhone: '5534999999999',
    correlationId: 'message:test',
    occurredAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const attempt = {
    id: ids.attempt,
    companyId: ids.company,
    messageId: ids.message,
    attemptNumber: 1,
    status: MessageAttemptStatus.PENDING,
    providerMessageId: null as string | null,
    errorCode: null as string | null,
    errorMessage: null as string | null,
    dispatchClaimId: 'claim-1',
    dispatchFingerprint: 'a'.repeat(64),
    dispatchClaimedAt: new Date(0),
    dispatchState: EvolutionDispatchState.UNKNOWN,
    dispatchOwnerId: ids.service,
    dispatchLeaseUntil: null,
    startedAt: new Date(0),
    completedAt: null as Date | null,
    createdAt: new Date(0),
  };

  const transaction = {
    $executeRaw: vi.fn(async () => 1),
    $queryRaw: vi.fn(async () => [{ id: ids.event }]),
    integrationInbox: {
      findUnique: vi.fn(async () => inbox),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        inbox = { ...data, resultSnapshot: null };
        return inbox;
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        inbox = { ...inbox, ...data };
        return inbox;
      }),
    },
    integrationOutbox: {
      findUnique: vi.fn(async () => ({ ...event })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(event, data);
        return { ...event };
      }),
    },
    whatsAppMessage: {
      findUnique: vi.fn(async () => ({ ...message })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(message, data);
        return { ...message };
      }),
    },
    whatsAppMessageAttempt: {
      findUnique: vi.fn(async () => ({ ...attempt })),
      aggregate: vi.fn(async () => ({ _max: { attemptNumber: 1 } })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(attempt, data);
        return { ...attempt };
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: ids.nextAttempt,
        ...data,
      })),
    },
    quoteProposalDocument: {
      findUnique: vi.fn(async () => null),
    },
    whatsAppConversation: {
      update: vi.fn(),
    },
  };
  const prisma = {
    $transaction: vi.fn(
      async (operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
    ),
  };
  const repository = new PrismaWhatsAppRepository(
    prisma as unknown as PrismaService,
    new ConfigService({}),
  );
  return {
    attempt,
    event,
    inbox: () => inbox,
    message,
    repository,
    transaction,
  };
}

describe('PrismaWhatsAppRepository.reconcileAutomationOutbox', () => {
  beforeEach(() => vi.clearAllMocks());

  it('abre uma nova tentativa durável sem enviar dentro da transação', async () => {
    const harness = createHarness();

    const result =
      await harness.repository.reconcileAutomationOutbox(reconciliation());

    expect(
      harness.transaction.whatsAppMessageAttempt.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        messageId: ids.message,
        attemptNumber: 2,
        status: MessageAttemptStatus.PENDING,
        dispatchState: EvolutionDispatchState.READY,
      }),
    });
    expect(harness.attempt).toMatchObject({
      status: MessageAttemptStatus.FAILED,
      dispatchState: EvolutionDispatchState.FAILED,
      errorCode: 'CONFIRMED_NOT_SENT',
    });
    expect(harness.event).toMatchObject({
      status: IntegrationOutboxStatus.PENDING,
      attempts: 0,
      processingProvider: null,
      executionId: null,
    });
    const reopenedPayload = harness.event.payload as Record<string, unknown>;
    expect(reopenedPayload).toMatchObject({
      eventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      commandId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      messageId: ids.message,
      attemptId: ids.nextAttempt,
      dispatchGeneration: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(reopenedPayload.eventId).toBe(reopenedPayload.dispatchGeneration);
    expect(reopenedPayload.commandId).toBe(reopenedPayload.dispatchGeneration);
    expect(result).toMatchObject({
      resolution: 'confirmed-not-sent',
      status: 'pending',
      nextAttemptId: ids.nextAttempt,
      idempotent: false,
    });
  });

  it('reabre um envio que falhou localmente antes de contatar o provedor', async () => {
    const harness = createHarness();
    harness.attempt.status = MessageAttemptStatus.FAILED;
    harness.attempt.dispatchState = EvolutionDispatchState.FAILED;
    harness.attempt.errorCode = 'EVOLUTION_CONFIGURATION_INVALID';
    harness.message.deliveryStatus = DeliveryStatus.FAILED;

    const result =
      await harness.repository.reconcileAutomationOutbox(reconciliation());

    expect(harness.message.deliveryStatus).toBe(DeliveryStatus.PENDING);
    expect(
      harness.transaction.whatsAppMessageAttempt.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        messageId: ids.message,
        status: MessageAttemptStatus.PENDING,
        dispatchState: EvolutionDispatchState.READY,
      }),
    });
    expect(result).toMatchObject({
      resolution: 'confirmed-not-sent',
      status: 'pending',
      nextAttemptId: ids.nextAttempt,
    });
  });

  it('confirma o envio sem regredir o estado da mensagem', async () => {
    const harness = createHarness();
    harness.message.deliveryStatus = DeliveryStatus.DELIVERED;

    const result = await harness.repository.reconcileAutomationOutbox(
      reconciliation({
        resolution: 'confirmed-sent',
        providerMessageId: 'evolution-confirmed-1',
      }),
    );

    expect(
      harness.transaction.whatsAppMessageAttempt.create,
    ).not.toHaveBeenCalled();
    expect(harness.attempt).toMatchObject({
      status: MessageAttemptStatus.SUCCEEDED,
      dispatchState: EvolutionDispatchState.SUCCEEDED,
      providerMessageId: 'evolution-confirmed-1',
    });
    expect(harness.message).toMatchObject({
      deliveryStatus: DeliveryStatus.DELIVERED,
      providerMessageId: 'evolution-confirmed-1',
    });
    expect(harness.event.status).toBe(IntegrationOutboxStatus.DELIVERED);
    expect(result).toMatchObject({
      resolution: 'confirmed-sent',
      status: 'delivered',
      idempotent: false,
    });
  });

  it('conclui o outbox quando o resultado confirmado já foi persistido', async () => {
    const harness = createHarness();
    harness.event.processingProvider = WhatsAppAutomationProvider.API;
    harness.attempt.status = MessageAttemptStatus.SUCCEEDED;
    harness.attempt.dispatchState = EvolutionDispatchState.SUCCEEDED;
    harness.attempt.providerMessageId = 'evolution-confirmed-1';
    harness.attempt.completedAt = new Date('2026-08-06T12:00:00.000Z');
    harness.message.deliveryStatus = DeliveryStatus.SENT;
    harness.message.providerMessageId = 'evolution-confirmed-1';

    const result = await harness.repository.reconcileAutomationOutbox(
      reconciliation({
        resolution: 'confirmed-sent',
        providerMessageId: 'evolution-confirmed-1',
      }),
    );

    expect(
      harness.transaction.whatsAppMessageAttempt.create,
    ).not.toHaveBeenCalled();
    expect(
      harness.transaction.whatsAppMessageAttempt.update,
    ).not.toHaveBeenCalled();
    expect(harness.transaction.whatsAppMessage.update).not.toHaveBeenCalled();
    expect(harness.event).toMatchObject({
      status: IntegrationOutboxStatus.DELIVERED,
      processingProvider: WhatsAppAutomationProvider.API,
      lastError: null,
    });
    expect(result).toMatchObject({
      resolution: 'confirmed-sent',
      status: 'delivered',
      providerMessageId: 'evolution-confirmed-1',
      idempotent: false,
    });
  });

  it('recusa concluir resultado já persistido com identificador divergente', async () => {
    const harness = createHarness();
    harness.event.processingProvider = WhatsAppAutomationProvider.API;
    harness.attempt.status = MessageAttemptStatus.SUCCEEDED;
    harness.attempt.dispatchState = EvolutionDispatchState.SUCCEEDED;
    harness.attempt.providerMessageId = 'evolution-persisted-1';
    harness.message.deliveryStatus = DeliveryStatus.SENT;
    harness.message.providerMessageId = 'evolution-persisted-1';

    await expect(
      harness.repository.reconcileAutomationOutbox(
        reconciliation({
          resolution: 'confirmed-sent',
          providerMessageId: 'evolution-different-2',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(harness.event.status).toBe(IntegrationOutboxStatus.DEAD);
    expect(harness.transaction.integrationInbox.create).not.toHaveBeenCalled();
    expect(
      harness.transaction.whatsAppMessageAttempt.create,
    ).not.toHaveBeenCalled();
  });

  it('repete o resultado do mesmo commandId sem criar outra tentativa', async () => {
    const harness = createHarness();
    const input = reconciliation();
    const first = await harness.repository.reconcileAutomationOutbox(input);
    const second = await harness.repository.reconcileAutomationOutbox(input);

    expect(second).toMatchObject({
      ...first,
      idempotent: true,
    });
    expect(
      harness.transaction.whatsAppMessageAttempt.create,
    ).toHaveBeenCalledTimes(1);
    expect(harness.inbox()).toMatchObject({
      source: 'whatsapp.automation-reconciliation',
      resultSnapshot: expect.objectContaining({
        reconciledBy: {
          id: ids.service,
          name: 'Operação interna',
        },
      }),
    });
  });

  it('confirma inbound processado e libera a sequência sem reprocessar', async () => {
    const harness = createHarness();
    harness.event.topic = 'whatsapp.inbound.persisted';
    harness.event.payload = { channelId: ids.channel, messageId: ids.message };
    harness.event.processingProvider = WhatsAppAutomationProvider.API;
    harness.event.lastError = LEGACY_AUTOMATION_RECONCILIATION_REQUIRED;

    const result = await harness.repository.reconcileAutomationOutbox(
      reconciliation({ resolution: 'confirmed-processed' }),
    );

    expect(harness.event).toMatchObject({
      status: IntegrationOutboxStatus.DELIVERED,
      processingProvider: WhatsAppAutomationProvider.API,
      lastError: null,
    });
    expect(
      harness.transaction.whatsAppMessage.findUnique,
    ).not.toHaveBeenCalled();
    expect(
      harness.transaction.whatsAppMessageAttempt.create,
    ).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      eventId: ids.event,
      topic: 'whatsapp.inbound.persisted',
      resolution: 'confirmed-processed',
      status: 'delivered',
      previousProvider: 'api',
      idempotent: false,
    });
  });

  it('reabre um inbound legado não processado para a API', async () => {
    const harness = createHarness();
    harness.event.topic = 'whatsapp.inbound.human-notification';
    harness.event.payload = { channelId: ids.channel, messageId: ids.message };
    harness.event.processingProvider = WhatsAppAutomationProvider.N8N;
    harness.event.lastError = LEGACY_AUTOMATION_RECONCILIATION_REQUIRED;
    harness.event.attempts = 7;

    const result = await harness.repository.reconcileAutomationOutbox(
      reconciliation({ resolution: 'confirmed-not-processed' }),
    );

    expect(harness.event).toMatchObject({
      status: IntegrationOutboxStatus.PENDING,
      attempts: 0,
      processingProvider: null,
      executionId: null,
      acceptedAt: null,
      executionLeaseUntil: null,
      lastError: null,
    });
    expect(result).toMatchObject({
      resolution: 'confirmed-not-processed',
      status: 'pending',
      previousProvider: 'legacy',
      idempotent: false,
    });
  });

  it('repete idempotentemente a reconciliação inbound sem atualizar novamente', async () => {
    const harness = createHarness();
    harness.event.topic = 'whatsapp.inbound.persisted';
    harness.event.payload = { channelId: ids.channel, messageId: ids.message };
    harness.event.processingProvider = WhatsAppAutomationProvider.API;
    harness.event.lastError = LEGACY_AUTOMATION_RECONCILIATION_REQUIRED;
    const input = reconciliation({ resolution: 'confirmed-processed' });

    const first = await harness.repository.reconcileAutomationOutbox(input);
    const second = await harness.repository.reconcileAutomationOutbox(input);

    expect(second).toMatchObject({ ...first, idempotent: true });
    expect(harness.transaction.integrationOutbox.update).toHaveBeenCalledTimes(
      1,
    );
  });

  it('recusa reconciliação inbound que não foi isolada por troca de provedor', async () => {
    const harness = createHarness();
    harness.event.topic = 'whatsapp.inbound.persisted';
    harness.event.processingProvider = WhatsAppAutomationProvider.API;
    harness.event.lastError = 'OUTRA_CAUSA';

    await expect(
      harness.repository.reconcileAutomationOutbox(
        reconciliation({ resolution: 'confirmed-not-processed' }),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(harness.transaction.integrationInbox.create).not.toHaveBeenCalled();
  });

  it('recusa evento que não esteja isolado', async () => {
    const harness = createHarness();
    harness.event.status = IntegrationOutboxStatus.PENDING;

    await expect(
      harness.repository.reconcileAutomationOutbox(reconciliation()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(harness.transaction.integrationInbox.create).not.toHaveBeenCalled();
    expect(
      harness.transaction.whatsAppMessageAttempt.create,
    ).not.toHaveBeenCalled();
  });
});

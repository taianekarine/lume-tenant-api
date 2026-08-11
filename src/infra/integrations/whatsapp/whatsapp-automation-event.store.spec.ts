import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { ClaimedWhatsAppAutomationEvent } from '../../../application/contracts/whatsapp-automation.provider';
import {
  WhatsAppAutomationExecutionStatus,
  WhatsAppAutomationProvider,
} from '../../database/prisma/generated/client';
import type { PrismaService } from '../../database/prisma/prisma.service';
import { WhatsAppAutomationEventStore } from './whatsapp-automation-event.store';

const event: ClaimedWhatsAppAutomationEvent = {
  id: '00000000-0000-4000-8000-000000000001',
  companyId: '00000000-0000-4000-8000-000000000002',
  topic: 'whatsapp.inbound.persisted',
  aggregateType: 'whatsapp-conversation',
  aggregateId: '00000000-0000-4000-8000-000000000003',
  aggregateSequence: 1,
  executionId: '00000000-0000-4000-8000-000000000004',
  correlationId: 'evolution:source-1',
  createdAt: new Date('2026-08-06T12:00:00.000Z'),
  payload: {},
  attempts: 1,
  maxAttempts: 8,
};

function createSubject() {
  const executionUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const executeRaw = vi.fn().mockResolvedValue(0);
  const queryRaw = vi.fn().mockResolvedValue([]);
  const transaction = {
    whatsAppAutomationExecution: {
      updateMany: executionUpdateMany,
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
  };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
  const subject = new WhatsAppAutomationEventStore(
    prisma as unknown as PrismaService,
    new ConfigService({
      WHATSAPP_API_REQUEST_TIMEOUT_MS: 10_000,
      WHATSAPP_API_EXECUTION_TIMEOUT_MS: 120_000,
      WHATSAPP_API_DEBOUNCE_MS: 2_000,
      WHATSAPP_API_DEPARTMENT_COLLECTION_MS: 120_000,
    }),
  );

  return { subject, executeRaw, executionUpdateMany, queryRaw };
}

function createMarkAcceptedSubject(input: {
  completedProvider: WhatsAppAutomationProvider;
  completedStatus: WhatsAppAutomationExecutionStatus;
}) {
  const outboxUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const executionUpdate = vi.fn();
  const completedExecutionFindUnique = vi.fn().mockResolvedValue({
    provider: input.completedProvider,
    status: input.completedStatus,
  });
  const transaction = {
    integrationOutbox: { updateMany: outboxUpdateMany },
    whatsAppAutomationExecution: {
      findUnique: completedExecutionFindUnique,
      update: executionUpdate,
    },
  };
  const prisma = {
    $transaction: vi.fn(
      async (callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
  const subject = new WhatsAppAutomationEventStore(
    prisma as unknown as PrismaService,
    new ConfigService({
      WHATSAPP_API_REQUEST_TIMEOUT_MS: 10_000,
      WHATSAPP_API_EXECUTION_TIMEOUT_MS: 120_000,
      WHATSAPP_API_DEBOUNCE_MS: 2_000,
      WHATSAPP_API_DEPARTMENT_COLLECTION_MS: 120_000,
    }),
  );

  return {
    subject,
    outboxUpdateMany,
    executionUpdate,
    completedExecutionFindUnique,
  };
}

describe('WhatsAppAutomationEventStore', () => {
  it('reivindica exclusivamente eventos da automação própria da API', async () => {
    const { subject, queryRaw, executeRaw, executionUpdateMany } =
      createSubject();

    await subject.claim(20);

    expect(queryRaw).toHaveBeenCalledOnce();
    const claimQueryParts = queryRaw.mock.calls[0][0] as unknown as
      readonly string[] | undefined;
    expect(claimQueryParts?.join('')).toContain(
      '\'api\'::"WhatsAppAutomationProvider"',
    );
    expect(claimQueryParts?.join('')).toContain('newer_inbound."created_at" >');
    expect(claimQueryParts?.join('')).toContain(
      "predecessor.\"status\" IN ('pending', 'processing')",
    );
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(executionUpdateMany).toHaveBeenCalledTimes(2);
  });

  it.each([
    WhatsAppAutomationExecutionStatus.ACCEPTED,
    WhatsAppAutomationExecutionStatus.SUCCEEDED,
    WhatsAppAutomationExecutionStatus.TERMINAL_FAILURE,
  ])(
    'resolve idempotentemente callback-before-ack com execucao API em %s',
    async (completedStatus) => {
      const context = createMarkAcceptedSubject({
        completedProvider: WhatsAppAutomationProvider.API,
        completedStatus,
      });

      await expect(
        context.subject.markAccepted(event),
      ).resolves.toBeUndefined();

      expect(context.outboxUpdateMany).toHaveBeenCalledOnce();
      expect(context.completedExecutionFindUnique).toHaveBeenCalledOnce();
      expect(context.executionUpdate).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      caseName: 'provider divergente',
      completedProvider: WhatsAppAutomationProvider.N8N,
      completedStatus: WhatsAppAutomationExecutionStatus.SUCCEEDED,
    },
    {
      caseName: 'execucao ainda reivindicada',
      completedProvider: WhatsAppAutomationProvider.API,
      completedStatus: WhatsAppAutomationExecutionStatus.CLAIMED,
    },
  ])(
    'rejeita callback-before-ack com $caseName',
    async ({ completedProvider, completedStatus }) => {
      const context = createMarkAcceptedSubject({
        completedProvider,
        completedStatus,
      });

      await expect(context.subject.markAccepted(event)).rejects.toThrow();

      expect(context.outboxUpdateMany).toHaveBeenCalledOnce();
      expect(context.completedExecutionFindUnique).toHaveBeenCalledOnce();
      expect(context.executionUpdate).not.toHaveBeenCalled();
    },
  );
});

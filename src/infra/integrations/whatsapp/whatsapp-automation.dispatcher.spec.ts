import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import {
  type ClaimedWhatsAppAutomationEvent,
  WhatsAppAutomationExecutionError,
} from '../../../application/contracts/whatsapp-automation.provider';
import type { WhatsAppRepository } from '../../../application/contracts/whatsapp.repository';
import type { ApiWhatsAppAutomationProvider } from './api-whatsapp-automation.provider';
import { WhatsAppAutomationDispatcher } from './whatsapp-automation.dispatcher';
import type { WhatsAppAutomationEventStore } from './whatsapp-automation-event.store';

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
  attempts: 0,
  maxAttempts: 8,
};

function createSubject(
  input: {
    apiExecute?: () => Promise<void>;
    markAccepted?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const claim = vi
    .fn()
    .mockResolvedValueOnce([event])
    .mockResolvedValueOnce([]);
  const eventStore = {
    claim,
    markAccepted: vi.fn(async () => {
      calls.push('accepted');
      await input.markAccepted?.();
    }),
    rejectBeforeAcceptance: vi.fn(async () => {
      calls.push('rejected-before-acceptance');
    }),
  };
  const apiProvider = {
    name: 'api' as const,
    acknowledgement: 'before-execution' as const,
    execute: vi.fn(async () => {
      calls.push('execute:api');
      await input.apiExecute?.();
    }),
  };
  const repository = {
    completeOutboxExecution: vi.fn(async () => {
      calls.push('completed-after-acceptance');
    }),
  };
  const config = new ConfigService({
    WHATSAPP_ENABLED: true,
    WHATSAPP_API_DISPATCH_BATCH_SIZE: 20,
  });
  const subject = new WhatsAppAutomationDispatcher(
    eventStore as unknown as WhatsAppAutomationEventStore,
    apiProvider as unknown as ApiWhatsAppAutomationProvider,
    repository as unknown as WhatsAppRepository,
    config,
  );

  return {
    subject,
    calls,
    claim,
    eventStore,
    apiProvider,
    repository,
  };
}

describe('WhatsAppAutomationDispatcher', () => {
  it('reivindica o evento e confirma o aceite antes de executar a API', async () => {
    const subject = createSubject();

    await subject.subject.tick();

    expect(subject.claim).toHaveBeenCalledWith(20);
    expect(subject.apiProvider.execute).toHaveBeenCalledOnce();
    expect(subject.eventStore.markAccepted).toHaveBeenCalledWith(event);
    expect(subject.calls).toEqual(['accepted', 'execute:api']);
  });

  it('reabre com segurança quando o aceite durável falha antes da execução', async () => {
    const subject = createSubject({
      markAccepted: async () => {
        throw new Error('persistência do aceite indisponível');
      },
    });

    await subject.subject.tick();
    await subject.subject.tick();

    expect(subject.eventStore.markAccepted).toHaveBeenCalledOnce();
    expect(subject.apiProvider.execute).not.toHaveBeenCalled();
    expect(subject.eventStore.rejectBeforeAcceptance).toHaveBeenCalledOnce();
    expect(subject.repository.completeOutboxExecution).not.toHaveBeenCalled();
    expect(subject.calls).toEqual(['accepted', 'rejected-before-acceptance']);
  });

  it('conclui uma falha da API depois do aceite sem executar duas vezes', async () => {
    const subject = createSubject({
      apiExecute: async () => {
        throw new WhatsAppAutomationExecutionError(
          'terminal-failure',
          'AUTOMATION_REJECTED',
          'execução rejeitada',
        );
      },
    });

    await subject.subject.tick();
    await subject.subject.tick();

    expect(subject.apiProvider.execute).toHaveBeenCalledOnce();
    expect(subject.eventStore.markAccepted).toHaveBeenCalledOnce();
    expect(subject.eventStore.rejectBeforeAcceptance).not.toHaveBeenCalled();
    expect(subject.repository.completeOutboxExecution).toHaveBeenCalledOnce();
    expect(subject.repository.completeOutboxExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        automationProvider: 'api',
        outcome: 'terminal-failure',
        errorCode: 'AUTOMATION_REJECTED',
      }),
    );
    expect(subject.calls).toEqual([
      'accepted',
      'execute:api',
      'completed-after-acceptance',
    ]);
  });
});

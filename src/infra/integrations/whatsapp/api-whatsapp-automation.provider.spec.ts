import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { WhatsAppRepository } from '../../../application/contracts/whatsapp.repository';
import { WhatsAppAutomationExecutionError } from '../../../application/contracts/whatsapp-automation.provider';
import type { HttpEvolutionOutboundGateway } from '../evolution/evolution-outbound.client';
import type { OpenAiCompatibleWhatsAppConversationAgent } from '../whatsapp-ai/openai-compatible-whatsapp-conversation-agent';
import {
  deterministicCommandId,
  MAIN_MENU,
} from '../../../domain/whatsapp/whatsapp-automation-flow';
import { UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT } from '../../../domain/whatsapp/whatsapp.constants';
import { ApiWhatsAppAutomationProvider } from './api-whatsapp-automation.provider';
import type { WhatsAppAutomationDecisionStore } from './whatsapp-automation-decision.store';
import type { WhatsAppAutomationCheckpointStore } from './whatsapp-automation-checkpoint.store';

const ids = {
  event: '00000000-0000-4000-8000-000000000001',
  company: '00000000-0000-4000-8000-000000000002',
  conversation: '00000000-0000-4000-8000-000000000003',
  execution: '00000000-0000-4000-8000-000000000004',
  message: '00000000-0000-4000-8000-000000000005',
  attempt: '00000000-0000-4000-8000-000000000006',
};

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.conversation,
    department: 'commercial',
    conversationState: 'bot-active',
    flowStep: 'main-menu',
    requestStatus: 'not-started',
    resumeState: null,
    version: 1,
    mainMenuPresentedAt: null,
    followUpMenuPresentedAt: null,
    departmentContactOption: null,
    currentQuoteRequest: null,
    assignedTo: null,
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evolution:source-1',
    messageId: ids.message,
    conversationId: ids.conversation,
    channelId: '00000000-0000-4000-8000-000000000007',
    companyId: ids.company,
    contact: {
      id: '00000000-0000-4000-8000-000000000008',
      phone: '5534999999999',
      displayName: 'Cliente',
    },
    message: {
      providerMessageId: 'provider-1',
      direction: 'inbound',
      deliveryStatus: 'received',
      kind: 'text',
      text: 'olá',
      media: null,
      occurredAt: '2026-08-06T12:00:00.000Z',
    },
    conversation: conversation(),
    automationAllowed: true,
    canGenerateReply: true,
    canSendReply: true,
    contextualTransition: false,
    isFirstContact: true,
    ...overrides,
  };
}

function event(
  topic:
    | 'whatsapp.inbound.persisted'
    | 'whatsapp.inbound.human-notification'
    | 'whatsapp.outbound.requested' = 'whatsapp.inbound.persisted',
  payloadOverride: Record<string, unknown> = {},
) {
  return {
    id: ids.event,
    companyId: ids.company,
    topic,
    aggregateType: 'whatsapp-conversation',
    aggregateId: ids.conversation,
    aggregateSequence: 1,
    executionId: ids.execution,
    correlationId: 'evolution:source-1',
    createdAt: new Date('2026-08-06T12:00:00.000Z'),
    payload: payload(payloadOverride),
    attempts: 0,
    maxAttempts: 8,
  } as const;
}

function createSubject(input?: {
  repository?: Partial<
    Record<keyof WhatsAppRepository, ReturnType<typeof vi.fn>>
  >;
  evolutionResult?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  const repository = {
    getAutomationBatch: vi.fn(async () => {
      calls.push('batch');
      return {
        conversation: conversation(),
        batch: {
          messages: [
            {
              sourceEventId: 'evolution:source-1',
              messageId: ids.message,
              occurredAt: '2026-08-06T12:00:00.000Z',
              persistedAt: '2026-08-06T12:00:00.000Z',
              kind: 'text',
              text: 'olá',
            },
          ],
        },
      };
    }),
    createOutbound: vi.fn(async (command: { text?: string }) => {
      calls.push('create-outbound');
      return {
        id: ids.message,
        kind: 'text',
        text: command.text,
        recipientPhone: '5534999999999',
        attempts: [{ id: ids.attempt }],
      };
    }),
    claimEvolutionDispatch: vi.fn(async () => {
      calls.push('claim');
      return { shouldSend: true, state: 'leased' };
    }),
    recordEvolutionResult: vi.fn(async () => {
      calls.push('result');
      return {};
    }),
    markEvolutionDispatchUnknown: vi.fn(async () => {
      calls.push('reconciliation-required');
      return { state: 'unknown', requiresReconciliation: true };
    }),
    transition: vi.fn(async (command: { name: string }) => {
      calls.push(`transition:${command.name}`);
      return conversation({
        version: 2,
        mainMenuPresentedAt: '2026-08-06T12:00:01.000Z',
      });
    }),
    completeOutboxExecution: vi.fn(async () => {
      calls.push('complete');
      return {};
    }),
    ...input?.repository,
  };
  const agent = {
    complete: vi.fn(async () => {
      throw new Error('IA não deveria ser chamada neste cenário.');
    }),
  };
  const evolution = {
    send: vi.fn(
      async () =>
        input?.evolutionResult ?? {
          outcome: 'confirmed',
          deliveryStatus: 'sent',
          providerMessageId: 'evolution-message-1',
          httpStatus: 201,
          requiresReconciliation: false,
        },
    ),
  };
  const decisionStore = {
    getOrCreate: vi.fn(
      async (
        _event: unknown,
        _agentInput: unknown,
        createDecision: () => Promise<unknown>,
      ) => createDecision(),
    ),
  };
  const checkpointStore = {
    getOrCreate: vi.fn(
      async (_event: unknown, createCheckpoint: () => Promise<unknown>) =>
        createCheckpoint(),
    ),
  };
  const subject = new ApiWhatsAppAutomationProvider(
    repository as unknown as WhatsAppRepository,
    agent as unknown as OpenAiCompatibleWhatsAppConversationAgent,
    checkpointStore as unknown as WhatsAppAutomationCheckpointStore,
    decisionStore as unknown as WhatsAppAutomationDecisionStore,
    evolution as unknown as HttpEvolutionOutboundGateway,
    new ConfigService({
      WHATSAPP_API_DEBOUNCE_MS: 2_000,
      WHATSAPP_API_DEPARTMENT_COLLECTION_MS: 120_000,
    }),
  );
  return {
    subject,
    repository,
    agent,
    checkpointStore,
    decisionStore,
    evolution,
    calls,
  };
}

describe('ApiWhatsAppAutomationProvider', () => {
  it('processa menu, envio e conclusão na ordem durável', async () => {
    const { subject, repository, evolution, calls } = createSubject();

    await subject.execute(event());

    expect(repository.createOutbound).toHaveBeenCalledWith(
      expect.objectContaining({ text: MAIN_MENU, automatic: true }),
    );
    expect(evolution.send).toHaveBeenCalledWith({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: MAIN_MENU,
    });
    expect(repository.completeOutboxExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        automationProvider: 'api',
        outcome: 'succeeded',
        consumedSourceEventIds: ['evolution:source-1'],
      }),
    );
    expect(calls).toEqual([
      'batch',
      'create-outbound',
      'claim',
      'result',
      'transition:present-main-menu',
      'complete',
    ]);
  });

  it('não responde automaticamente quando a conversa está em atendimento humano', async () => {
    const { subject, repository, evolution } = createSubject({
      repository: {
        getAutomationBatch: vi.fn(async () => ({
          conversation: conversation({
            conversationState: 'human-active',
            flowStep: 'human-service',
          }),
          batch: {
            messages: [
              {
                sourceEventId: 'evolution:source-1',
                messageId: ids.message,
                occurredAt: '2026-08-06T12:00:00.000Z',
                kind: 'text',
                text: 'preciso de ajuda',
              },
            ],
          },
        })),
      },
    });

    await subject.execute(
      event('whatsapp.inbound.human-notification', {
        conversation: conversation({
          conversationState: 'human-active',
          flowStep: 'human-service',
        }),
        automationAllowed: false,
        canGenerateReply: false,
        canSendReply: false,
      }),
    );

    expect(evolution.send).not.toHaveBeenCalled();
    expect(repository.createOutbound).not.toHaveBeenCalled();
    expect(repository.completeOutboxExecution).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded' }),
    );
  });

  it.each([
    'text',
    'image',
    'sticker',
    'audio',
    'video',
    'document',
    'unknown',
  ])(
    'mantém silêncio absoluto no atendimento humano para mensagem %s',
    async (kind) => {
      const current = conversation({
        conversationState: 'human-active',
        flowStep: 'human-service',
        assignedTo: { id: 'user-1', name: 'Atendente' },
      });
      const { subject, repository, evolution, agent } = createSubject({
        repository: {
          getAutomationBatch: vi.fn(async () => ({
            conversation: current,
            batch: {
              messages: [
                {
                  sourceEventId: 'evolution:source-1',
                  messageId: ids.message,
                  occurredAt: '2026-08-06T12:00:00.000Z',
                  kind,
                  text: kind === 'text' ? 'mensagem para o atendente' : null,
                },
              ],
            },
          })),
        },
      });

      await subject.execute(
        event('whatsapp.inbound.human-notification', {
          conversation: current,
          message: {
            providerMessageId: `provider-${kind}-1`,
            direction: 'inbound',
            deliveryStatus: 'received',
            kind,
            text: kind === 'text' ? 'mensagem para o atendente' : null,
            media:
              kind === 'text' ? null : { mimeType: 'application/octet-stream' },
            occurredAt: '2026-08-06T12:00:00.000Z',
          },
          automationAllowed: false,
          canGenerateReply: false,
          canSendReply: false,
          isFirstContact: false,
        }),
      );

      expect(agent.complete).not.toHaveBeenCalled();
      expect(repository.transition).not.toHaveBeenCalled();
      expect(repository.createOutbound).not.toHaveBeenCalled();
      expect(evolution.send).not.toHaveBeenCalled();
      expect(repository.completeOutboxExecution).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'succeeded' }),
      );
    },
  );

  it('responde mídia com orientação fixa sem chamar IA nem avançar o fluxo', async () => {
    const current = conversation({
      flowStep: 'commercial-menu',
      mainMenuPresentedAt: '2026-08-06T11:59:00.000Z',
      version: 3,
    });
    const { subject, repository, evolution, agent } = createSubject({
      repository: {
        getAutomationBatch: vi.fn(async () => ({
          conversation: current,
          batch: {
            messages: [
              {
                sourceEventId: 'evolution:source-1',
                messageId: ids.message,
                occurredAt: '2026-08-06T12:00:00.000Z',
                kind: 'image',
                text: null,
              },
            ],
            pendingQuestion: null,
          },
        })),
      },
    });

    await subject.execute(
      event('whatsapp.inbound.persisted', {
        conversation: current,
        message: {
          providerMessageId: 'provider-image-1',
          direction: 'inbound',
          deliveryStatus: 'received',
          kind: 'image',
          text: null,
          media: { mimeType: 'image/jpeg' },
          occurredAt: '2026-08-06T12:00:00.000Z',
        },
        isFirstContact: false,
        reopenedAfterClosure: false,
      }),
    );

    expect(agent.complete).not.toHaveBeenCalled();
    expect(repository.transition).not.toHaveBeenCalled();
    expect(repository.createOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 3,
        purpose: 'unsupported-message-kind',
        inReplyToMessageId: ids.message,
        text: UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT,
      }),
    );
    expect(evolution.send).toHaveBeenCalledWith({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT,
    });
  });

  it('não repete envio quando a Evolution retorna resultado ambíguo', async () => {
    const { subject, repository } = createSubject({
      evolutionResult: {
        outcome: 'ambiguous',
        deliveryStatus: 'pending',
        errorCode: 'EVOLUTION_DISPATCH_TIMEOUT',
        errorMessage: 'Sem confirmação.',
        requiresReconciliation: true,
      },
    });
    const outboundPayload = {
      attemptId: ids.attempt,
      message: {
        providerMessageId: null,
        direction: 'outbound',
        deliveryStatus: 'pending',
        kind: 'text',
        text: 'Resposta humana',
        media: null,
        occurredAt: '2026-08-06T12:00:00.000Z',
      },
      conversation: conversation({ conversationState: 'human-active' }),
      automatic: false,
      automationAllowed: false,
      canGenerateReply: false,
      canSendReply: true,
      isFirstContact: false,
    };

    await expect(
      subject.execute(event('whatsapp.outbound.requested', outboundPayload)),
    ).rejects.toMatchObject({
      outcome: 'terminal-failure',
      errorCode: 'EVOLUTION_RECONCILIATION_REQUIRED',
    } satisfies Partial<WhatsAppAutomationExecutionError>);
    expect(repository.recordEvolutionResult).not.toHaveBeenCalled();
    expect(repository.markEvolutionDispatchUnknown).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: ids.message,
        attemptId: ids.attempt,
        ownerId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        errorCode: 'EVOLUTION_DISPATCH_TIMEOUT',
      }),
    );
    expect(repository.completeOutboxExecution).not.toHaveBeenCalled();
    expect(repository.claimEvolutionDispatch).toHaveBeenCalledTimes(1);
  });

  it('repete apenas a persistência local quando o resultado confirmado falha uma vez', async () => {
    const recordEvolutionResult = vi
      .fn()
      .mockRejectedValueOnce(new Error('Falha transitória de persistência.'))
      .mockResolvedValueOnce({});
    const { subject, repository, evolution } = createSubject({
      repository: { recordEvolutionResult },
    });

    await subject.execute(
      event('whatsapp.outbound.requested', { attemptId: ids.attempt }),
    );

    expect(evolution.send).toHaveBeenCalledOnce();
    expect(recordEvolutionResult).toHaveBeenCalledTimes(2);
    expect(recordEvolutionResult.mock.calls[0]?.[0]).toEqual(
      recordEvolutionResult.mock.calls[1]?.[0],
    );
    expect(repository.markEvolutionDispatchUnknown).not.toHaveBeenCalled();
    expect(repository.completeOutboxExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        automationProvider: 'api',
        outcome: 'succeeded',
      }),
    );
  });

  it('marca o envio confirmado como ambíguo após falha persistente sem reenviar', async () => {
    const recordEvolutionResult = vi
      .fn()
      .mockRejectedValue(new Error('Persistência indisponível.'));
    const { subject, repository, evolution } = createSubject({
      repository: { recordEvolutionResult },
    });

    await expect(
      subject.execute(
        event('whatsapp.outbound.requested', { attemptId: ids.attempt }),
      ),
    ).rejects.toMatchObject({
      outcome: 'terminal-failure',
      errorCode: 'EVOLUTION_RECONCILIATION_REQUIRED',
    } satisfies Partial<WhatsAppAutomationExecutionError>);

    expect(evolution.send).toHaveBeenCalledOnce();
    expect(recordEvolutionResult).toHaveBeenCalledTimes(2);
    expect(recordEvolutionResult.mock.calls[0]?.[0]).toEqual(
      recordEvolutionResult.mock.calls[1]?.[0],
    );
    expect(repository.markEvolutionDispatchUnknown).toHaveBeenCalledOnce();
    expect(repository.markEvolutionDispatchUnknown).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: ids.company,
        messageId: ids.message,
        attemptId: ids.attempt,
        errorCode: 'EVOLUTION_RESULT_PERSISTENCE_FAILED',
      }),
    );
    expect(repository.completeOutboxExecution).not.toHaveBeenCalled();
  });

  it('inclui a geração reconciliada nas chaves de claim e resultado', async () => {
    const { subject, repository } = createSubject();
    const generation = '00000000-0000-4000-8000-000000000009';
    const outboundPayload = {
      attemptId: ids.attempt,
      dispatchGeneration: generation,
      message: {
        providerMessageId: null,
        direction: 'outbound',
        deliveryStatus: 'pending',
        kind: 'text',
        text: 'Resposta humana',
        media: null,
        occurredAt: '2026-08-06T12:00:00.000Z',
      },
      conversation: conversation({ conversationState: 'human-active' }),
      automatic: false,
      automationAllowed: false,
      canGenerateReply: false,
      canSendReply: true,
      isFirstContact: false,
    };

    await subject.execute(
      event('whatsapp.outbound.requested', outboundPayload),
    );

    const claimCommandId = deterministicCommandId(
      'evolution:source-1',
      `evolution-claim:${ids.message}:${generation}`,
    );
    const resultCommandId = deterministicCommandId(
      'evolution:source-1',
      `evolution-result:${ids.message}:${generation}`,
    );
    expect(repository.claimEvolutionDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ids.attempt,
        commandId: claimCommandId,
      }),
    );
    expect(repository.recordEvolutionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ids.attempt,
        commandId: resultCommandId,
      }),
    );
    expect(claimCommandId).not.toBe(
      deterministicCommandId(
        'evolution:source-1',
        `evolution-claim:${ids.message}:initial`,
      ),
    );
  });

  it('rejeita envelope divergente antes de criar checkpoint ou executar efeitos', async () => {
    const { subject, repository, checkpointStore, evolution } = createSubject();

    await expect(
      subject.execute(
        event('whatsapp.inbound.persisted', {
          companyId: '00000000-0000-4000-8000-000000000099',
        }),
      ),
    ).rejects.toMatchObject({
      outcome: 'terminal-failure',
      errorCode: 'AUTOMATION_ENVELOPE_INVALID',
    } satisfies Partial<WhatsAppAutomationExecutionError>);

    expect(checkpointStore.getOrCreate).not.toHaveBeenCalled();
    expect(repository.createOutbound).not.toHaveBeenCalled();
    expect(evolution.send).not.toHaveBeenCalled();
  });

  it('aceita envio automático persistido quando o envelope autoriza a saída', async () => {
    const { subject, repository, evolution } = createSubject();

    await subject.execute(
      event('whatsapp.outbound.requested', {
        attemptId: ids.attempt,
        message: {
          providerMessageId: null,
          direction: 'outbound',
          deliveryStatus: 'pending',
          kind: 'text',
          text: 'Mensagem automática',
          media: null,
          occurredAt: '2026-08-06T12:00:00.000Z',
        },
        automatic: true,
        automationAllowed: false,
        canGenerateReply: false,
        canSendReply: true,
        isFirstContact: false,
      }),
    );

    expect(evolution.send).toHaveBeenCalledOnce();
    expect(repository.completeOutboxExecution).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded' }),
    );
  });
});

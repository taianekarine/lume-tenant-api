import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { WhatsAppConversationAgentInput } from '../../../application/contracts/whatsapp-conversation-agent';
import type { PrismaService } from '../../database/prisma/prisma.service';
import { WhatsAppAutomationDecisionStore } from './whatsapp-automation-decision.store';

const input: WhatsAppConversationAgentInput = {
  sourceEventId: 'evolution:source-1',
  correlationId: 'evolution:source-1',
  companyId: '00000000-0000-4000-8000-000000000001',
  conversationId: '00000000-0000-4000-8000-000000000002',
  aiMode: 'eventual-quote',
  userMessage: 'Preciso de um orçamento.',
  currentConversation: null,
};

const event = {
  id: '00000000-0000-4000-8000-000000000003',
  companyId: input.companyId,
};

const output = {
  message: 'Qual é a origem da viagem?',
  collectionStatus: 'collecting' as const,
  extractedDataPatch: {},
  missingFields: ['origin'],
  summaryPresented: false,
  customerDecision: 'undecided' as const,
};

function persistedDecision() {
  return {
    inputHash: createHash('sha256')
      .update(
        JSON.stringify({
          sourceEventId: input.sourceEventId,
          companyId: input.companyId,
          conversationId: input.conversationId,
          aiMode: input.aiMode,
          userMessage: input.userMessage,
          currentConversation: input.currentConversation,
        }),
      )
      .digest('hex'),
    provider: 'openai',
    model: 'test-model',
    aiAttempt: 1,
    output,
  };
}

describe('WhatsAppAutomationDecisionStore', () => {
  it('reutiliza a decisão persistida sem chamar novamente a IA', async () => {
    const createDecision = vi.fn();
    const prisma = {
      whatsAppAutomationDecision: {
        findUnique: vi.fn().mockResolvedValue(persistedDecision()),
        upsert: vi.fn(),
      },
    };
    const subject = new WhatsAppAutomationDecisionStore(
      prisma as unknown as PrismaService,
    );

    await expect(
      subject.getOrCreate(event, input, createDecision),
    ).resolves.toMatchObject({ provider: 'openai', output });
    expect(createDecision).not.toHaveBeenCalled();
    expect(prisma.whatsAppAutomationDecision.upsert).not.toHaveBeenCalled();
  });

  it('persiste a primeira decisão validada antes de devolvê-la ao fluxo', async () => {
    const result = {
      provider: 'openai' as const,
      model: 'test-model',
      attempt: 1,
      output,
    };
    const prisma = {
      whatsAppAutomationDecision: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(persistedDecision()),
      },
    };
    const subject = new WhatsAppAutomationDecisionStore(
      prisma as unknown as PrismaService,
    );

    await expect(
      subject.getOrCreate(event, input, vi.fn().mockResolvedValue(result)),
    ).resolves.toEqual(result);
    expect(prisma.whatsAppAutomationDecision.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          companyId: event.companyId,
          outboxEventId: event.id,
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          output,
        }),
        update: {},
      }),
    );
  });

  it('encerra com falha terminal quando a decisão pertence a outra entrada', async () => {
    const createDecision = vi.fn();
    const prisma = {
      whatsAppAutomationDecision: {
        findUnique: vi.fn().mockResolvedValue({
          ...persistedDecision(),
          inputHash: '0'.repeat(64),
        }),
        upsert: vi.fn(),
      },
    };
    const subject = new WhatsAppAutomationDecisionStore(
      prisma as unknown as PrismaService,
    );

    await expect(
      subject.getOrCreate(event, input, createDecision),
    ).rejects.toMatchObject({
      outcome: 'terminal-failure',
      errorCode: 'AI_DECISION_INPUT_MISMATCH',
    });
    expect(createDecision).not.toHaveBeenCalled();
    expect(prisma.whatsAppAutomationDecision.upsert).not.toHaveBeenCalled();
  });
});

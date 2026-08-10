import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../database/prisma/prisma.service';
import {
  WhatsAppAutomationCheckpointStore,
  type WhatsAppAutomationCheckpointSnapshot,
} from './whatsapp-automation-checkpoint.store';

const event = {
  id: '00000000-0000-4000-8000-000000000001',
  companyId: '00000000-0000-4000-8000-000000000002',
  payload: { eventId: 'evolution:source-1' },
};

const checkpoint: WhatsAppAutomationCheckpointSnapshot = {
  conversation: {
    id: '00000000-0000-4000-8000-000000000003',
    department: 'commercial',
    conversationState: 'bot-active',
    flowStep: 'main-menu',
    requestStatus: 'not-started',
    resumeState: null,
    version: 1,
    currentQuoteRequest: null,
  },
  messages: [
    {
      sourceEventId: 'evolution:source-1',
      messageId: '00000000-0000-4000-8000-000000000004',
      occurredAt: '2026-08-06T12:00:00.000Z',
      kind: 'text',
      text: '2',
      isFirstContact: false,
    },
  ],
  bufferedText: '2',
  plan: {
    kind: 'static-reply',
    responseMessage: 'Informe seu nome e o motivo do contato.',
    transitionBeforeAi: 'start-department-contact',
    transitionAfterSend: null,
    transitionMetadata: {
      targetDepartment: 'purchasing',
      departmentOption: '2',
    },
    aiMode: null,
    reason: 'department-contact-requested',
  },
};

function persistedRow() {
  return {
    inputHash: createHash('sha256')
      .update(JSON.stringify(event.payload))
      .digest('hex'),
    conversationSnapshot: checkpoint.conversation,
    messagesSnapshot: checkpoint.messages,
    bufferedText: checkpoint.bufferedText,
    planSnapshot: checkpoint.plan,
  };
}

describe('WhatsAppAutomationCheckpointStore', () => {
  it('reutiliza plano e versões originais sem recalcular após efeitos parciais', async () => {
    const createCheckpoint = vi.fn();
    const prisma = {
      whatsAppAutomationCheckpoint: {
        findUnique: vi.fn().mockResolvedValue(persistedRow()),
        upsert: vi.fn(),
      },
    };
    const subject = new WhatsAppAutomationCheckpointStore(
      prisma as unknown as PrismaService,
    );

    await expect(subject.getOrCreate(event, createCheckpoint)).resolves.toEqual(
      checkpoint,
    );
    expect(createCheckpoint).not.toHaveBeenCalled();
  });

  it('persiste o plano antes de iniciar a saga', async () => {
    const prisma = {
      whatsAppAutomationCheckpoint: {
        findUnique: vi.fn().mockResolvedValue(null),
        upsert: vi.fn().mockResolvedValue(persistedRow()),
      },
    };
    const subject = new WhatsAppAutomationCheckpointStore(
      prisma as unknown as PrismaService,
    );

    await expect(
      subject.getOrCreate(event, vi.fn().mockResolvedValue(checkpoint)),
    ).resolves.toEqual(checkpoint);
    expect(prisma.whatsAppAutomationCheckpoint.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          outboxEventId: event.id,
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          planSnapshot: checkpoint.plan,
        }),
        update: {},
      }),
    );
  });

  it('encerra com falha terminal quando o checkpoint pertence a outra entrada', async () => {
    const createCheckpoint = vi.fn();
    const prisma = {
      whatsAppAutomationCheckpoint: {
        findUnique: vi.fn().mockResolvedValue({
          ...persistedRow(),
          inputHash: '0'.repeat(64),
        }),
        upsert: vi.fn(),
      },
    };
    const subject = new WhatsAppAutomationCheckpointStore(
      prisma as unknown as PrismaService,
    );

    await expect(
      subject.getOrCreate(event, createCheckpoint),
    ).rejects.toMatchObject({
      outcome: 'terminal-failure',
      errorCode: 'AUTOMATION_CHECKPOINT_INPUT_MISMATCH',
    });
    expect(createCheckpoint).not.toHaveBeenCalled();
    expect(prisma.whatsAppAutomationCheckpoint.upsert).not.toHaveBeenCalled();
  });
});

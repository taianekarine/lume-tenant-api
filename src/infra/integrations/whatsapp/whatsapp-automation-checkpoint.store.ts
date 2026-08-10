import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  type ClaimedWhatsAppAutomationEvent,
  WhatsAppAutomationExecutionError,
} from '../../../application/contracts/whatsapp-automation.provider';
import type {
  AutomationConversation,
  AutomationPlan,
  BufferedMessage,
} from '../../../domain/whatsapp/whatsapp-automation-flow';
import type { Prisma } from '../../database/prisma/generated/client';
import { PrismaService } from '../../database/prisma/prisma.service';

export interface WhatsAppAutomationCheckpointSnapshot {
  readonly conversation: AutomationConversation;
  readonly messages: readonly BufferedMessage[];
  readonly bufferedText: string;
  readonly plan: AutomationPlan;
}

@Injectable()
export class WhatsAppAutomationCheckpointStore {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(
    event: Pick<ClaimedWhatsAppAutomationEvent, 'id' | 'companyId' | 'payload'>,
    createCheckpoint: () => Promise<WhatsAppAutomationCheckpointSnapshot>,
  ): Promise<WhatsAppAutomationCheckpointSnapshot> {
    const inputHash = checkpointInputHash(event.payload);
    const key = {
      outboxEventId_companyId: {
        outboxEventId: event.id,
        companyId: event.companyId,
      },
    };
    const existing = await this.prisma.whatsAppAutomationCheckpoint.findUnique({
      where: key,
    });
    if (existing) {
      assertCheckpointInputHash(existing.inputHash, inputHash);
      return checkpointFromRow(existing);
    }

    const checkpoint = await createCheckpoint();
    const persisted = await this.prisma.whatsAppAutomationCheckpoint.upsert({
      where: key,
      create: {
        companyId: event.companyId,
        outboxEventId: event.id,
        inputHash,
        conversationSnapshot:
          checkpoint.conversation as unknown as Prisma.InputJsonValue,
        messagesSnapshot:
          checkpoint.messages as unknown as Prisma.InputJsonValue,
        bufferedText: checkpoint.bufferedText,
        planSnapshot: checkpoint.plan as unknown as Prisma.InputJsonValue,
      },
      update: {},
    });
    assertCheckpointInputHash(persisted.inputHash, inputHash);
    return checkpointFromRow(persisted);
  }
}

function checkpointInputHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function assertCheckpointInputHash(actual: string, expected: string): void {
  if (actual === expected) return;
  throw new WhatsAppAutomationExecutionError(
    'terminal-failure',
    'AUTOMATION_CHECKPOINT_INPUT_MISMATCH',
    'O checkpoint armazenado pertence a uma entrada diferente.',
  );
}

function checkpointFromRow(row: {
  conversationSnapshot: Prisma.JsonValue;
  messagesSnapshot: Prisma.JsonValue;
  bufferedText: string;
  planSnapshot: Prisma.JsonValue;
}): WhatsAppAutomationCheckpointSnapshot {
  if (
    !isRecord(row.conversationSnapshot) ||
    typeof row.conversationSnapshot.id !== 'string' ||
    !Number.isInteger(row.conversationSnapshot.version) ||
    !Array.isArray(row.messagesSnapshot) ||
    !isRecord(row.planSnapshot) ||
    typeof row.planSnapshot.kind !== 'string'
  ) {
    throw new WhatsAppAutomationExecutionError(
      'terminal-failure',
      'AUTOMATION_CHECKPOINT_INVALID',
      'O checkpoint da automação não atende ao contrato esperado.',
    );
  }
  return {
    conversation: row.conversationSnapshot as unknown as AutomationConversation,
    messages: row.messagesSnapshot as unknown as BufferedMessage[],
    bufferedText: row.bufferedText,
    plan: row.planSnapshot as unknown as AutomationPlan,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

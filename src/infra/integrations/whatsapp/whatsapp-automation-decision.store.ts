import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type {
  WhatsAppConversationAgentInput,
  WhatsAppConversationAgentResult,
} from '../../../application/contracts/whatsapp-conversation-agent';
import {
  type ClaimedWhatsAppAutomationEvent,
  WhatsAppAutomationExecutionError,
} from '../../../application/contracts/whatsapp-automation.provider';
import { validateAiProviderOutput } from '../../../domain/whatsapp/whatsapp-automation-flow';
import type { Prisma } from '../../database/prisma/generated/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { COMMERCIAL_QUOTE_SYSTEM_PROMPT_VERSION } from '../whatsapp-ai/commercial-quote-system-prompt';

const AI_PROVIDERS = new Set(['openai', 'cerebras', 'gemini', 'groq']);

@Injectable()
export class WhatsAppAutomationDecisionStore {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(
    event: Pick<ClaimedWhatsAppAutomationEvent, 'id' | 'companyId'>,
    input: WhatsAppConversationAgentInput,
    createDecision: () => Promise<WhatsAppConversationAgentResult>,
  ): Promise<WhatsAppConversationAgentResult> {
    const inputHash = decisionInputHash(input);
    const key = {
      outboxEventId_companyId: {
        outboxEventId: event.id,
        companyId: event.companyId,
      },
    };
    const existing = await this.prisma.whatsAppAutomationDecision.findUnique({
      where: key,
    });
    if (existing) {
      assertDecisionInputHash(existing.inputHash, inputHash);
      return this.toResult(existing);
    }

    const decision = await createDecision();
    const persisted = await this.prisma.whatsAppAutomationDecision.upsert({
      where: key,
      create: {
        companyId: event.companyId,
        outboxEventId: event.id,
        inputHash,
        provider: decision.provider,
        model: decision.model,
        promptVersion: COMMERCIAL_QUOTE_SYSTEM_PROMPT_VERSION,
        aiAttempt: decision.attempt,
        output: decision.output as unknown as Prisma.InputJsonValue,
      },
      update: {},
    });
    assertDecisionInputHash(persisted.inputHash, inputHash);
    return this.toResult(persisted);
  }

  private toResult(row: {
    provider: string;
    model: string;
    aiAttempt: number;
    output: Prisma.JsonValue;
  }): WhatsAppConversationAgentResult {
    const validated = validateAiProviderOutput(row.output);
    if (
      !AI_PROVIDERS.has(row.provider) ||
      !validated.valid ||
      !validated.output
    ) {
      throw new WhatsAppAutomationExecutionError(
        'terminal-failure',
        'AI_DECISION_INVALID',
        'A decisão de IA armazenada não atende ao contrato esperado.',
      );
    }
    return {
      provider: row.provider as WhatsAppConversationAgentResult['provider'],
      model: row.model,
      attempt: row.aiAttempt,
      output: validated.output,
    };
  }
}

function decisionInputHash(input: WhatsAppConversationAgentInput): string {
  return createHash('sha256')
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
    .digest('hex');
}

function assertDecisionInputHash(actual: string, expected: string): void {
  if (actual === expected) return;
  throw new WhatsAppAutomationExecutionError(
    'terminal-failure',
    'AI_DECISION_INPUT_MISMATCH',
    'A decisao armazenada pertence a uma entrada diferente.',
  );
}

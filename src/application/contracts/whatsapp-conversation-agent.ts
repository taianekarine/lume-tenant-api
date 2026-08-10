import type {
  AiMode,
  AiProviderOutput,
  AutomationConversation,
} from '../../domain/whatsapp/whatsapp-automation-flow';

export interface WhatsAppConversationAgentInput {
  readonly sourceEventId: string;
  readonly correlationId: string;
  readonly companyId: string;
  readonly conversationId: string;
  readonly aiMode: AiMode;
  readonly userMessage: string;
  readonly currentConversation: AutomationConversation | null;
  readonly instructionText?: string;
  readonly contextText?: string;
  readonly contentText?: string;
}

export interface WhatsAppConversationAgentResult {
  readonly output: AiProviderOutput;
  readonly provider: 'openai' | 'cerebras' | 'gemini' | 'groq';
  readonly model: string;
  readonly attempt: number;
}

export abstract class WhatsAppConversationAgent {
  abstract complete(
    input: WhatsAppConversationAgentInput,
  ): Promise<WhatsAppConversationAgentResult>;
}

export const WHATSAPP_CONVERSATION_AGENT = Symbol(
  'WHATSAPP_CONVERSATION_AGENT',
);

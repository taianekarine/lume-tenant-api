import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  WhatsAppConversationAgent,
  type WhatsAppConversationAgentInput,
  type WhatsAppConversationAgentResult,
} from '../../../application/contracts/whatsapp-conversation-agent';
import {
  validateAiProviderOutput,
  type AiProviderOutput,
} from '../../../domain/whatsapp/whatsapp-automation-flow';
import { sanitizeLogText } from '../../../shared/utils/sensitive-data';
import {
  COMMERCIAL_QUOTE_SYSTEM_PROMPT,
  COMMERCIAL_QUOTE_SYSTEM_PROMPT_VERSION,
} from './commercial-quote-system-prompt';

const AI_PROVIDERS = ['openai', 'cerebras', 'gemini', 'groq'] as const;

export type WhatsAppAiProvider = (typeof AI_PROVIDERS)[number];

const DEFAULT_PROVIDER_ORDER: readonly WhatsAppAiProvider[] = AI_PROVIDERS;

const DEFAULT_BASE_URLS: Readonly<Record<WhatsAppAiProvider, string>> = {
  openai: 'https://api.openai.com/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
};

interface ProviderConfiguration {
  readonly provider: WhatsAppAiProvider;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

@Injectable()
export class OpenAiCompatibleWhatsAppConversationAgent extends WhatsAppConversationAgent {
  private readonly logger = new Logger(
    OpenAiCompatibleWhatsAppConversationAgent.name,
  );
  private readonly providerOrder: readonly WhatsAppAiProvider[];
  private readonly requestTimeoutMs: number;

  constructor(private readonly config: ConfigService) {
    super();
    this.providerOrder = parseProviderOrder(
      config.get<string>('WHATSAPP_AI_PROVIDER_ORDER'),
    );
    this.requestTimeoutMs = positiveInteger(
      config.get<string | number>('WHATSAPP_AI_REQUEST_TIMEOUT_MS'),
      30_000,
    );
  }

  async complete(
    input: WhatsAppConversationAgentInput,
  ): Promise<WhatsAppConversationAgentResult> {
    if (!input.userMessage.trim()) {
      throw new Error('Mensagem processável não informada.');
    }

    let attempt = 0;
    for (const provider of this.providerOrder) {
      const providerConfig = this.getProviderConfiguration(provider);
      if (!providerConfig) {
        this.logger.warn(
          `Provedor de IA ignorado por configuração incompleta provider=${provider}`,
        );
        continue;
      }

      attempt += 1;
      try {
        const output = await this.requestProvider(providerConfig, input);
        this.logger.log(
          `Resposta de IA validada provider=${provider} attempt=${attempt} promptVersion=${COMMERCIAL_QUOTE_SYSTEM_PROMPT_VERSION} correlationId=${safeCorrelationId(input.correlationId)}`,
        );
        return {
          output,
          provider,
          model: providerConfig.model,
          attempt,
        };
      } catch (error) {
        this.logger.warn(
          `Fallback de IA acionado provider=${provider} attempt=${attempt} correlationId=${safeCorrelationId(input.correlationId)} reason=${safeFailureReason(error)}`,
        );
      }
    }

    throw new Error(
      'Não foi possível gerar uma resposta automática no momento.',
    );
  }

  private getProviderConfiguration(
    provider: WhatsAppAiProvider,
  ): ProviderConfiguration | null {
    const prefix = `WHATSAPP_AI_${provider.toUpperCase()}`;
    const apiKey = cleanConfigValue(
      this.config.get<string>(`${prefix}_API_KEY`),
    );
    const model = cleanConfigValue(this.config.get<string>(`${prefix}_MODEL`));
    const baseUrl =
      cleanConfigValue(this.config.get<string>(`${prefix}_BASE_URL`)) ??
      DEFAULT_BASE_URLS[provider];

    if (!apiKey || !model) return null;

    return { provider, apiKey, baseUrl, model };
  }

  private async requestProvider(
    providerConfig: ProviderConfiguration,
    input: WhatsAppConversationAgentInput,
  ): Promise<AiProviderOutput> {
    const response = await fetch(chatCompletionsUrl(providerConfig.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${providerConfig.apiKey}`,
        'content-type': 'application/json',
        'x-lume-correlation-id': input.correlationId,
      },
      body: JSON.stringify({
        model: providerConfig.model,
        stream: false,
        messages: [
          { role: 'system', content: buildSystemPrompt(input) },
          { role: 'user', content: input.userMessage.trim() },
        ],
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    if (!response.ok) {
      throw new Error(`provedor respondeu HTTP ${response.status}`);
    }

    const rawText = extractChatCompletionText(await response.json());
    const parsed = parseProviderJson(rawText);
    const validation = validateAiProviderOutput(parsed);
    if (!validation.valid || !validation.output) {
      throw new Error(`schema inválido: ${validation.errors.join('; ')}`);
    }

    return {
      ...validation.output,
      missingFields: [
        ...new Set(
          validation.output.missingFields
            .map((field) => field.trim())
            .filter(Boolean),
        ),
      ],
    };
  }
}

export function parseProviderOrder(
  value: string | null | undefined,
): readonly WhatsAppAiProvider[] {
  const configured = (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(isWhatsAppAiProvider);
  const unique = [...new Set(configured)];
  return unique.length > 0 ? unique : DEFAULT_PROVIDER_ORDER;
}

function isWhatsAppAiProvider(value: string): value is WhatsAppAiProvider {
  return AI_PROVIDERS.includes(value as WhatsAppAiProvider);
}

function cleanConfigValue(value: string | null | undefined): string | null {
  const clean = value?.trim();
  return clean ? clean : null;
}

function positiveInteger(
  value: string | number | null | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/g, '');
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function buildSystemPrompt(input: WhatsAppConversationAgentInput): string {
  return [
    COMMERCIAL_QUOTE_SYSTEM_PROMPT,
    `Versão do prompt: ${COMMERCIAL_QUOTE_SYSTEM_PROMPT_VERSION}`,
    `Modo atual: ${input.aiMode}`,
    input.currentConversation
      ? `Conversa canônica:\n${JSON.stringify(input.currentConversation)}`
      : '',
    input.instructionText,
    input.contextText,
    input.contentText,
  ]
    .filter((part): part is string =>
      Boolean(typeof part === 'string' && part.trim()),
    )
    .join('\n\n');
}

function extractChatCompletionText(value: unknown): string {
  const response = asRecord(value);
  const choices = response?.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('provedor não retornou escolhas');
  }

  const choice = asRecord(choices[0]);
  const message = asRecord(choice?.message);
  const content = message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('provedor não retornou texto');
  }

  return content.trim();
}

function parseProviderJson(value: string): unknown {
  const normalized = value
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error('provedor retornou JSON inválido');
  }

  const record = asRecord(parsed);
  if (record && typeof record.message === 'string') {
    try {
      const nested = asRecord(JSON.parse(record.message.trim()));
      if (nested) parsed = { ...record, ...nested };
    } catch {
      // O campo message normalmente é texto. JSON aninhado é apenas uma
      // compatibilidade com respostas históricas anteriores à consolidação.
    }
  }

  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function safeCorrelationId(value: string): string {
  return sanitizeLogText(value, 120).replace(/[\r\n]/g, '');
}

function safeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : 'falha desconhecida';
  return sanitizeLogText(message, 200).replace(/[\r\n]/g, ' ');
}

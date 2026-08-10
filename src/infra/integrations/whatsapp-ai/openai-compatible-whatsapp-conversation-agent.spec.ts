import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WhatsAppConversationAgentInput } from '../../../application/contracts/whatsapp-conversation-agent';
import {
  OpenAiCompatibleWhatsAppConversationAgent,
  parseProviderOrder,
} from './openai-compatible-whatsapp-conversation-agent';

const validOutput = {
  message: 'Qual é o local de origem?',
  collectionStatus: 'collecting',
  extractedDataPatch: {},
  missingFields: ['origin'],
  summaryPresented: false,
  customerDecision: 'undecided',
} as const;

const input: WhatsAppConversationAgentInput = {
  sourceEventId: 'event-1',
  correlationId: 'correlation-1',
  companyId: 'company-1',
  conversationId: 'conversation-1',
  aiMode: 'eventual-quote',
  userMessage: 'Preciso de um orçamento.',
  currentConversation: null,
};

function configService(
  values: Readonly<Record<string, string>>,
): ConfigService {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function providerResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function configuredAgent(
  overrides: Readonly<Record<string, string>> = {},
): OpenAiCompatibleWhatsAppConversationAgent {
  return new OpenAiCompatibleWhatsAppConversationAgent(
    configService({
      WHATSAPP_AI_PROVIDER_ORDER: 'openai,cerebras,gemini,groq',
      WHATSAPP_AI_OPENAI_API_KEY: 'openai-secret-key',
      WHATSAPP_AI_OPENAI_BASE_URL: 'https://openai.example/v1/',
      WHATSAPP_AI_OPENAI_MODEL: 'openai-model',
      WHATSAPP_AI_CEREBRAS_API_KEY: 'cerebras-secret-key',
      WHATSAPP_AI_CEREBRAS_BASE_URL: 'https://cerebras.example/v1',
      WHATSAPP_AI_CEREBRAS_MODEL: 'cerebras-model',
      WHATSAPP_AI_GEMINI_API_KEY: 'gemini-secret-key',
      WHATSAPP_AI_GEMINI_BASE_URL: 'https://gemini.example/v1',
      WHATSAPP_AI_GEMINI_MODEL: 'gemini-model',
      WHATSAPP_AI_GROQ_API_KEY: 'groq-secret-key',
      WHATSAPP_AI_GROQ_BASE_URL: 'https://groq.example/v1',
      WHATSAPP_AI_GROQ_MODEL: 'groq-model',
      WHATSAPP_AI_REQUEST_TIMEOUT_MS: '1000',
      ...overrides,
    }),
  );
}

describe('OpenAiCompatibleWhatsAppConversationAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('usa o primeiro provedor configurado e valida o schema canônico', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        providerResponse(`\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await configuredAgent().complete(input);
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(typeof request.body).toBe('string');
    const body = JSON.parse(request.body as string) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };

    expect(url).toBe('https://openai.example/v1/chat/completions');
    expect((request.headers as Record<string, string>).authorization).toBe(
      'Bearer openai-secret-key',
    );
    expect(body.model).toBe('openai-model');
    expect(body.messages[0].content).toContain('Agente Comercial da Milenium');
    expect(body.messages[0].content).toContain('Modo atual: eventual-quote');
    expect(result).toMatchObject({
      provider: 'openai',
      model: 'openai-model',
      attempt: 1,
      output: validOutput,
    });
  });

  it('faz fallback OpenAI para Cerebras após erro HTTP', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(providerResponse('{}', 503))
      .mockResolvedValueOnce(providerResponse(JSON.stringify(validOutput)));
    vi.stubGlobal('fetch', fetchMock);

    const result = await configuredAgent().complete(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://openai.example/v1/chat/completions',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://cerebras.example/v1/chat/completions',
    );
    expect(result).toMatchObject({ provider: 'cerebras', attempt: 2 });
  });

  it('faz fallback quando a resposta não atende ao schema', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        providerResponse(
          JSON.stringify({ message: 'Resposta sem campos obrigatórios.' }),
        ),
      )
      .mockResolvedValueOnce(providerResponse(JSON.stringify(validOutput)));
    vi.stubGlobal('fetch', fetchMock);

    const result = await configuredAgent().complete(input);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.provider).toBe('cerebras');
    expect(result.output).toEqual(validOutput);
  });

  it('respeita a ordem configurável e remove provedores repetidos ou inválidos', () => {
    expect(parseProviderOrder('groq,openai,groq,desconhecido')).toEqual([
      'groq',
      'openai',
    ]);
    expect(parseProviderOrder('desconhecido')).toEqual([
      'openai',
      'cerebras',
      'gemini',
      'groq',
    ]);
  });

  it('não chama provedores sem chave ou modelo', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(providerResponse(JSON.stringify(validOutput)));
    vi.stubGlobal('fetch', fetchMock);
    const agent = new OpenAiCompatibleWhatsAppConversationAgent(
      configService({
        WHATSAPP_AI_PROVIDER_ORDER: 'openai,cerebras',
        WHATSAPP_AI_CEREBRAS_API_KEY: 'cerebras-secret-key',
        WHATSAPP_AI_CEREBRAS_BASE_URL: 'https://cerebras.example/v1',
        WHATSAPP_AI_CEREBRAS_MODEL: 'cerebras-model',
      }),
    );

    const result = await agent.complete(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://cerebras.example/v1/chat/completions',
    );
    expect(result).toMatchObject({ provider: 'cerebras', attempt: 1 });
  });

  it('retorna erro final genérico sem expor credenciais', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('falha de rede'));
    vi.stubGlobal('fetch', fetchMock);

    let thrown: unknown;
    try {
      await configuredAgent().complete(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Não foi possível gerar uma resposta automática no momento.',
    );
    expect((thrown as Error).message).not.toContain('secret-key');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

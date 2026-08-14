import { describe, expect, it } from 'vitest';

import { UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT } from './whatsapp.constants';
import {
  COMMERCIAL_MENU,
  MAIN_MENU,
  appendBufferedMessage,
  buildBufferedText,
  decideAutomationPlan,
  deriveAiActions,
  deterministicCommandId,
  validateAiProviderOutput,
  type AutomationConversation,
  type WhatsAppAutomationEnvelope,
} from './whatsapp-automation-flow';

function conversation(
  overrides: Partial<AutomationConversation> = {},
): AutomationConversation {
  return {
    id: 'conversation-1',
    department: 'commercial',
    conversationState: 'bot-active',
    flowStep: 'main-menu',
    requestStatus: 'not-started',
    resumeState: null,
    version: 1,
    mainMenuPresentedAt: '2026-07-25T12:00:00.000Z',
    followUpMenuPresentedAt: null,
    departmentContactOption: null,
    assignedTo: null,
    currentQuoteRequest: null,
    ...overrides,
  };
}

function envelope(
  text: string | null,
  current = conversation(),
  overrides: {
    readonly firstContact?: boolean;
    readonly reopenedAfterClosure?: boolean;
    readonly kind?: WhatsAppAutomationEnvelope['payload']['message']['kind'];
    readonly topic?: WhatsAppAutomationEnvelope['topic'];
    readonly automationAllowed?: boolean;
    readonly canGenerateReply?: boolean;
    readonly canSendReply?: boolean;
    readonly contextualTransition?: boolean;
    readonly media?: Readonly<Record<string, unknown>> | null;
  } = {},
): WhatsAppAutomationEnvelope {
  return {
    schemaVersion: '1.0',
    id: 'event-1',
    companyId: 'company-1',
    topic: overrides.topic ?? 'whatsapp.inbound.persisted',
    aggregateType: 'whatsapp-conversation',
    aggregateId: current.id,
    aggregateSequence: 1,
    executionId: 'execution-1',
    correlationId: 'correlation-1',
    occurredAt: '2026-07-25T12:00:00.000Z',
    payload: {
      eventId: 'event-1',
      messageId: 'message-1',
      conversationId: current.id,
      channelId: 'channel-1',
      companyId: 'company-1',
      contact: {
        id: 'contact-1',
        phone: '5511999999999',
        displayName: 'Cliente',
      },
      message: {
        providerMessageId: 'provider-message-1',
        direction: 'inbound',
        deliveryStatus: 'received',
        kind: overrides.kind ?? 'text',
        text,
        media: overrides.media ?? null,
        occurredAt: '2026-07-25T12:00:00.000Z',
      },
      conversation: current,
      automationAllowed: overrides.automationAllowed ?? true,
      canGenerateReply: overrides.canGenerateReply ?? true,
      canSendReply: overrides.canSendReply ?? true,
      contextualTransition: overrides.contextualTransition ?? false,
      isFirstContact: overrides.firstContact ?? false,
      reopenedAfterClosure: overrides.reopenedAfterClosure ?? false,
    },
  };
}

describe('fluxo de automação do WhatsApp', () => {
  it('preserva os menus canônicos do perfil n8n', () => {
    expect(MAIN_MENU).toContain('1 - Comercial');
    expect(MAIN_MENU).toContain('9 - Operacional');
    expect(COMMERCIAL_MENU).toContain(
      '1 - Solicitar orçamento de fretamento eventual',
    );
    expect(COMMERCIAL_MENU).toContain(
      '2 - Solicitar orçamento de fretamento contínuo',
    );
  });

  it('mostra o menu principal no primeiro contato', () => {
    const current = conversation({ mainMenuPresentedAt: null });

    expect(
      decideAutomationPlan({
        envelope: envelope('Olá', current, { firstContact: true }),
      }),
    ).toMatchObject({
      kind: 'static-reply',
      responseMessage: MAIN_MENU,
      transitionAfterSend: 'present-main-menu',
      reason: 'initial-menu-pending-durable-confirmation',
    });
  });

  it('usa o estado mais recente quando uma mensagem chegou durante a IA', () => {
    const eventConversation = conversation({ flowStep: 'main-menu' });
    const latestConversation = conversation({
      flowStep: 'quote-data-collection',
      requestStatus: 'collecting-information',
      version: 4,
    });

    expect(
      decideAutomationPlan({
        envelope: envelope('1', eventConversation),
        conversation: latestConversation,
      }),
    ).toMatchObject({
      kind: 'ai',
      aiMode: 'eventual-quote',
      reason: 'continue-quote',
    });
  });

  it.each([
    ['2', 'purchasing'],
    ['3', 'controlling'],
    ['4', 'personnel-department'],
    ['5', 'financial'],
    ['6', 'management'],
    ['7', 'maintenance'],
    ['8', 'monitoring'],
    ['9', 'operations'],
  ] as const)(
    'coleta nome e motivo antes de encaminhar a opção %s para %s',
    (option, targetDepartment) => {
      expect(
        decideAutomationPlan({ envelope: envelope(option) }),
      ).toMatchObject({
        transitionBeforeAi: 'start-department-contact',
        transitionMetadata: { targetDepartment, departmentOption: option },
        reason: 'department-contact-requested',
      });
    },
  );

  it('coleta nome e motivo do fretamento contínuo antes de notificar a Diretoria', () => {
    const current = conversation({ flowStep: 'commercial-menu', version: 3 });

    expect(
      decideAutomationPlan({ envelope: envelope('2', current) }),
    ).toMatchObject({
      kind: 'static-reply',
      aiMode: null,
      transitionBeforeAi: 'start-department-contact',
      transitionAfterSend: null,
      transitionMetadata: {
        targetDepartment: 'management',
        departmentOption: 'commercial-continuous-director',
      },
      reason: 'continuous-quote-director-contact-requested',
    });
  });

  it('notifica a Diretoria depois que o cliente informa nome e motivo', () => {
    const current = conversation({
      flowStep: 'main-menu',
      department: 'management',
      departmentContactOption: 'commercial-continuous-director',
      version: 4,
    });

    expect(
      decideAutomationPlan({
        envelope: envelope(
          'Maria - fretamento contínuo para colaboradores',
          current,
        ),
      }),
    ).toMatchObject({
      kind: 'static-reply',
      responseMessage: expect.stringContaining('Departamento: Diretoria'),
      transitionAfterSend: 'return-to-main-menu',
      outboundPurpose: 'department-notification',
      outboundRecipientPhoneEnv: 'MILENIUM_DIRECTOR_PHONE',
      reason: 'department-contact-forwarded',
    });
  });

  it('orienta conteúdo não textual sem enviá-lo para a IA nem alterar o fluxo', () => {
    const event = envelope(null, conversation(), {
      kind: 'audio',
      media: { transcription: 'conteúdo que não deve chegar à IA' },
    });

    expect(decideAutomationPlan({ envelope: event })).toMatchObject({
      kind: 'static-reply',
      responseMessage: UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT,
      transitionBeforeAi: null,
      transitionAfterSend: null,
      aiMode: null,
      reason: 'unsupported-message-kind-preserves-conversation-state',
      outboundPurpose: 'unsupported-message-kind',
    });
  });

  it.each([
    'image',
    'audio',
    'video',
    'sticker',
    'document',
    'location',
    'contact',
    'unknown',
  ] as const)('bloqueia %s antes do roteamento do menu comercial', (kind) => {
    const current = conversation({
      flowStep: 'commercial-menu',
      version: 3,
    });

    expect(
      decideAutomationPlan({
        envelope: envelope(null, current, {
          kind,
          media: { ignoredByAutomation: true },
        }),
      }),
    ).toMatchObject({
      kind: 'static-reply',
      responseMessage: UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT,
      transitionBeforeAi: null,
      transitionAfterSend: null,
      aiMode: null,
      outboundPurpose: 'unsupported-message-kind',
    });
  });

  it('apresenta o menu antes de orientar uma mídia após encerramento', () => {
    const current = conversation({ mainMenuPresentedAt: null });
    const plan = decideAutomationPlan({
      envelope: envelope(null, current, {
        kind: 'image',
        media: { mimeType: 'image/jpeg' },
        reopenedAfterClosure: true,
      }),
    });

    expect(plan).toMatchObject({
      kind: 'static-reply',
      transitionAfterSend: 'present-main-menu',
      outboundPurpose: 'main-menu',
      reason: 'reopened-conversation-menu-pending-durable-confirmation',
    });
    expect(plan.responseMessage).toBe(
      `${MAIN_MENU}\n\n${UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT}`,
    );
  });

  it('repete a pergunta pendente do orçamento quando recebe mídia', () => {
    const current = conversation({
      flowStep: 'quote-data-collection',
      requestStatus: 'collecting-information',
    });

    expect(
      decideAutomationPlan({
        envelope: envelope(null, current, {
          kind: 'document',
          media: { mimeType: 'application/pdf' },
        }),
        pendingQuestion: 'Qual é a cidade de destino?',
      }),
    ).toMatchObject({
      responseMessage: `Qual é a cidade de destino?\n\n${UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT}`,
      transitionBeforeAi: null,
      transitionAfterSend: null,
      aiMode: null,
    });
  });

  it.each([
    'text',
    'image',
    'audio',
    'video',
    'sticker',
    'document',
    'unknown',
  ] as const)(
    'mantém silêncio absoluto para %s durante atendimento humano',
    (kind) => {
      const current = conversation({
        conversationState: 'human-active',
        flowStep: 'human-service',
        assignedTo: { id: 'user-1', name: 'Operador' },
      });

      expect(
        decideAutomationPlan({
          envelope: envelope(kind === 'text' ? 'Detalhe' : null, current, {
            kind,
            media: kind === 'text' ? null : { received: true },
            topic: 'whatsapp.inbound.human-notification',
            automationAllowed: false,
            canGenerateReply: false,
            canSendReply: false,
          }),
        }),
      ).toMatchObject({
        kind: 'human-notification',
        responseMessage: null,
        transitionAfterSend: null,
        reason: 'human-active-blocks-bot',
      });
    },
  );

  it.each([
    { conversationState: 'sent-to-human' as const },
    { flowStep: 'human-service' as const },
    { assignedTo: { id: 'user-1', name: 'Operador' } },
  ])(
    'bloqueia toda automação em qualquer sinal de atendimento humano',
    (blocked) => {
      expect(
        decideAutomationPlan({
          envelope: envelope('Olá', conversation(blocked)),
        }),
      ).toMatchObject({
        kind: 'human-notification',
        responseMessage: null,
      });
    },
  );

  it('não ativa o bot durante atendimento humano', () => {
    const current = conversation({
      conversationState: 'human-active',
      flowStep: 'human-service',
      assignedTo: { id: 'user-1', name: 'Operador' },
    });

    expect(
      decideAutomationPlan({
        envelope: envelope('Mais um detalhe', current, {
          topic: 'whatsapp.inbound.human-notification',
          automationAllowed: false,
          canGenerateReply: false,
          canSendReply: false,
        }),
      }),
    ).toMatchObject({
      kind: 'human-notification',
      responseMessage: null,
      reason: 'human-active-blocks-bot',
    });
  });

  it('encaminha opção inválida do acompanhamento para humano', () => {
    const current = conversation({
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
      followUpMenuPresentedAt: '2026-07-25T12:00:00.000Z',
    });

    expect(
      decideAutomationPlan({ envelope: envelope('quero ajuda', current) }),
    ).toMatchObject({
      transitionAfterSend: 'forward',
      transitionMetadata: {
        targetDepartment: 'commercial',
        reason: 'invalid-commercial-follow-up-option',
      },
    });
  });

  it('valida todas as chaves obrigatórias do provedor', () => {
    expect(
      validateAiProviderOutput({
        message: 'Qual é a origem?',
        collectionStatus: 'collecting',
        extractedDataPatch: {},
        missingFields: ['origin'],
        summaryPresented: false,
        customerDecision: 'undecided',
      }),
    ).toMatchObject({ valid: true, errors: [] });

    expect(
      validateAiProviderOutput({
        message: 'Sem decisão',
        collectionStatus: 'collecting',
        extractedDataPatch: {},
        missingFields: [],
        summaryPresented: false,
      }),
    ).toMatchObject({ valid: false, output: null });
  });

  it('encaminha a pré-triagem contínua quando completa', () => {
    expect(
      deriveAiActions(
        {
          message: 'Obrigado, vou encaminhar.',
          collectionStatus: 'completed',
          extractedDataPatch: { serviceType: 'continuous' },
          missingFields: [],
          summaryPresented: false,
          customerDecision: 'undecided',
        },
        'continuous-pretriage',
      ),
    ).toEqual({
      sendMessage: true,
      transitionBeforeSend: null,
      transitionAfterSend: 'forward',
      humanReason: 'continuous-pretriage-completed',
    });
  });

  it('gera commandId UUID v5 estável e distinto por ação', () => {
    const first = deterministicCommandId('source-event-1', 'transition:start');
    const replay = deterministicCommandId('source-event-1', 'transition:start');
    const outbound = deterministicCommandId('source-event-1', 'outbound');

    expect(first).toBe(replay);
    expect(first).not.toBe(outbound);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('ordena e deduplica mensagens do buffer por evento de origem', () => {
    const first = {
      sourceEventId: 'event-1',
      messageId: 'message-1',
      occurredAt: '2026-07-25T12:00:00.000Z',
      kind: 'text',
      text: 'Meu nome é Ana',
      isFirstContact: false,
    };
    const second = {
      sourceEventId: 'event-2',
      messageId: 'message-2',
      occurredAt: '2026-07-25T12:00:01.000Z',
      kind: 'text',
      text: 'Saída de Campinas',
      isFirstContact: false,
    };

    const buffered = appendBufferedMessage(
      appendBufferedMessage(appendBufferedMessage([], second), first),
      second,
    );

    expect(buffered).toHaveLength(2);
    expect(buildBufferedText(buffered)).toBe(
      'Meu nome é Ana\nSaída de Campinas',
    );
  });
});

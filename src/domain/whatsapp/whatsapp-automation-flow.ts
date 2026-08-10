import type { Department } from '../access/access.constants';
import {
  UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT,
  type ConversationState,
  type FlowStep,
  type MessageKind,
  type RequestStatus,
  type TransitionName,
} from './whatsapp.constants';

export const MAIN_MENU = [
  'Olá! Sou a Milena, assistente virtual da Milenium.',
  '',
  '1 - Comercial',
  '2 - Compras (Fornecedores)',
  '3 - Controladoria',
  '4 - Departamento Pessoal',
  '5 - Financeiro',
  '6 - Gerência',
  '7 - Manutenção',
  '8 - Monitoramento',
  '9 - Operacional',
  '',
  'Responda com o número da opção desejada.',
].join('\n');

export const DEPARTMENT_CONTACT_PROMPT =
  'Para prosseguir, informe seu nome e o motivo do seu contato em uma única mensagem';

export const DEPARTMENT_CONTACTS = {
  '2': {
    label: 'Compras (Fornecedores)',
    departmentPhoneEnv: 'MILENIUM_DEPARTMENT_PURCHASES_PHONE',
    targetDepartment: 'purchasing',
  },
  '3': {
    label: 'Controladoria',
    departmentPhoneEnv: 'MILENIUM_DEPARTMENT_CONTROLLING_PHONE',
    targetDepartment: 'controlling',
  },
  '4': {
    label: 'Departamento Pessoal',
    departmentPhoneEnv: 'MILENIUM_DEPARTMENT_DP_PHONE',
    targetDepartment: 'personnel-department',
  },
  '5': {
    label: 'Financeiro',
    departmentPhoneEnv: 'MILENIUM_DEPARTMENT_FINANCE_PHONE',
    targetDepartment: 'financial',
  },
  '6': {
    label: 'Gerência',
    departmentPhoneEnv: 'MILENIUM_DEPARTMENT_MANAGEMENT_PHONE',
    targetDepartment: 'management',
  },
  '7': {
    label: 'Manutenção',
    departmentPhoneEnv: 'MILENIUM_DEPARTMENT_MAINTENANCE_PHONE',
    targetDepartment: 'maintenance',
  },
  '8': {
    label: 'Monitoramento',
    departmentPhoneEnv: 'MILENIUM_DEPARTMENT_MONITORING_PHONE',
    targetDepartment: 'monitoring',
  },
  '9': {
    label: 'Operacional',
    departmentPhoneEnv: 'MILENIUM_DEPARTMENT_OPERATIONAL_PHONE',
    targetDepartment: 'operations',
  },
} as const satisfies Readonly<
  Record<
    string,
    {
      label: string;
      departmentPhoneEnv: string;
      targetDepartment: Department;
    }
  >
>;

export const COMMERCIAL_MENU = [
  'Menu Comercial',
  '',
  'Informe a opção desejada:',
  '1 - Solicitar orçamento de fretamento eventual',
  '2 - Solicitar orçamento de fretamento contínuo',
  '3 - Dúvida ou alteração',
  '4 - Acompanhamento',
  '5 - Documentos',
  '6 - Outros assuntos comerciais',
  '0 - Menu principal',
].join('\n');

export const COMMERCIAL_FOLLOW_UP_MENU = [
  'Olá sou a Milena, assistente virtual da Milenium Transportes e identifiquei que você tem uma solicitação em andamento, por favor, responda com a opção desejada:',
  '',
  'Informe a opção desejada:',
  '1. Verificar status do orçamento',
  '2. Alterar dados do orçamento',
  '3. Enviar documentação',
  '4. Acompanhar viagem',
  '0. Voltar para menu inicial',
].join('\n');

export const QUOTE_CONFIRMATION_MESSAGE =
  'Orçamento confirmado. Encaminhei sua solicitação ao time Comercial. No próximo contato, você receberá o menu de acompanhamento da solicitação.';

export const HUMAN_REASON_BY_OPTION: Readonly<Record<string, string>> = {
  '2': 'continuous-quote-requested',
  '3': 'commercial-question-or-change',
  '4': 'commercial-follow-up',
  '5': 'commercial-documents',
  '6': 'other-commercial-subject',
};

export const FOLLOW_UP_HUMAN_REASON_BY_OPTION: Readonly<
  Record<string, string>
> = {
  '1': 'quote-status-requested',
  '2': 'quote-change-requested',
  '3': 'quote-documentation',
  '4': 'trip-follow-up',
};

export const FOLLOW_UP_HANDOFF_MESSAGE =
  'Seu atendimento foi redirecionado para o time Comercial. Um especialista irá entrar em contato em breve.';

export const INVALID_FOLLOW_UP_HANDOFF_MESSAGE =
  'Não consegui identificar uma das opções disponíveis. Seu atendimento foi redirecionado para o time Comercial e um especialista irá entrar em contato em breve.';

export type AutomationTopic =
  | 'whatsapp.inbound.persisted'
  | 'whatsapp.inbound.human-notification'
  | 'whatsapp.outbound.requested';

export interface QuoteRequestSnapshot {
  readonly id: string;
  readonly sequence: number;
  readonly status: RequestStatus;
  readonly version: number;
  readonly contactName?: string | null;
  readonly document?: string | null;
  readonly email?: string | null;
  readonly serviceType?: string | null;
  readonly origin?: string | null;
  readonly destination?: string | null;
  readonly departureDate?: string | null;
  readonly departureAt?: string | null;
  readonly returnDate?: string | null;
  readonly returnAt?: string | null;
  readonly passengerCount?: number | null;
  readonly vehicleType?: string | null;
  readonly vehicleAtDisposal?: boolean | null;
  readonly localTransfers?: boolean | null;
  readonly notes?: string | null;
  readonly structuredData?: Readonly<Record<string, unknown>> | null;
}

export interface AutomationConversation {
  readonly id: string;
  readonly department: Department;
  readonly conversationState: ConversationState;
  readonly flowStep: FlowStep;
  readonly requestStatus: RequestStatus;
  readonly resumeState: ConversationState | null;
  readonly version: number;
  readonly mainMenuPresentedAt?: string | null;
  readonly followUpMenuPresentedAt?: string | null;
  readonly departmentContactOption?: string | null;
  readonly assignedTo?: { readonly id: string; readonly name: string } | null;
  readonly currentQuoteRequest?: QuoteRequestSnapshot | null;
}

export interface WhatsAppAutomationEnvelope {
  readonly schemaVersion: '1.0';
  readonly id: string;
  readonly companyId: string;
  readonly topic: AutomationTopic;
  readonly aggregateType: 'whatsapp-conversation';
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly executionId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly payload: {
    readonly eventId: string;
    readonly messageId: string;
    readonly attemptId?: string;
    readonly conversationId: string;
    readonly channelId: string;
    readonly companyId: string;
    readonly contact: {
      readonly id: string;
      readonly phone: string;
      readonly displayName: string | null;
    };
    readonly message: {
      readonly providerMessageId: string | null;
      readonly direction: 'inbound' | 'outbound';
      readonly deliveryStatus: 'received' | 'pending';
      readonly kind: MessageKind;
      readonly text: string | null;
      readonly media: Readonly<Record<string, unknown>> | null;
      readonly occurredAt: string;
    };
    readonly conversation: AutomationConversation;
    readonly automationAllowed: boolean;
    readonly canGenerateReply: boolean;
    readonly canSendReply: boolean;
    readonly contextualTransition: boolean;
    readonly isFirstContact: boolean;
    readonly reopenedAfterClosure: boolean;
    readonly automatic?: boolean;
  };
}

export const ACTIVE_QUOTE_REQUEST_STATUSES: ReadonlySet<RequestStatus> =
  new Set(['waiting-for-customer', 'under-review', 'approved', 'rejected']);

export type AiMode =
  | 'eventual-quote'
  | 'continuous-pretriage'
  | 'quote-correction-or-confirmation';

export interface AutomationPlan {
  readonly kind:
    | 'static-reply'
    | 'ai'
    | 'human-notification'
    | 'suppressed'
    | 'transition-only';
  readonly responseMessage: string | null;
  readonly transitionBeforeAi: TransitionName | null;
  readonly transitionAfterSend: TransitionName | null;
  readonly transitionMetadata: Readonly<Record<string, unknown>> | null;
  readonly aiMode: AiMode | null;
  readonly reason: string;
  readonly outboundPurpose?:
    | 'main-menu'
    | 'commercial-follow-up-menu'
    | 'department-notification'
    | 'unsupported-message-kind'
    | null;
  readonly outboundRecipientPhoneEnv?: string | null;
}

export interface AiProviderOutput {
  readonly message: string;
  readonly collectionStatus:
    'collecting' | 'ready-for-summary' | 'completed' | 'human-handoff';
  readonly extractedDataPatch: Readonly<Record<string, unknown>>;
  readonly missingFields: readonly string[];
  readonly summaryPresented: boolean;
  readonly customerDecision:
    'undecided' | 'confirmed' | 'correction-requested' | 'human-requested';
}

export interface AiValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly output: AiProviderOutput | null;
}

export interface BufferedMessage {
  readonly sourceEventId: string;
  readonly messageId: string;
  readonly occurredAt: string;
  readonly kind: string;
  readonly text: string | null;
  readonly isFirstContact: boolean;
}

export function decideAutomationPlan(input: {
  readonly envelope: WhatsAppAutomationEnvelope;
  readonly conversation?: AutomationConversation;
  readonly bufferedText?: string | null;
  readonly pendingQuestion?: string | null;
}): AutomationPlan {
  const { envelope } = input;
  const currentConversation =
    input.conversation ?? envelope.payload.conversation;
  const routingConversation = envelope.payload.conversation;
  const messageText = (
    input.bufferedText ??
    getProcessableMessageText(envelope) ??
    ''
  ).trim();

  const initialMenuRequired =
    currentConversation.conversationState === 'bot-active' &&
    (envelope.payload.isFirstContact ||
      envelope.payload.reopenedAfterClosure) &&
    !currentConversation.mainMenuPresentedAt;

  if (initialMenuRequired) {
    return {
      kind: 'static-reply',
      responseMessage:
        envelope.payload.message.kind === 'text'
          ? MAIN_MENU
          : `${MAIN_MENU}\n\n${UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT}`,
      transitionBeforeAi: null,
      transitionAfterSend: 'present-main-menu',
      transitionMetadata: {
        reason: envelope.payload.reopenedAfterClosure
          ? 'main-menu-after-closure'
          : 'initial-menu',
      },
      aiMode: null,
      reason: envelope.payload.reopenedAfterClosure
        ? 'reopened-conversation-menu-pending-durable-confirmation'
        : 'initial-menu-pending-durable-confirmation',
      outboundPurpose: 'main-menu',
    };
  }

  if (envelope.payload.message.kind !== 'text') {
    const pendingQuestion = input.pendingQuestion?.trim();
    const inQuoteCollection = [
      'quote-data-collection',
      'quote-summary-confirmation',
    ].includes(currentConversation.flowStep);
    return {
      kind: 'static-reply',
      responseMessage:
        inQuoteCollection && pendingQuestion
          ? `${pendingQuestion}\n\n${UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT}`
          : UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT,
      transitionBeforeAi: null,
      transitionAfterSend: null,
      transitionMetadata: null,
      aiMode: null,
      reason: 'unsupported-message-kind-preserves-conversation-state',
      outboundPurpose: 'unsupported-message-kind',
    };
  }

  if (
    envelope.topic === 'whatsapp.inbound.human-notification' ||
    currentConversation.conversationState === 'human-active'
  ) {
    return {
      kind: 'human-notification',
      responseMessage: null,
      transitionBeforeAi: null,
      transitionAfterSend: null,
      transitionMetadata: {
        reason: 'human-conversation-inbound',
        historyAvailableInPanel: true,
      },
      aiMode: null,
      reason: 'human-active-blocks-bot',
    };
  }

  if (
    envelope.payload.automationAllowed !== true ||
    envelope.payload.canGenerateReply !== true ||
    envelope.payload.canSendReply !== true ||
    currentConversation.conversationState !== 'bot-active'
  ) {
    return suppressed('tenant-api-did-not-authorize-automatic-reply');
  }

  if (currentConversation.departmentContactOption) {
    return decideDepartmentContact(
      currentConversation.departmentContactOption,
      messageText,
      envelope.payload.contact.phone,
    );
  }

  if (
    routingConversation.flowStep === 'commercial-follow-up-menu' &&
    (envelope.payload.contextualTransition ||
      currentConversation.followUpMenuPresentedAt === null)
  ) {
    return {
      kind: 'static-reply',
      responseMessage: COMMERCIAL_FOLLOW_UP_MENU,
      transitionBeforeAi: null,
      transitionAfterSend: null,
      transitionMetadata: null,
      aiMode: null,
      reason: 'commercial-follow-up-menu-presented',
      outboundPurpose: 'commercial-follow-up-menu',
    };
  }

  if (routingConversation.flowStep === 'commercial-follow-up-menu') {
    return decideCommercialFollowUpMenu(messageText);
  }

  if (!messageText) {
    return {
      kind: 'static-reply',
      responseMessage:
        'No MVP eu consigo processar texto, áudio já transcrito e texto extraído de imagem ou PDF. Por favor, descreva o conteúdo em uma mensagem de texto.',
      transitionBeforeAi: null,
      transitionAfterSend: null,
      transitionMetadata: null,
      aiMode: null,
      reason: 'processable-text-required',
    };
  }

  switch (routingConversation.flowStep) {
    case 'main-menu':
      return decideMainMenu(messageText, routingConversation);
    case 'commercial-menu':
      return decideCommercialMenu(messageText);
    case 'quote-data-collection':
      return aiPlan(
        resolveQuoteMode(routingConversation),
        null,
        'continue-quote',
      );
    case 'quote-summary-confirmation':
      return aiPlan(
        'quote-correction-or-confirmation',
        null,
        'evaluate-summary-decision',
      );
    case 'human-service':
    case 'quote-send-pending':
      return {
        kind: 'human-notification',
        responseMessage: null,
        transitionBeforeAi: null,
        transitionAfterSend: null,
        transitionMetadata: {
          reason: 'human-service-inbound',
          historyAvailableInPanel: true,
        },
        aiMode: null,
        reason: 'human-service-blocks-bot',
      };
    case 'closed':
      return suppressed('conversation-closed');
  }
}

export function validateAiProviderOutput(value: unknown): AiValidationResult {
  const errors: string[] = [];
  const output = asRecord(value);

  if (!output) {
    return {
      valid: false,
      errors: ['resposta deve ser um objeto JSON'],
      output: null,
    };
  }

  const message =
    typeof output.message === 'string' ? output.message.trim() : '';
  if (!message) errors.push('message é obrigatório');

  const statuses = new Set([
    'collecting',
    'ready-for-summary',
    'completed',
    'human-handoff',
  ]);
  if (!statuses.has(String(output.collectionStatus))) {
    errors.push('collectionStatus é inválido');
  }

  if (!asRecord(output.extractedDataPatch)) {
    errors.push('extractedDataPatch deve ser um objeto');
  }

  if (
    !Array.isArray(output.missingFields) ||
    output.missingFields.some((item) => typeof item !== 'string')
  ) {
    errors.push('missingFields deve ser uma lista de strings');
  }

  if (typeof output.summaryPresented !== 'boolean') {
    errors.push('summaryPresented deve ser boolean');
  }

  const decisions = new Set([
    'undecided',
    'confirmed',
    'correction-requested',
    'human-requested',
  ]);
  if (!decisions.has(String(output.customerDecision))) {
    errors.push('customerDecision é inválido');
  }

  if (errors.length > 0) {
    return { valid: false, errors, output: null };
  }

  return {
    valid: true,
    errors: [],
    output: {
      message,
      collectionStatus:
        output.collectionStatus as AiProviderOutput['collectionStatus'],
      extractedDataPatch: output.extractedDataPatch as Record<string, unknown>,
      missingFields: output.missingFields as string[],
      summaryPresented: output.summaryPresented as boolean,
      customerDecision:
        output.customerDecision as AiProviderOutput['customerDecision'],
    },
  };
}

export function deriveAiActions(
  output: AiProviderOutput,
  aiMode: AiMode,
): {
  readonly sendMessage: boolean;
  readonly transitionBeforeSend: TransitionName | null;
  readonly transitionAfterSend: TransitionName | null;
  readonly humanReason: string | null;
} {
  if (output.customerDecision === 'confirmed') {
    return {
      sendMessage: true,
      transitionBeforeSend: null,
      transitionAfterSend: 'confirm-quote',
      humanReason: 'quote-summary-confirmed',
    };
  }

  if (output.customerDecision === 'correction-requested') {
    return {
      sendMessage: true,
      transitionBeforeSend: 'correct-quote',
      transitionAfterSend: null,
      humanReason: null,
    };
  }

  if (
    output.customerDecision === 'human-requested' ||
    output.collectionStatus === 'human-handoff'
  ) {
    return {
      sendMessage: true,
      transitionBeforeSend: null,
      transitionAfterSend: 'forward',
      humanReason: 'customer-requested-human',
    };
  }

  if (
    aiMode === 'continuous-pretriage' &&
    output.collectionStatus === 'completed'
  ) {
    return {
      sendMessage: true,
      transitionBeforeSend: null,
      transitionAfterSend: 'forward',
      humanReason: 'continuous-pretriage-completed',
    };
  }

  if (
    output.summaryPresented ||
    output.collectionStatus === 'ready-for-summary'
  ) {
    return {
      sendMessage: true,
      transitionBeforeSend: null,
      transitionAfterSend: 'present-quote-summary',
      humanReason: null,
    };
  }

  return {
    sendMessage: true,
    transitionBeforeSend: null,
    transitionAfterSend: null,
    humanReason: null,
  };
}

export function isExplicitPositiveConfirmation(value: string): boolean {
  const normalized = value
    .trim()
    .toLocaleLowerCase('pt-BR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?]+$/g, '')
    .trim();

  return new Set([
    'sim',
    'sim, confirmo',
    'sim, esta correto',
    'sim, pode confirmar',
    'sim, pode enviar',
    'sim, pode encaminhar',
    'confirmo',
    'confirmado',
    'correto',
    'esta correto',
    'esta tudo certo',
    'os dados estao corretos',
    'pode confirmar',
    'pode enviar',
    'pode encaminhar',
    'de acordo',
    'tudo certo',
    'ok',
    'okay',
  ]).has(normalized);
}

export function appendBufferedMessage(
  current: readonly BufferedMessage[],
  next: BufferedMessage,
): BufferedMessage[] {
  const bySourceEvent = new Map(
    current.map((message) => [message.sourceEventId, message]),
  );
  bySourceEvent.set(next.sourceEventId, next);

  return [...bySourceEvent.values()].sort((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );
}

export function buildBufferedText(
  messages: readonly BufferedMessage[],
): string {
  return messages
    .map((message) => message.text?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n');
}

export function deterministicCommandId(
  sourceEventId: string,
  action: string,
): string {
  const value = `${sourceEventId}:${action}`;
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d];
  const hashes = seeds.map((seed, index) => {
    let hash = seed >>> 0;
    for (let cursor = 0; cursor < value.length; cursor += 1) {
      hash ^= value.charCodeAt(cursor) + index * 17;
      hash = Math.imul(hash, 0x01000193) >>> 0;
      hash ^= hash >>> 13;
    }
    return hash >>> 0;
  });
  const bytes = hashes.flatMap((hash) => [
    (hash >>> 24) & 0xff,
    (hash >>> 16) & 0xff,
    (hash >>> 8) & 0xff,
    hash & 0xff,
  ]);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export function redisConversationPrefix(input: {
  readonly environment: string;
  readonly companyId: string;
  readonly conversationId: string;
}): string {
  const clean = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return [
    'milenium',
    'whatsapp',
    clean(input.environment || 'local'),
    clean(input.companyId),
    clean(input.conversationId),
  ].join(':');
}

function decideMainMenu(
  messageText: string,
  conversation: AutomationConversation,
): AutomationPlan {
  const option = normalizedOption(messageText);

  if (option === '1') {
    const hasActiveQuote =
      conversation.currentQuoteRequest != null &&
      ACTIVE_QUOTE_REQUEST_STATUSES.has(conversation.requestStatus);
    return {
      kind: 'static-reply',
      responseMessage: hasActiveQuote
        ? COMMERCIAL_FOLLOW_UP_MENU
        : COMMERCIAL_MENU,
      transitionBeforeAi: 'select-commercial',
      transitionAfterSend: null,
      transitionMetadata: null,
      aiMode: null,
      reason: hasActiveQuote
        ? 'commercial-follow-up-selected'
        : 'commercial-selected',
      outboundPurpose: hasActiveQuote ? 'commercial-follow-up-menu' : null,
    };
  }

  const department =
    DEPARTMENT_CONTACTS[option as keyof typeof DEPARTMENT_CONTACTS];
  if (department) {
    return {
      kind: 'static-reply',
      responseMessage: DEPARTMENT_CONTACT_PROMPT,
      transitionBeforeAi: 'start-department-contact',
      transitionAfterSend: null,
      transitionMetadata: {
        targetDepartment: department.targetDepartment,
        departmentOption: option,
      },
      aiMode: null,
      reason: 'department-contact-requested',
    };
  }

  return {
    kind: 'static-reply',
    responseMessage: /^\d+$/.test(option)
      ? `Opção inválida.\n\n${MAIN_MENU}`
      : MAIN_MENU,
    transitionBeforeAi: null,
    transitionAfterSend: null,
    transitionMetadata: null,
    aiMode: null,
    reason: /^\d+$/.test(option)
      ? 'invalid-main-menu-option'
      : 'main-menu-prompt',
  };
}

function decideCommercialMenu(messageText: string): AutomationPlan {
  const option = normalizedOption(messageText);

  if (option === '1') {
    return aiPlan('eventual-quote', 'start-quote', 'start-eventual-quote');
  }

  if (HUMAN_REASON_BY_OPTION[option]) {
    return {
      kind: 'static-reply',
      responseMessage: FOLLOW_UP_HANDOFF_MESSAGE,
      transitionBeforeAi: null,
      transitionAfterSend: 'forward',
      transitionMetadata: {
        targetDepartment: 'commercial',
        reason: HUMAN_REASON_BY_OPTION[option],
        historyAvailableInPanel: true,
      },
      aiMode: null,
      reason: HUMAN_REASON_BY_OPTION[option],
    };
  }

  if (option === '0') {
    return {
      kind: 'static-reply',
      responseMessage: MAIN_MENU,
      transitionBeforeAi: 'return-to-main-menu',
      transitionAfterSend: null,
      transitionMetadata: null,
      aiMode: null,
      reason: 'return-to-main-menu',
      outboundPurpose: 'main-menu',
    };
  }

  return {
    kind: 'static-reply',
    responseMessage: `Opção inválida.\n\n${COMMERCIAL_MENU}`,
    transitionBeforeAi: null,
    transitionAfterSend: null,
    transitionMetadata: null,
    aiMode: null,
    reason: 'invalid-commercial-menu-option',
  };
}

function decideCommercialFollowUpMenu(messageText: string): AutomationPlan {
  const option = normalizedOption(messageText);

  if (option === '0') {
    return {
      kind: 'static-reply',
      responseMessage: MAIN_MENU,
      transitionBeforeAi: 'return-to-main-menu',
      transitionAfterSend: null,
      transitionMetadata: null,
      aiMode: null,
      reason: 'return-to-main-menu',
      outboundPurpose: 'main-menu',
    };
  }

  const reason =
    FOLLOW_UP_HUMAN_REASON_BY_OPTION[option] ??
    'invalid-commercial-follow-up-option';
  return {
    kind: 'static-reply',
    responseMessage: FOLLOW_UP_HUMAN_REASON_BY_OPTION[option]
      ? FOLLOW_UP_HANDOFF_MESSAGE
      : INVALID_FOLLOW_UP_HANDOFF_MESSAGE,
    transitionBeforeAi: null,
    transitionAfterSend: 'forward',
    transitionMetadata: {
      targetDepartment: 'commercial',
      reason,
      historyAvailableInPanel: true,
    },
    aiMode: null,
    reason,
  };
}

function aiPlan(
  aiMode: AiMode,
  transitionBeforeAi: TransitionName | null,
  reason: string,
): AutomationPlan {
  return {
    kind: 'ai',
    responseMessage: null,
    transitionBeforeAi,
    transitionAfterSend: null,
    transitionMetadata: null,
    aiMode,
    reason,
  };
}

function suppressed(reason: string): AutomationPlan {
  return {
    kind: 'suppressed',
    responseMessage: null,
    transitionBeforeAi: null,
    transitionAfterSend: null,
    transitionMetadata: null,
    aiMode: null,
    reason,
  };
}

function normalizedOption(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .find(Boolean);
  return firstLine ?? '';
}

function decideDepartmentContact(
  option: string,
  messageText: string,
  customerPhone: string,
): AutomationPlan {
  const department =
    DEPARTMENT_CONTACTS[option as keyof typeof DEPARTMENT_CONTACTS];
  if (!department) {
    return {
      kind: 'static-reply',
      responseMessage: MAIN_MENU,
      transitionBeforeAi: 'return-to-main-menu',
      transitionAfterSend: null,
      transitionMetadata: null,
      aiMode: null,
      reason: 'invalid-department-contact-state',
      outboundPurpose: 'main-menu',
    };
  }

  if (!messageText) {
    return {
      kind: 'static-reply',
      responseMessage: DEPARTMENT_CONTACT_PROMPT,
      transitionBeforeAi: null,
      transitionAfterSend: null,
      transitionMetadata: null,
      aiMode: null,
      reason: 'department-contact-text-required',
    };
  }

  return {
    kind: 'static-reply',
    responseMessage: [
      'Novo contato recebido pelo atendimento virtual.',
      `Departamento: ${department.label}`,
      `Telefone do cliente: ${customerPhone}`,
      `Nome e motivo informado: ${messageText}`,
      'Por favor, retorne o contato',
    ].join('\n'),
    transitionBeforeAi: null,
    transitionAfterSend: 'return-to-main-menu',
    transitionMetadata: {
      targetDepartment: department.targetDepartment,
      departmentOption: option,
      reason: 'department-contact-forwarded',
      historyAvailableInPanel: true,
    },
    aiMode: null,
    reason: 'department-contact-forwarded',
    outboundPurpose: 'department-notification',
    outboundRecipientPhoneEnv: department.departmentPhoneEnv,
  };
}

function resolveQuoteMode(conversation: AutomationConversation): AiMode {
  const quoteMode = conversation.currentQuoteRequest?.structuredData?.quoteMode;
  const serviceType =
    conversation.currentQuoteRequest?.serviceType?.toLowerCase() ??
    (typeof quoteMode === 'string' ? quoteMode : '').toLowerCase();

  return serviceType.includes('cont') || serviceType.includes('continuous')
    ? 'continuous-pretriage'
    : 'eventual-quote';
}

function getProcessableMessageText(
  event: WhatsAppAutomationEnvelope,
): string | null {
  const message = event.payload.message;

  if (message.kind !== 'text') return null;

  const sanitized = (message.text ?? '')
    .trim()
    .replace(
      /\b\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[-\s]?\d{2}\b/g,
      '[DADO_PESSOAL_MASCARADO]',
    );

  return sanitized.length > 0 ? sanitized : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

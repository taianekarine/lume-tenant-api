import { forbidden, validationError } from '../../core/errors/app-error';
import type { Department } from '../access/access.constants';
import type {
  ConversationSnapshot,
  TransitionName,
} from './whatsapp.constants';

export interface ResolveTransitionInput {
  current: ConversationSnapshot;
  name: TransitionName;
  targetDepartment?: Department;
  departmentOption?: string;
  policy?: {
    /**
     * Política preservada para uma futura retomada. No MVP atual o valor
     * padrão é false, portanto uma proposta aprovada não bloqueia o
     * encerramento por si só.
     */
    preventCloseWithApprovedQuote?: boolean;
  };
}

export type TransitionActor = 'user' | 'webhook' | 'system';

const actorsByTransition: Readonly<
  Record<TransitionName, readonly TransitionActor[]>
> = {
  'present-main-menu': ['system'],
  'select-commercial': ['system'],
  'start-department-contact': ['system'],
  'start-quote': ['system'],
  'new-quote-request': ['system'],
  'present-quote-summary': ['system'],
  'correct-quote': ['system'],
  'confirm-quote': ['system'],
  'proposal-delivery-confirmed': ['system'],
  'proposal-response-received': ['webhook', 'system'],
  'return-to-main-menu': ['system'],
  'take-over': ['user'],
  'return-to-bot': ['user'],
  forward: ['user', 'system'],
  'mark-read': ['user'],
  close: ['user'],
  'close-after-rejection': ['user'],
  'resume-awaited-reply': ['webhook', 'system'],
  'resume-contextual-contact': ['webhook', 'system'],
  'reopen-after-customer-message': ['webhook'],
};

export function assertTransitionActor(
  name: TransitionName,
  actor: TransitionActor,
): void {
  if (!actorsByTransition[name].includes(actor)) {
    throw forbidden(`O ator ${actor} não pode executar a transição ${name}.`);
  }
}

function assertOpen(current: ConversationSnapshot): void {
  if (current.conversationState === 'closed') {
    throw validationError('Uma conversa encerrada não aceita esta transição.');
  }
}

function assertState(
  current: ConversationSnapshot,
  allowedStates: readonly ConversationSnapshot['conversationState'][],
  name: TransitionName,
): void {
  if (!allowedStates.includes(current.conversationState)) {
    throw validationError(
      `A transição ${name} não é permitida a partir de ${current.conversationState}.`,
    );
  }
}

const followUpRequestStatuses: readonly ConversationSnapshot['requestStatus'][] =
  ['waiting-for-customer', 'under-review', 'approved', 'rejected'];

function resolveBotFlowStep(
  current: ConversationSnapshot,
): ConversationSnapshot['flowStep'] {
  if (followUpRequestStatuses.includes(current.requestStatus)) {
    return 'commercial-follow-up-menu';
  }

  const candidate = current.resumeFlowStep ?? current.flowStep;
  if (!['quote-send-pending', 'human-service', 'closed'].includes(candidate)) {
    return candidate;
  }

  switch (current.requestStatus) {
    case 'collecting-information':
      return 'quote-data-collection';
    case 'waiting-for-customer':
      return 'quote-summary-confirmation';
    case 'not-started':
    case 'cancelled':
      return 'main-menu';
    case 'under-review':
    case 'approved':
    case 'rejected':
      return 'commercial-follow-up-menu';
  }
}

export function resolveConversationTransition(
  input: ResolveTransitionInput,
): ConversationSnapshot {
  const { current, name } = input;

  switch (name) {
    case 'present-main-menu':
      assertState(current, ['bot-active'], name);
      if (current.flowStep !== 'main-menu') {
        throw validationError('A apresentação inicial exige o menu principal.');
      }
      return { ...current, resumeState: null, resumeFlowStep: null };

    case 'select-commercial':
      assertState(current, ['bot-active'], name);
      if (current.flowStep !== 'main-menu') {
        throw validationError(
          'A seleção Comercial só é permitida no menu principal.',
        );
      }
      return {
        department: 'commercial',
        conversationState: 'bot-active',
        flowStep:
          current.requestStatus === 'not-started'
            ? 'commercial-menu'
            : 'commercial-follow-up-menu',
        requestStatus: current.requestStatus,
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'start-department-contact':
      assertState(current, ['bot-active'], name);
      if (current.flowStep !== 'main-menu') {
        throw validationError(
          'A seleção de departamento só é permitida no menu principal.',
        );
      }
      if (!input.targetDepartment) {
        throw validationError(
          'Informe o departamento de destino antes de coletar os dados.',
        );
      }
      if (!input.departmentOption || !/^[2-9]$/.test(input.departmentOption)) {
        throw validationError(
          'A opção de departamento deve estar entre 2 e 9.',
        );
      }
      return {
        ...current,
        department: input.targetDepartment,
        conversationState: 'bot-active',
        flowStep: 'main-menu',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'start-quote':
      assertState(current, ['bot-active'], name);
      if (
        current.flowStep !== 'commercial-menu' ||
        current.requestStatus !== 'not-started'
      ) {
        throw validationError(
          'A primeira coleta exige o menu comercial sem orçamento anterior.',
        );
      }
      return {
        department: 'commercial',
        conversationState: 'bot-active',
        flowStep: 'quote-data-collection',
        requestStatus: 'collecting-information',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'new-quote-request':
      assertState(current, ['bot-active'], name);
      if (
        current.flowStep !== 'commercial-follow-up-menu' ||
        ![
          'waiting-for-customer',
          'under-review',
          'approved',
          'rejected',
        ].includes(current.requestStatus)
      ) {
        throw validationError(
          'Uma nova solicitação exige o menu comercial de acompanhamento de um orçamento confirmado.',
        );
      }
      return {
        department: 'commercial',
        conversationState: 'bot-active',
        flowStep: 'quote-data-collection',
        requestStatus: 'collecting-information',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'present-quote-summary':
      assertState(current, ['bot-active'], name);
      if (
        current.flowStep !== 'quote-data-collection' ||
        current.requestStatus !== 'collecting-information'
      ) {
        throw validationError(
          'O resumo só pode ser apresentado após a coleta de dados.',
        );
      }
      return {
        ...current,
        conversationState: 'waiting-for-customer',
        flowStep: 'quote-summary-confirmation',
        requestStatus: 'waiting-for-customer',
        resumeState: 'bot-active',
        resumeFlowStep: 'quote-summary-confirmation',
      };

    case 'correct-quote':
      assertState(current, ['waiting-for-customer', 'bot-active'], name);
      if (
        current.flowStep !== 'quote-summary-confirmation' ||
        current.requestStatus !== 'waiting-for-customer'
      ) {
        throw validationError(
          'A correção exige um resumo de orçamento aguardando confirmação.',
        );
      }
      return {
        ...current,
        conversationState: 'bot-active',
        flowStep: 'quote-data-collection',
        requestStatus: 'collecting-information',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'confirm-quote':
      assertState(current, ['waiting-for-customer', 'bot-active'], name);
      if (
        current.flowStep !== 'quote-summary-confirmation' ||
        current.requestStatus !== 'waiting-for-customer'
      ) {
        throw validationError(
          'A confirmação exige um resumo de orçamento apresentado.',
        );
      }
      return {
        ...current,
        conversationState: 'bot-active',
        flowStep: 'commercial-follow-up-menu',
        requestStatus: 'under-review',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'proposal-delivery-confirmed':
      assertState(
        current,
        ['bot-active', 'sent-to-human', 'human-active'],
        name,
      );
      if (
        current.department !== 'commercial' ||
        current.flowStep !== 'quote-send-pending' ||
        current.requestStatus !== 'under-review'
      ) {
        throw validationError(
          'A confirmação de entrega exige uma proposta comercial em envio.',
        );
      }
      return {
        ...current,
        conversationState: 'waiting-for-customer',
        flowStep: 'quote-send-pending',
        requestStatus: 'waiting-for-customer',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'proposal-response-received':
      assertState(current, ['waiting-for-customer'], name);
      if (
        current.department !== 'commercial' ||
        current.flowStep !== 'quote-send-pending' ||
        current.requestStatus !== 'waiting-for-customer'
      ) {
        throw validationError(
          'A resposta exige uma proposta entregue e aguardando o cliente.',
        );
      }
      return {
        ...current,
        conversationState: 'sent-to-human',
        flowStep: 'human-service',
        requestStatus: 'waiting-for-customer',
        resumeState: null,
        resumeFlowStep: 'commercial-follow-up-menu',
      };

    case 'return-to-main-menu':
      assertState(current, ['bot-active'], name);
      return {
        ...current,
        conversationState: 'bot-active',
        flowStep: 'main-menu',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'take-over':
      assertOpen(current);
      return {
        ...current,
        conversationState: 'human-active',
        flowStep: 'human-service',
        resumeState: null,
        resumeFlowStep: resolveBotFlowStep(current),
      };

    case 'return-to-bot':
      assertState(current, ['human-active'], name);
      return {
        ...current,
        conversationState: 'bot-active',
        flowStep: resolveBotFlowStep(current),
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'forward':
      assertOpen(current);
      if (!input.targetDepartment) {
        throw validationError(
          'Informe o departamento de destino do encaminhamento.',
        );
      }
      return {
        ...current,
        department: input.targetDepartment,
        conversationState: 'sent-to-human',
        flowStep: 'human-service',
        resumeState: null,
        resumeFlowStep: resolveBotFlowStep(current),
      };

    case 'mark-read':
      assertOpen(current);
      return { ...current };

    case 'close':
      assertOpen(current);
      if (
        input.policy?.preventCloseWithApprovedQuote === true &&
        current.requestStatus === 'approved'
      ) {
        throw validationError(
          'Um atendimento com proposta aprovada não pode ser encerrado.',
        );
      }
      return {
        ...current,
        conversationState: 'closed',
        flowStep: 'closed',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'close-after-rejection':
      assertOpen(current);
      if (current.requestStatus !== 'rejected') {
        throw validationError(
          'O atendimento só pode ser encerrado depois que a proposta for recusada.',
        );
      }
      return {
        ...current,
        conversationState: 'closed',
        flowStep: 'closed',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'reopen-after-customer-message':
      assertState(current, ['closed'], name);
      if (current.flowStep !== 'closed') {
        throw validationError(
          'A reabertura exige uma conversa previamente encerrada.',
        );
      }
      return {
        ...current,
        department: 'commercial',
        conversationState: 'bot-active',
        flowStep: 'main-menu',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'resume-awaited-reply':
      assertState(current, ['waiting-for-customer'], name);
      if (
        current.flowStep !== 'quote-summary-confirmation' ||
        current.requestStatus !== 'waiting-for-customer' ||
        current.resumeState !== 'bot-active'
      ) {
        throw validationError(
          'A retomada da resposta exige um resumo aguardando o cliente.',
        );
      }
      return {
        ...current,
        conversationState: 'bot-active',
        resumeState: null,
        resumeFlowStep: null,
      };

    case 'resume-contextual-contact':
      assertState(current, ['sent-to-human', 'bot-active'], name);
      if (
        !(
          (current.conversationState === 'sent-to-human' &&
            current.flowStep === 'quote-send-pending') ||
          (current.conversationState === 'bot-active' &&
            ['quote-send-pending', 'commercial-follow-up-menu'].includes(
              current.flowStep,
            ))
        ) ||
        !followUpRequestStatuses.includes(current.requestStatus)
      ) {
        throw validationError(
          'Não existe orçamento confirmado em acompanhamento para retomar.',
        );
      }
      return {
        ...current,
        department: 'commercial',
        conversationState: 'bot-active',
        flowStep: 'commercial-follow-up-menu',
        resumeState: null,
        resumeFlowStep: null,
      };
  }
}

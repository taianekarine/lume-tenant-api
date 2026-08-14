import { describe, expect, it } from 'vitest';

import {
  assertTransitionActor,
  resolveConversationTransition,
  type ResolveTransitionInput,
} from './conversation-transition.matrix';
import {
  ACTIVE_QUOTE_REQUEST_STATUSES,
  type ConversationSnapshot,
} from './whatsapp.constants';

const initial: ConversationSnapshot = {
  department: 'commercial',
  conversationState: 'bot-active',
  flowStep: 'main-menu',
  requestStatus: 'not-started',
  resumeState: null,
  resumeFlowStep: null,
};

function transition(
  current: ConversationSnapshot,
  name: ResolveTransitionInput['name'],
): ConversationSnapshot {
  return resolveConversationTransition({ current, name });
}

describe('matriz MVP de conversas WhatsApp', () => {
  it('percorre seleção, coleta, resumo, correção e confirmação', () => {
    const commercial = transition(initial, 'select-commercial');
    const collecting = transition(commercial, 'start-quote');
    const waiting = transition(collecting, 'present-quote-summary');
    const corrected = transition(waiting, 'correct-quote');
    const confirmed = transition(
      transition(corrected, 'present-quote-summary'),
      'confirm-quote',
    );

    expect(commercial.flowStep).toBe('commercial-menu');
    expect(collecting).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'quote-data-collection',
      requestStatus: 'collecting-information',
    });
    expect(waiting).toMatchObject({
      conversationState: 'waiting-for-customer',
      flowStep: 'quote-summary-confirmation',
      requestStatus: 'waiting-for-customer',
      resumeState: 'bot-active',
    });
    expect(corrected).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'quote-data-collection',
      requestStatus: 'collecting-information',
    });
    expect(confirmed).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
    });
    expect(confirmed.conversationState).not.toBe('closed');
  });

  it('retoma uma solicitação em acompanhamento no menu explícito', () => {
    expect(
      transition(
        {
          ...initial,
          conversationState: 'sent-to-human',
          flowStep: 'quote-send-pending',
          requestStatus: 'under-review',
        },
        'resume-contextual-contact',
      ),
    ).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
    });
  });

  it('retoma a resposta do resumo sem convertê-la em novo contato', () => {
    const resumed = transition(
      {
        ...initial,
        conversationState: 'waiting-for-customer',
        flowStep: 'quote-summary-confirmation',
        requestStatus: 'waiting-for-customer',
        resumeState: 'bot-active',
      },
      'resume-awaited-reply',
    );

    expect(resumed).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'quote-summary-confirmation',
      requestStatus: 'waiting-for-customer',
      resumeState: null,
    });
    expect(transition(resumed, 'confirm-quote')).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
    });
  });

  it('aguarda o cliente somente após a entrega da proposta e encaminha a resposta ao atendente', () => {
    const delivered = transition(
      {
        ...initial,
        conversationState: 'bot-active',
        flowStep: 'quote-send-pending',
        requestStatus: 'under-review',
      },
      'proposal-delivery-confirmed',
    );
    const responded = transition(delivered, 'proposal-response-received');

    expect(delivered).toMatchObject({
      conversationState: 'waiting-for-customer',
      flowStep: 'quote-send-pending',
      requestStatus: 'waiting-for-customer',
    });
    expect(responded).toMatchObject({
      conversationState: 'sent-to-human',
      flowStep: 'human-service',
      requestStatus: 'waiting-for-customer',
      resumeFlowStep: 'commercial-follow-up-menu',
    });
    expect(transition(responded, 'take-over')).toMatchObject({
      conversationState: 'human-active',
      flowStep: 'human-service',
    });
  });

  it('volta ao menu principal preservando o acompanhamento', () => {
    const main = transition(
      {
        ...initial,
        flowStep: 'commercial-follow-up-menu',
        requestStatus: 'under-review',
      },
      'return-to-main-menu',
    );
    expect(main).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'main-menu',
      requestStatus: 'under-review',
    });
    expect(transition(main, 'select-commercial')).toMatchObject({
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
    });
  });

  it('bloqueia transições automáticas incompatíveis com o estado atual', () => {
    expect(() => transition(initial, 'confirm-quote')).toThrow(
      'resumo de orçamento',
    );
    expect(() => transition(initial, 'new-quote-request')).toThrow(
      'menu comercial de acompanhamento',
    );
  });

  it('registra a coleta de dados antes do encaminhamento de um departamento', () => {
    const collectingDepartment = resolveConversationTransition({
      current: initial,
      name: 'start-department-contact',
      targetDepartment: 'maintenance',
      departmentOption: '7',
    });

    expect(collectingDepartment).toMatchObject({
      department: 'maintenance',
      conversationState: 'bot-active',
      flowStep: 'main-menu',
    });
    expect(() =>
      resolveConversationTransition({
        current: initial,
        name: 'start-department-contact',
        targetDepartment: 'maintenance',
        departmentOption: '1',
      }),
    ).toThrow('opção de departamento');
    expect(() =>
      resolveConversationTransition({
        current: initial,
        name: 'start-department-contact',
        departmentOption: '7',
      }),
    ).toThrow('departamento de destino');
  });

  it('permite coletar o contato da Diretoria a partir do menu Comercial', () => {
    const commercialMenu: ConversationSnapshot = {
      ...initial,
      department: 'commercial',
      flowStep: 'commercial-menu',
    };

    expect(
      resolveConversationTransition({
        current: commercialMenu,
        name: 'start-department-contact',
        targetDepartment: 'management',
        departmentOption: 'commercial-continuous-director',
      }),
    ).toMatchObject({
      department: 'management',
      conversationState: 'bot-active',
      flowStep: 'main-menu',
    });
  });

  it('aplica ações humanas e encaminhamento sem inventar destinos', () => {
    const taken = transition(initial, 'take-over');
    const returned = transition(taken, 'return-to-bot');
    const forwarded = resolveConversationTransition({
      current: returned,
      name: 'forward',
      targetDepartment: 'operations',
    });
    const read = transition(forwarded, 'mark-read');

    expect(taken).toMatchObject({
      conversationState: 'human-active',
      flowStep: 'human-service',
    });
    expect(returned).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'main-menu',
    });
    expect(forwarded).toMatchObject({
      department: 'operations',
      conversationState: 'sent-to-human',
    });
    expect(read).toEqual(forwarded);
    expect(() =>
      resolveConversationTransition({
        current: initial,
        name: 'forward',
      }),
    ).toThrow('departamento de destino');
  });

  it('preserva o retorno pós-orçamento em intervenções humanas repetidas', () => {
    const confirmed: ConversationSnapshot = {
      ...initial,
      conversationState: 'bot-active',
      flowStep: 'quote-send-pending',
      requestStatus: 'under-review',
    };
    const taken = transition(confirmed, 'take-over');
    const forwarded = resolveConversationTransition({
      current: taken,
      name: 'forward',
      targetDepartment: 'commercial',
    });
    const takenAgain = transition(forwarded, 'take-over');
    const returned = transition(takenAgain, 'return-to-bot');

    expect(taken.resumeFlowStep).toBe('commercial-follow-up-menu');
    expect(forwarded.resumeFlowStep).toBe('commercial-follow-up-menu');
    expect(takenAgain.resumeFlowStep).toBe('commercial-follow-up-menu');
    expect(returned).toMatchObject({
      department: 'commercial',
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
      resumeFlowStep: null,
    });
  });

  it('normaliza um retorno legado que apontava para atendimento humano', () => {
    expect(
      transition(
        {
          ...initial,
          conversationState: 'human-active',
          flowStep: 'human-service',
          requestStatus: 'under-review',
          resumeFlowStep: 'human-service',
        },
        'return-to-bot',
      ),
    ).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
      resumeFlowStep: null,
    });
  });

  it('aceita sinalizar o primeiro inbound após devolução manual', () => {
    expect(
      transition(
        {
          ...initial,
          flowStep: 'commercial-follow-up-menu',
          requestStatus: 'under-review',
        },
        'resume-contextual-contact',
      ),
    ).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
    });
  });

  it('não reutiliza start-quote no acompanhamento e exige new-quote-request', () => {
    const followUp: ConversationSnapshot = {
      ...initial,
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
    };
    expect(() => transition(followUp, 'start-quote')).toThrow(
      'primeira coleta',
    );
    expect(transition(followUp, 'new-quote-request')).toMatchObject({
      flowStep: 'quote-data-collection',
      requestStatus: 'collecting-information',
    });
    expect(
      transition(
        { ...followUp, requestStatus: 'waiting-for-customer' },
        'new-quote-request',
      ),
    ).toMatchObject({
      flowStep: 'quote-data-collection',
      requestStatus: 'collecting-information',
    });
  });

  it('retorna ao passo anterior após intervenção humana', () => {
    const collecting: ConversationSnapshot = {
      ...initial,
      flowStep: 'quote-data-collection',
      requestStatus: 'collecting-information',
    };
    const returned = transition(
      transition(collecting, 'take-over'),
      'return-to-bot',
    );
    expect(returned.flowStep).toBe('quote-data-collection');
  });

  it('não permite mutar conversa encerrada', () => {
    expect(() =>
      transition(
        {
          ...initial,
          conversationState: 'closed',
          flowStep: 'closed',
        },
        'take-over',
      ),
    ).toThrow('encerrada');
  });

  it('encerra somente atendimentos cuja proposta foi recusada', () => {
    expect(
      transition(
        {
          ...initial,
          conversationState: 'human-active',
          flowStep: 'human-service',
          requestStatus: 'rejected',
        },
        'close-after-rejection',
      ),
    ).toMatchObject({
      conversationState: 'closed',
      flowStep: 'closed',
      requestStatus: 'rejected',
      resumeState: null,
      resumeFlowStep: null,
    });

    expect(() =>
      transition(
        {
          ...initial,
          conversationState: 'human-active',
          flowStep: 'human-service',
          requestStatus: 'under-review',
        },
        'close-after-rejection',
      ),
    ).toThrow('proposta for recusada');
  });

  it('mantém disponível, mas desabilitada por padrão, a regra de bloqueio por proposta aprovada', () => {
    expect(
      transition(
        {
          ...initial,
          conversationState: 'human-active',
          flowStep: 'human-service',
          requestStatus: 'approved',
        },
        'close',
      ),
    ).toMatchObject({
      conversationState: 'closed',
      flowStep: 'closed',
      requestStatus: 'approved',
    });

    expect(() =>
      resolveConversationTransition({
        current: {
          ...initial,
          conversationState: 'human-active',
          flowStep: 'human-service',
          requestStatus: 'approved',
        },
        name: 'close',
        policy: { preventCloseWithApprovedQuote: true },
      }),
    ).toThrow('proposta aprovada');
    expect(ACTIVE_QUOTE_REQUEST_STATUSES).toEqual([
      'collecting-information',
      'waiting-for-customer',
      'under-review',
      'approved',
    ]);
  });

  it('exige atendimento humano ativo para devolver a conversa ao bot', () => {
    expect(() =>
      transition(
        {
          ...initial,
          department: 'commercial',
          conversationState: 'sent-to-human',
          flowStep: 'human-service',
          requestStatus: 'approved',
          resumeFlowStep: 'commercial-follow-up-menu',
        },
        'return-to-bot',
      ),
    ).toThrow('sent-to-human');

    expect(() =>
      transition(
        {
          ...initial,
          department: 'commercial',
          conversationState: 'waiting-for-customer',
          flowStep: 'quote-send-pending',
          requestStatus: 'approved',
        },
        'return-to-bot',
      ),
    ).toThrow('waiting-for-customer');
  });

  it('reabre uma conversa encerrada no mesmo histórico e volta ao menu inicial', () => {
    expect(
      transition(
        {
          ...initial,
          conversationState: 'closed',
          flowStep: 'closed',
          requestStatus: 'under-review',
        },
        'reopen-after-customer-message',
      ),
    ).toMatchObject({
      department: 'commercial',
      conversationState: 'bot-active',
      flowStep: 'main-menu',
      requestStatus: 'under-review',
    });
  });

  it('separa transições internas reservadas das ações humanas', () => {
    expect(() => assertTransitionActor('take-over', 'system')).toThrow(
      'ator system',
    );
    expect(() => assertTransitionActor('confirm-quote', 'user')).toThrow(
      'ator user',
    );
    expect(() =>
      assertTransitionActor('start-department-contact', 'user'),
    ).toThrow('ator user');
    expect(() =>
      assertTransitionActor('start-department-contact', 'system'),
    ).not.toThrow();
    expect(() =>
      assertTransitionActor('resume-contextual-contact', 'user'),
    ).toThrow('ator user');
    expect(() =>
      assertTransitionActor('proposal-response-received', 'user'),
    ).toThrow('ator user');
    expect(() => assertTransitionActor('take-over', 'user')).not.toThrow();
    expect(() =>
      assertTransitionActor('present-main-menu', 'system'),
    ).not.toThrow();
    expect(() => assertTransitionActor('start-quote', 'system')).not.toThrow();
    expect(() => assertTransitionActor('forward', 'system')).not.toThrow();
    expect(() =>
      assertTransitionActor('resume-contextual-contact', 'webhook'),
    ).not.toThrow();
    expect(() =>
      assertTransitionActor('proposal-delivery-confirmed', 'system'),
    ).not.toThrow();
    expect(() =>
      assertTransitionActor('proposal-response-received', 'webhook'),
    ).not.toThrow();
    expect(() =>
      assertTransitionActor('close-after-rejection', 'user'),
    ).not.toThrow();
    expect(() => assertTransitionActor('close', 'user')).not.toThrow();
    expect(() =>
      assertTransitionActor('reopen-after-customer-message', 'webhook'),
    ).not.toThrow();
    expect(() => assertTransitionActor('close', 'system')).toThrow(
      'ator system',
    );
    expect(() =>
      assertTransitionActor('close-after-rejection', 'system'),
    ).toThrow('ator system');
  });
});

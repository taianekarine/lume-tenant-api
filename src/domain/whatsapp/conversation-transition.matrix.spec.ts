import { describe, expect, it } from 'vitest';

import {
  assertTransitionActor,
  resolveConversationTransition,
  type ResolveTransitionInput,
} from './conversation-transition.matrix';
import type { ConversationSnapshot } from './whatsapp.constants';

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
      conversationState: 'sent-to-human',
      flowStep: 'quote-send-pending',
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
      conversationState: 'sent-to-human',
      flowStep: 'quote-send-pending',
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

  it('separa transições internas reservadas das ações humanas', () => {
    expect(() => assertTransitionActor('take-over', 'n8n')).toThrow('ator n8n');
    expect(() => assertTransitionActor('confirm-quote', 'user')).toThrow(
      'ator user',
    );
    expect(() =>
      assertTransitionActor('resume-contextual-contact', 'n8n'),
    ).toThrow('ator n8n');
    expect(() => assertTransitionActor('take-over', 'user')).not.toThrow();
    expect(() =>
      assertTransitionActor('resume-contextual-contact', 'webhook'),
    ).not.toThrow();
  });
});

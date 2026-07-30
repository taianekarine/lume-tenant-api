import { describe, expect, it } from 'vitest';

import {
  buildConversationClosureMessage,
  getConversationClosureGreeting,
} from './conversation-closure-message';

describe('conversation closure message', () => {
  it.each([
    ['2026-07-30T11:00:00.000Z', 'um ótimo dia!'],
    ['2026-07-30T17:00:00.000Z', 'uma ótima tarde!'],
    ['2026-07-31T00:00:00.000Z', 'uma ótima noite!'],
  ])('uses the São Paulo period for %s', (value, expected) => {
    expect(getConversationClosureGreeting(new Date(value))).toBe(expected);
  });

  it('builds the complete customer farewell', () => {
    expect(
      buildConversationClosureMessage(new Date('2026-07-30T17:00:00.000Z')),
    ).toBe(
      'Foi um prazer te atender! Qualquer outra dúvida ou nova demanda, é só me chamar por aqui. Conte sempre conosco e tenha uma ótima tarde! 😊',
    );
  });
});

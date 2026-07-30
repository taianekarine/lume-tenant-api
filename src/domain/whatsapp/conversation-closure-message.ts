const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

export function getConversationClosureGreeting(
  sentAt: Date,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(sentAt),
  );

  if (hour < 12) return 'um ótimo dia!';
  if (hour < 18) return 'uma ótima tarde!';
  return 'uma ótima noite!';
}

export function buildConversationClosureMessage(
  sentAt: Date,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  return `Foi um prazer te atender! Qualquer outra dúvida ou nova demanda, é só me chamar por aqui. Conte sempre conosco e tenha ${getConversationClosureGreeting(sentAt, timeZone)} 😊`;
}

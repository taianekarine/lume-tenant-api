export type WhatsAppAutomationProviderName = 'api';

export type WhatsAppAutomationTopic =
  | 'whatsapp.inbound.persisted'
  | 'whatsapp.inbound.human-notification'
  | 'whatsapp.outbound.requested';

export interface ClaimedWhatsAppAutomationEvent {
  readonly id: string;
  readonly companyId: string;
  readonly topic: WhatsAppAutomationTopic;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly executionId: string;
  readonly correlationId: string;
  readonly createdAt: Date;
  readonly payload: unknown;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export interface WhatsAppAutomationEnvelope {
  readonly schemaVersion: '1.0';
  readonly id: string;
  readonly companyId: string;
  readonly topic: WhatsAppAutomationTopic;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly aggregateSequence: number;
  readonly executionId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly payload: unknown;
}

export function buildWhatsAppAutomationEnvelope(
  event: ClaimedWhatsAppAutomationEvent,
): WhatsAppAutomationEnvelope {
  return {
    schemaVersion: '1.0',
    id: event.id,
    companyId: event.companyId,
    topic: event.topic,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateSequence: event.aggregateSequence,
    executionId: event.executionId,
    correlationId: event.correlationId,
    occurredAt: event.createdAt.toISOString(),
    payload: event.payload,
  };
}

/**
 * A automacao roda dentro da API. O aceite duravel sempre acontece antes de
 * qualquer efeito externo, preservando idempotencia e recuperacao do lease.
 */
export abstract class WhatsAppAutomationProvider {
  abstract readonly name: WhatsAppAutomationProviderName;
  abstract readonly acknowledgement: 'before-execution';

  abstract execute(event: ClaimedWhatsAppAutomationEvent): Promise<void>;
}

export class WhatsAppAutomationExecutionError extends Error {
  constructor(
    readonly outcome: 'retryable-failure' | 'terminal-failure',
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = 'WhatsAppAutomationExecutionError';
  }
}

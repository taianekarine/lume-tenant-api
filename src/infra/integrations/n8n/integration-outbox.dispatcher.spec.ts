import { describe, expect, it } from 'vitest';

import { buildN8nEnvelope } from './integration-outbox.dispatcher';

describe('buildN8nEnvelope', () => {
  it('publica o envelope versionado consumido pelo perfil tenant-api-mvp', () => {
    const envelope = buildN8nEnvelope({
      id: '00000000-0000-4000-8000-000000000001',
      companyId: '00000000-0000-4000-8000-000000000002',
      topic: 'whatsapp.inbound.persisted',
      aggregateType: 'whatsapp-conversation',
      aggregateId: '00000000-0000-4000-8000-000000000003',
      aggregateSequence: 1,
      executionId: '00000000-0000-4000-8000-000000000004',
      correlationId: 'evolution:abc',
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
      payload: {
        automationAllowed: true,
        canGenerateReply: true,
        canSendReply: true,
        isFirstContact: true,
      },
    });

    expect(envelope).toEqual({
      schemaVersion: '1.0',
      id: '00000000-0000-4000-8000-000000000001',
      companyId: '00000000-0000-4000-8000-000000000002',
      topic: 'whatsapp.inbound.persisted',
      aggregateType: 'whatsapp-conversation',
      aggregateId: '00000000-0000-4000-8000-000000000003',
      aggregateSequence: 1,
      executionId: '00000000-0000-4000-8000-000000000004',
      correlationId: 'evolution:abc',
      occurredAt: '2026-07-26T00:00:00.000Z',
      payload: {
        automationAllowed: true,
        canGenerateReply: true,
        canSendReply: true,
        isFirstContact: true,
      },
    });
  });
});

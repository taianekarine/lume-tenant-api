import { describe, expect, it } from 'vitest';

import { REQUIRED_PERMISSIONS } from '../../shared/http/decorators/require-permissions.decorator';
import { WhatsAppContactsController } from './whatsapp-contacts.controller';

describe('WhatsAppContactsController permissions', () => {
  it('permite consulta e restringe alterações ao gerenciamento do WhatsApp', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSIONS, WhatsAppContactsController),
    ).toEqual(['whatsapp-conversations:view', 'whatsapp-conversations:manage']);
    for (const method of ['create', 'update', 'delete', 'importCsv'] as const) {
      const handler = Object.getOwnPropertyDescriptor(
        WhatsAppContactsController.prototype,
        method,
      )?.value as unknown;
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual([
        'whatsapp-conversations:manage',
      ]);
    }
  });
});

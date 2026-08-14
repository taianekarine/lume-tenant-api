import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import type { QueryWhatsAppUseCase } from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { ConversationListQueryDto } from './dto/whatsapp.dto';
import { WhatsAppPanelController } from './whatsapp-panel.controller';

function principal(
  overrides: Partial<AuthenticatedPrincipal> = {},
): AuthenticatedPrincipal {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    companyId: '00000000-0000-4000-8000-000000000002',
    name: 'Motorista',
    username: 'motorista',
    email: 'motorista@example.com',
    cpf: null,
    type: 'employee',
    departments: ['operations'],
    permissions: ['dashboard:view', 'drivers:view', 'operations:view'],
    clientCategory: null,
    isActive: true,
    mustChangePassword: false,
    hasProfilePicture: false,
    createdAt: '2026-07-28T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z',
    tokenVersion: 1,
    ...overrides,
  };
}

function setup() {
  const listConversations = vi.fn();
  const queryUseCase = { listConversations };
  const createHumanOutbound = { execute: vi.fn() };
  const mediaStorage = {
    read: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    write: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new WhatsAppPanelController(
    queryUseCase as unknown as QueryWhatsAppUseCase,
    {} as never,
    createHumanOutbound as never,
    {} as never,
    mediaStorage,
    new ConfigService({
      WHATSAPP_ALLOWED_MIME_TYPES:
        'image/jpeg,image/png,image/webp,application/pdf,text/vcard,text/x-vcard',
      WHATSAPP_MAX_ATTACHMENT_BYTES: 67_108_864,
    }),
  );

  return {
    controller,
    listConversations,
    createHumanOutbound,
    mediaStorage,
  };
}

describe('WhatsAppPanelController dashboard indicators', () => {
  it('forces the authenticated user department when none is informed', () => {
    const { controller, listConversations } = setup();
    const result = { data: [], meta: { page: 1, pageSize: 20, total: 0 } };
    listConversations.mockReturnValue(result);

    expect(
      controller.dashboard(principal(), new ConversationListQueryDto()),
    ).toBe(result);
    expect(listConversations).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000002',
      expect.objectContaining({ department: 'operations' }),
    );
  });

  it('accepts an explicitly selected department assigned to the user', () => {
    const { controller, listConversations } = setup();
    const query = new ConversationListQueryDto();
    query.department = 'operations';

    void controller.dashboard(principal(), query);

    expect(listConversations).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000002',
      query,
    );
  });

  it('rejects access to a department not assigned to the user', () => {
    const { controller, listConversations } = setup();
    const query = new ConversationListQueryDto();
    query.department = 'financial';

    expect(() => controller.dashboard(principal(), query)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('requires an explicit department when the user has multiple assignments', () => {
    const { controller, listConversations } = setup();

    expect(() =>
      controller.dashboard(
        principal({ departments: ['operations', 'monitoring'] }),
        new ConversationListQueryDto(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('allows an administrator without department assignment to read tenant totals', () => {
    const { controller, listConversations } = setup();
    const query = new ConversationListQueryDto();

    void controller.dashboard(
      principal({
        departments: [],
        permissions: ['dashboard:view', 'whatsapp-conversations:manage'],
      }),
      query,
    );

    expect(listConversations).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000002',
      query,
    );
  });

  it('rejects a department-less profile without WhatsApp management access', () => {
    const { controller, listConversations } = setup();

    expect(() =>
      controller.dashboard(
        principal({ departments: [], permissions: ['dashboard:view'] }),
        new ConversationListQueryDto(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(listConversations).not.toHaveBeenCalled();
  });
});

describe('WhatsAppPanelController media messages', () => {
  it('stores and creates a human image message with its caption', async () => {
    const { controller, createHumanOutbound, mediaStorage } = setup();
    createHumanOutbound.execute.mockResolvedValue({
      message: { id: 'message' },
    });
    const body = {
      commandId: '00000000-0000-4000-8000-000000000010',
      idempotencyKey: '00000000-0000-4000-8000-000000000011',
      expectedVersion: 4,
      caption: 'Comprovante solicitado',
    };
    const file = {
      originalname: '../foto.jpg',
      mimetype: 'image/jpeg',
      size: 6,
      buffer: Buffer.from('imagem'),
    };

    await controller.createMediaMessage(
      principal({ permissions: ['whatsapp-conversations:manage'] }),
      '00000000-0000-4000-8000-000000000003',
      body,
      file,
    );

    expect(mediaStorage.write).toHaveBeenCalledWith(
      expect.objectContaining({ content: file.buffer }),
    );
    expect(createHumanOutbound.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Comprovante solicitado',
        attachment: expect.objectContaining({
          kind: 'image',
          fileName: 'foto.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 6,
        }),
      }),
    );
  });

  it('removes the stored file when message persistence fails', async () => {
    const { controller, createHumanOutbound, mediaStorage } = setup();
    createHumanOutbound.execute.mockRejectedValue(
      new Error('persistence failed'),
    );

    await expect(
      controller.createMediaMessage(
        principal({ permissions: ['whatsapp-conversations:manage'] }),
        '00000000-0000-4000-8000-000000000003',
        {
          commandId: '00000000-0000-4000-8000-000000000010',
          idempotencyKey: '00000000-0000-4000-8000-000000000011',
          expectedVersion: 4,
        },
        {
          originalname: 'contato.vcf',
          mimetype: 'text/vcard',
          size: 4,
          buffer: Buffer.from('card'),
        },
      ),
    ).rejects.toThrow('persistence failed');
    expect(mediaStorage.delete).toHaveBeenCalledWith(
      expect.stringContaining('/00000000-0000-4000-8000-000000000003/'),
    );
  });

  it('persists a WebP selected explicitly as a sticker', async () => {
    const { controller, createHumanOutbound } = setup();
    createHumanOutbound.execute.mockResolvedValue({
      message: { id: 'sticker' },
    });

    await controller.createMediaMessage(
      principal({ permissions: ['whatsapp-conversations:manage'] }),
      '00000000-0000-4000-8000-000000000003',
      {
        commandId: '00000000-0000-4000-8000-000000000010',
        idempotencyKey: '00000000-0000-4000-8000-000000000011',
        expectedVersion: 4,
        mediaKind: 'sticker',
      },
      {
        originalname: 'figurinha.webp',
        mimetype: 'image/webp',
        size: 4,
        buffer: Buffer.from('webp'),
      },
    );

    expect(createHumanOutbound.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: expect.objectContaining({
          kind: 'sticker',
          mimeType: 'image/webp',
        }),
      }),
    );
  });
});

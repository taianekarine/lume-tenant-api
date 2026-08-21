import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WhatsAppMediaStorage } from '../../../application/contracts/whatsapp-media.storage';
import {
  MessageDirection,
  MessageKind,
} from '../../database/prisma/generated/client';
import type { PrismaService } from '../../database/prisma/prisma.service';
import { EvolutionMediaContentService } from './evolution-media-content.service';

const companyId = '00000000-0000-4000-8000-000000000001';
const conversationId = '00000000-0000-4000-8000-000000000101';
const messageId = '00000000-0000-4000-8000-000000000501';

function config(
  overrides: Readonly<Record<string, unknown>> = {},
): ConfigService {
  const values: Readonly<Record<string, unknown>> = {
    EVOLUTION_BASE_URL: 'https://evolution.example.test',
    EVOLUTION_INSTANCE_NAME: 'milenium',
    EVOLUTION_API_KEY: 'evolution-api-key',
    EVOLUTION_MEDIA_CONTENT_TIMEOUT_MS: 30_000,
    WHATSAPP_MAX_ATTACHMENT_BYTES: 10_485_760,
    WHATSAPP_ALLOWED_MIME_TYPES:
      'image/jpeg,image/webp,application/pdf,audio/ogg,audio/mp4,video/mp4',
    ...overrides,
  };
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function prismaWithMessage(message: unknown): PrismaService {
  return {
    whatsAppMessage: {
      findUnique: vi.fn().mockResolvedValue(message),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaService;
}

function mediaStorage(): WhatsAppMediaStorage {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    read: vi.fn().mockRejectedValue(new Error('not stored')),
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('EvolutionMediaContentService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('recupera áudio recebido em formato compatível com o navegador', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          mediaType: 'audioMessage',
          fileName: 'audio.ogg',
          mimetype: 'audio/mp4',
          base64: Buffer.from('audio-content').toString('base64'),
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        providerMessageId: 'provider-audio-1',
        direction: MessageDirection.INBOUND,
        kind: MessageKind.AUDIO,
        media: { mimeType: 'audio/ogg', fileName: 'audio.ogg' },
        proposalDocument: null,
      }),
      mediaStorage(),
      config(),
    );

    const result = await service.getContent(
      companyId,
      conversationId,
      messageId,
    );

    expect(result).toMatchObject({
      fileName: 'audio.m4a',
      mimeType: 'audio/mp4',
      kind: 'audio',
    });
    expect(result.content.toString()).toBe('audio-content');
    expect(fetcher).toHaveBeenCalledWith(
      'https://evolution.example.test/chat/getBase64FromMediaMessage/milenium',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ apikey: 'evolution-api-key' }),
        body: JSON.stringify({
          message: { key: { id: 'provider-audio-1' } },
          convertToMp4: true,
        }),
      }),
    );
  });

  it('normaliza o nome de um PDF recebido', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            fileName: 'documento.pdf.enc',
            mimetype: 'application/pdf',
            base64: Buffer.from('%PDF-content').toString('base64'),
          }),
          { status: 201 },
        ),
      ),
    );
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        providerMessageId: 'provider-document-1',
        direction: MessageDirection.INBOUND,
        kind: MessageKind.DOCUMENT,
        media: { mimeType: 'application/pdf', fileName: 'documento.pdf.enc' },
        proposalDocument: null,
      }),
      mediaStorage(),
      config(),
    );

    await expect(
      service.getContent(companyId, conversationId, messageId),
    ).resolves.toMatchObject({
      fileName: 'documento.pdf',
      mimeType: 'application/pdf',
      kind: 'document',
    });
  });

  it('serve um PDF de proposta salvo no banco sem buscar conteúdo externo', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const content = Buffer.from('%PDF-local-content');
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        providerMessageId: 'provider-pdf-1',
        direction: MessageDirection.OUTBOUND,
        kind: MessageKind.DOCUMENT,
        media: null,
        proposalDocument: {
          content,
          fileName: 'orcamento-final.pdf',
          mimeType: 'application/pdf',
          sizeBytes: content.byteLength,
        },
      }),
      mediaStorage(),
      config(),
    );

    const result = await service.getContent(
      companyId,
      conversationId,
      messageId,
    );

    expect(result.content).toEqual(content);
    expect(result).toMatchObject({
      fileName: 'orcamento-final.pdf',
      mimeType: 'application/pdf',
      kind: 'document',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serves a stored panel archive above the inbound retention limit', async () => {
    const content = Buffer.from('archive');
    const storage = {
      ...mediaStorage(),
      read: vi.fn().mockResolvedValue(content),
    } as WhatsAppMediaStorage;
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        companyId,
        conversationId,
        providerMessageId: null,
        direction: MessageDirection.OUTBOUND,
        kind: MessageKind.DOCUMENT,
        media: { mimeType: 'application/zip', fileName: 'historico.zip' },
        mediaStorageKey: `v1/${companyId}/${conversationId}/${messageId}/${createHash('sha256').update(content).digest('hex')}`,
        mediaMimeType: 'application/zip',
        mediaSizeBytes: content.byteLength,
        mediaOriginalName: 'historico.zip',
        mediaSha256: createHash('sha256').update(content).digest('hex'),
        mediaStoredAt: new Date('2026-08-14T12:00:00.000Z'),
        proposalDocument: null,
      }),
      storage,
      config({
        WHATSAPP_MAX_ATTACHMENT_BYTES: 4,
        WHATSAPP_PANEL_MAX_ATTACHMENT_BYTES: 16,
      }),
    );

    await expect(
      service.getContent(companyId, conversationId, messageId),
    ).resolves.toMatchObject({
      content,
      fileName: 'historico.zip',
      mimeType: 'application/zip',
      kind: 'document',
    });
  });

  it('rejeita mídia fora da lista de tipos permitidos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            fileName: 'payload.bin',
            mimetype: 'application/x-msdownload',
            base64: Buffer.from('unsafe').toString('base64'),
          }),
          { status: 201 },
        ),
      ),
    );
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        providerMessageId: 'provider-document-2',
        direction: MessageDirection.INBOUND,
        kind: MessageKind.DOCUMENT,
        media: null,
        proposalDocument: null,
      }),
      mediaStorage(),
      config(),
    );

    await expect(
      service.getContent(companyId, conversationId, messageId),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('serve primeiro a cópia durável sem consultar a Evolution', async () => {
    const content = Buffer.from('persisted-image');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const readStoredContent = vi.fn().mockResolvedValue(content);
    const storage = {
      ...mediaStorage(),
      read: readStoredContent,
    } as WhatsAppMediaStorage;
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        companyId,
        conversationId,
        providerMessageId: 'expired-provider-id',
        direction: MessageDirection.INBOUND,
        kind: MessageKind.IMAGE,
        media: { mimeType: 'image/jpeg', fileName: 'foto.jpg' },
        mediaStorageKey: `v1/${companyId}/${conversationId}/${messageId}/${createHash('sha256').update(content).digest('hex')}`,
        mediaMimeType: 'image/jpeg',
        mediaSizeBytes: content.byteLength,
        mediaOriginalName: 'foto.jpg',
        mediaSha256: createHash('sha256').update(content).digest('hex'),
        mediaStoredAt: new Date('2026-08-07T12:00:00.000Z'),
        proposalDocument: null,
      }),
      storage,
      config(),
    );

    await expect(
      service.getContent(companyId, conversationId, messageId),
    ).resolves.toMatchObject({
      content,
      fileName: 'foto.jpg',
      mimeType: 'image/jpeg',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('infere o tipo de uma mídia histórica armazenada quando a mensagem veio como desconhecida', async () => {
    const content = Buffer.from('imagem-importada-do-backup');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const storage = {
      ...mediaStorage(),
      read: vi.fn().mockResolvedValue(content),
    } as WhatsAppMediaStorage;
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        companyId,
        conversationId,
        providerMessageId: null,
        direction: MessageDirection.OUTBOUND,
        kind: MessageKind.UNKNOWN,
        media: { mimeType: 'image/jpeg', fileName: 'foto-historica.jpg' },
        mediaStorageKey: `v1/${companyId}/${conversationId}/${messageId}/${createHash('sha256').update(content).digest('hex')}`,
        mediaMimeType: 'image/jpeg',
        mediaSizeBytes: content.byteLength,
        mediaOriginalName: 'foto-historica.jpg',
        mediaSha256: createHash('sha256').update(content).digest('hex'),
        mediaStoredAt: new Date('2026-08-20T02:10:16.415Z'),
        proposalDocument: null,
      }),
      storage,
      config(),
    );

    await expect(
      service.getContent(companyId, conversationId, messageId),
    ).resolves.toMatchObject({
      content,
      fileName: 'foto-historica.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('informa com clareza quando uma mídia histórica já expirou', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        companyId,
        conversationId,
        providerMessageId: 'expired-provider-id',
        direction: MessageDirection.INBOUND,
        kind: MessageKind.VIDEO,
        media: { mimeType: 'video/mp4', fileName: 'video.mp4' },
        proposalDocument: null,
      }),
      mediaStorage(),
      config(),
    );

    await expect(
      service.getContent(companyId, conversationId, messageId),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('não está mais disponível'),
    });
    await expect(
      service.retainInbound(companyId, conversationId, messageId),
    ).resolves.toMatchObject({ status: 'unavailable', messageId });
  });

  it('classifica falha temporária da Evolution como indisponibilidade recuperável', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        companyId,
        conversationId,
        providerMessageId: 'provider-temporarily-unavailable',
        direction: MessageDirection.INBOUND,
        kind: MessageKind.IMAGE,
        media: { mimeType: 'image/jpeg', fileName: 'foto.jpg' },
        proposalDocument: null,
      }),
      mediaStorage(),
      config(),
    );

    await expect(
      service.retainInbound(companyId, conversationId, messageId),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_SERVICE_UNAVAILABLE',
    });
  });

  it('mantém visível a mensagem acima do limite sem baixar o arquivo', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const prisma = prismaWithMessage({
      id: messageId,
      companyId,
      conversationId,
      providerMessageId: 'large-video',
      direction: MessageDirection.INBOUND,
      kind: MessageKind.VIDEO,
      media: {
        mimeType: 'video/mp4',
        fileName: 'video-grande.mp4',
        size: 10_485_761,
        retentionStatus: 'too-large',
      },
      proposalDocument: null,
    });
    const service = new EvolutionMediaContentService(
      prisma,
      mediaStorage(),
      config(),
    );

    await expect(
      service.retainInbound(companyId, conversationId, messageId),
    ).resolves.toMatchObject({ status: 'too-large', messageId });
    await expect(
      service.getContent(companyId, conversationId, messageId),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('excede o limite'),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

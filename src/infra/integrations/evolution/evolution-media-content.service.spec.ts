import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MessageDirection,
  MessageKind,
} from '../../database/prisma/generated/client';
import { PrismaService } from '../../database/prisma/prisma.service';
import { EvolutionMediaContentService } from './evolution-media-content.service';

const companyId = '00000000-0000-4000-8000-000000000001';
const conversationId = '00000000-0000-4000-8000-000000000101';
const messageId = '00000000-0000-4000-8000-000000000501';

function config(): ConfigService {
  const values: Readonly<Record<string, unknown>> = {
    EVOLUTION_BASE_URL: 'https://evolution.example.test',
    EVOLUTION_INSTANCE_NAME: 'milenium',
    EVOLUTION_API_KEY: 'evolution-api-key',
    WHATSAPP_MAX_ATTACHMENT_BYTES: 10_485_760,
    WHATSAPP_ALLOWED_MIME_TYPES:
      'image/jpeg,image/webp,application/pdf,audio/ogg,audio/mp4,video/mp4',
  };
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function prismaWithMessage(message: unknown): PrismaService {
  return {
    whatsAppMessage: {
      findUnique: vi.fn().mockResolvedValue(message),
    },
  } as unknown as PrismaService;
}

describe('EvolutionMediaContentService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('requests and decrypts inbound audio as MP4 for browser playback', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          mediaType: 'audioMessage',
          fileName: 'audio.ogg',
          mimetype: 'audio/mp4',
          base64: Buffer.from('audio-content').toString('base64'),
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    vi.stubGlobal('fetch', fetcher);
    const service = new EvolutionMediaContentService(
      prismaWithMessage({
        id: messageId,
        providerMessageId: 'provider-audio-1',
        direction: MessageDirection.INBOUND,
        kind: MessageKind.AUDIO,
        media: {
          mimeType: 'audio/ogg',
          fileName: 'audio.ogg',
        },
        proposalDocument: null,
      }),
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

  it('removes the encrypted suffix from a received PDF filename', async () => {
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
        media: {
          mimeType: 'application/pdf',
          fileName: 'documento.pdf.enc',
        },
        proposalDocument: null,
      }),
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

  it('serves an outbound proposal PDF from PostgreSQL without calling Evolution', async () => {
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

  it('rejects media returned with a MIME type outside the configured allow-list', async () => {
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
      config(),
    );

    await expect(
      service.getContent(companyId, conversationId, messageId),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

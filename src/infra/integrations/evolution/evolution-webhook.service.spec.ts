import { createHash } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { WhatsAppRepository } from '../../../application/contracts/whatsapp.repository';
import type { EvolutionMediaContentService } from './evolution-media-content.service';
import { EvolutionWebhookService } from './evolution-webhook.service';

const secret = 'webhook-secret-with-enough-entropy';
const companyId = '00000000-0000-4000-8000-000000000001';
const channelId = '00000000-0000-4000-8000-000000000002';
const conversationId = '00000000-0000-4000-8000-000000000003';
const messageId = '00000000-0000-4000-8000-000000000004';
const now = new Date('2026-08-10T12:00:00.000Z');

function createSubject() {
  const repository = {
    findWebhookChannel: vi.fn(async () => ({
      id: channelId,
      companyId,
      instanceName: 'lume',
      webhookSecretHash: createHash('sha256').update(secret).digest('hex'),
      ignoreGroups: true,
      ignoreFromMe: true,
      enabled: true,
    })),
    persistInbound: vi.fn(async () => ({
      accepted: true as const,
      duplicate: false,
      messageId,
      conversationId,
    })),
  };
  const mediaContent = {
    retainInbound: vi.fn(async () => ({
      status: 'stored' as const,
      messageId,
    })),
  };
  const subject = new EvolutionWebhookService(
    repository as unknown as WhatsAppRepository,
    mediaContent as unknown as EvolutionMediaContentService,
    new ConfigService({
      EVOLUTION_WEBHOOK_SECRET: secret,
      WHATSAPP_MAX_ATTACHMENT_BYTES: 52_428_800,
      WHATSAPP_ALLOWED_MIME_TYPES:
        'image/jpeg,audio/ogg,video/mp4,application/pdf',
    }),
  );
  return { subject, repository, mediaContent };
}

function videoWebhook(size: number, mimeType = 'video/mp4') {
  return {
    event: 'messages.upsert',
    instance: 'lume',
    data: {
      key: {
        id: `provider-video-${size}`,
        remoteJid: '5534999999999@s.whatsapp.net',
        fromMe: false,
      },
      messageTimestamp: Math.floor(now.valueOf() / 1_000),
      message: {
        videoMessage: {
          mimetype: mimeType,
          fileLength: size,
          fileName: 'video.mp4',
        },
      },
    },
  };
}

async function handle(
  subject: EvolutionWebhookService,
  body: ReturnType<typeof videoWebhook>,
) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return subject.handle({
    channelId,
    headers: { 'x-evolution-webhook-token': secret },
    rawBody,
    body,
    now,
  });
}

describe('EvolutionWebhookService media retention metadata', () => {
  it.each([2_500_000, 52_428_800])(
    'persiste vídeo suportado com %d bytes para retenção durável',
    async (size) => {
      const { subject, repository, mediaContent } = createSubject();

      await handle(subject, videoWebhook(size));

      expect(repository.persistInbound).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'video',
          media: expect.objectContaining({
            mimeType: 'video/mp4',
            size,
            retentionStatus: 'pending',
          }),
        }),
      );
      expect(mediaContent.retainInbound).toHaveBeenCalledWith(
        companyId,
        conversationId,
        messageId,
      );
    },
  );

  it('mantém o vídeo acima do limite no histórico com estado explícito', async () => {
    const { subject, repository, mediaContent } = createSubject();
    mediaContent.retainInbound.mockResolvedValueOnce({
      status: 'too-large',
      messageId,
    });

    await expect(handle(subject, videoWebhook(52_428_801))).resolves.toEqual(
      expect.objectContaining({ mediaRetention: 'too-large' }),
    );
    expect(repository.persistInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        media: expect.objectContaining({ retentionStatus: 'too-large' }),
      }),
    );
  });

  it('rejeita MIME fora da lista permitida antes de persistir', async () => {
    const { subject, repository, mediaContent } = createSubject();

    await expect(
      handle(subject, videoWebhook(2_500_000, 'video/x-unsafe')),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.persistInbound).not.toHaveBeenCalled();
    expect(mediaContent.retainInbound).not.toHaveBeenCalled();
  });
});

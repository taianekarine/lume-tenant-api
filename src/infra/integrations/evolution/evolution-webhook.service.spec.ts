import { createHash } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { WhatsAppRepository } from '../../../application/contracts/whatsapp.repository';
import type { EvolutionMediaContentService } from './evolution-media-content.service';
import type { EvolutionProfilePictureService } from './evolution-profile-picture.service';
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
    persistWebhookMessage: vi.fn(async () => ({
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
    retainWebhookMedia: vi.fn(async () => ({
      status: 'stored' as const,
      messageId,
    })),
  };
  const profilePictures = {
    get: vi.fn(async () => 'https://media.example.test/profile.jpg'),
  };
  const subject = new EvolutionWebhookService(
    repository as unknown as WhatsAppRepository,
    mediaContent as unknown as EvolutionMediaContentService,
    profilePictures as unknown as EvolutionProfilePictureService,
    new ConfigService({
      EVOLUTION_WEBHOOK_SECRET: secret,
      WHATSAPP_MAX_ATTACHMENT_BYTES: 52_428_800,
      WHATSAPP_ALLOWED_MIME_TYPES:
        'image/jpeg,audio/ogg,video/mp4,application/pdf',
    }),
  );
  return { subject, repository, mediaContent, profilePictures };
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

async function handle(subject: EvolutionWebhookService, body: unknown) {
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

      expect(repository.persistWebhookMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: 'inbound',
          kind: 'video',
          profilePictureUrl: 'https://media.example.test/profile.jpg',
          media: expect.objectContaining({
            mimeType: 'video/mp4',
            size,
            retentionStatus: 'pending',
          }),
        }),
      );
      expect(mediaContent.retainWebhookMedia).toHaveBeenCalledWith(
        companyId,
        conversationId,
        messageId,
      );
    },
  );

  it('mantém o vídeo acima do limite no histórico com estado explícito', async () => {
    const { subject, repository, mediaContent } = createSubject();
    mediaContent.retainWebhookMedia.mockResolvedValueOnce({
      status: 'too-large',
      messageId,
    });

    await expect(handle(subject, videoWebhook(52_428_801))).resolves.toEqual(
      expect.objectContaining({ mediaRetention: 'too-large' }),
    );
    expect(repository.persistWebhookMessage).toHaveBeenCalledWith(
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
    expect(repository.persistWebhookMessage).not.toHaveBeenCalled();
    expect(mediaContent.retainWebhookMedia).not.toHaveBeenCalled();
  });
});

describe('EvolutionWebhookService outbound history', () => {
  it('persiste mensagem fromMe como saída mesmo com ignoreFromMe habilitado', async () => {
    const { subject, repository } = createSubject();
    const body = {
      event: 'messages.upsert',
      instance: 'lume',
      data: {
        key: {
          id: 'provider-external-outbound',
          remoteJid: '5534999999999@s.whatsapp.net',
          fromMe: true,
        },
        pushName: 'Nome da própria conta',
        messageTimestamp: Math.floor(now.valueOf() / 1_000),
        message: { conversation: 'Mensagem enviada pelo WhatsApp Web' },
      },
    };

    await expect(handle(subject, body)).resolves.toEqual(
      expect.objectContaining({ accepted: true, duplicate: false }),
    );
    expect(repository.persistWebhookMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'outbound',
        phoneNormalized: '5534999999999',
        text: 'Mensagem enviada pelo WhatsApp Web',
        displayName: undefined,
      }),
    );
  });

  it('usa remoteJidAlt telefônico quando remoteJid é um LID', async () => {
    const { subject, repository } = createSubject();
    const body = {
      event: 'messages.upsert',
      instance: 'lume',
      data: {
        key: {
          id: 'provider-lid-outbound',
          remoteJid: '123456789012345@lid',
          remoteJidAlt: '5534999999999@s.whatsapp.net',
          participant: '999999999999999@lid',
          fromMe: true,
        },
        messageTimestamp: Math.floor(now.valueOf() / 1_000),
        message: { conversation: 'Mensagem por LID' },
      },
    };

    await handle(subject, body);

    expect(repository.persistWebhookMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'outbound',
        phoneNormalized: '5534999999999',
      }),
    );
  });

  it('mantém mídia fromMe no fluxo de retenção do webhook', async () => {
    const { subject, repository, mediaContent } = createSubject();
    const body = videoWebhook(2_500_000);
    body.data.key.fromMe = true;

    await handle(subject, body);

    expect(repository.persistWebhookMessage).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'outbound', kind: 'video' }),
    );
    expect(mediaContent.retainWebhookMedia).toHaveBeenCalledWith(
      companyId,
      conversationId,
      messageId,
    );
    expect(mediaContent.retainInbound).not.toHaveBeenCalled();
  });
});

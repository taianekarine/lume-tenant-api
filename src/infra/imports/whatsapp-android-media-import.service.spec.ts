import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

import { MessageKind } from '../database/prisma/generated/client';
import { WhatsAppAndroidMediaImportService } from './whatsapp-android-media-import.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const CHANNEL_ID = '99999999-9999-4999-8999-999999999999';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup(stored = false) {
  const root = await mkdtemp(join(tmpdir(), 'lume-android-media-'));
  roots.push(root);
  const importsRoot = join(root, 'imports');
  const mediaRoot = join(root, 'WhatsApp Business', 'Media');
  const imagePath = join(mediaRoot, 'WhatsApp Images', 'foto.jpg');
  await mkdir(join(importsRoot, 'history-batches', COMPANY_ID, BATCH_ID), {
    recursive: true,
  });
  await mkdir(join(mediaRoot, 'WhatsApp Images'), { recursive: true });
  await writeFile(
    join(importsRoot, 'history-batches', COMPANY_ID, BATCH_ID, 'manifest.json'),
    JSON.stringify({
      id: BATCH_ID,
      companyId: COMPANY_ID,
      channelId: CHANNEL_ID,
      status: 'applied',
      androidBackup: { chunksCompleted: 1 },
    }),
  );
  await writeFile(imagePath, Buffer.from('imagem-historica'));
  const prisma = {
    whatsAppImportExternalRef: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: '55555555-5555-4555-8555-555555555555',
          internalId: MESSAGE_ID,
        },
      ]),
    },
    whatsAppMessage: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: MESSAGE_ID,
          conversationId: CONVERSATION_ID,
          media: {
            legacyReference:
              'whatsapp-android-media://%2Fstorage%2Femulated%2F0%2FAndroid%2Fmedia%2Fcom.whatsapp.w4b%2FWhatsApp%20Business%2FMedia%2FWhatsApp%20Images%2Ffoto.jpg',
            retentionStatus: 'unavailable',
          },
          mediaStorageKey: stored ? 'v1/already-stored' : null,
        },
      ]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const storage = { write: vi.fn(), read: vi.fn(), delete: vi.fn() };
  const config = {
    get: vi.fn((key: string) =>
      key === 'WHATSAPP_IMPORT_ROOT' ? importsRoot : undefined,
    ),
  };
  return {
    mediaRoot,
    prisma,
    storage,
    service: new WhatsAppAndroidMediaImportService(
      prisma as never,
      storage,
      config as never,
    ),
  };
}

describe('WhatsAppAndroidMediaImportService', () => {
  it('matches the Android Media suffix, stores and links the binary', async () => {
    const { mediaRoot, prisma, storage, service } = await setup();

    const result = await service.attach({
      companyId: COMPANY_ID,
      batchId: BATCH_ID,
      mediaRoot,
    });

    expect(result).toMatchObject({
      candidates: 1,
      filesScanned: 1,
      attached: 1,
      missing: 0,
      alreadyStored: 0,
    });
    expect(storage.write).toHaveBeenCalledWith({
      storageKey: expect.stringMatching(
        new RegExp(`^v1/${COMPANY_ID}/${CONVERSATION_ID}/${MESSAGE_ID}/`),
      ),
      content: Buffer.from('imagem-historica'),
    });
    expect(prisma.whatsAppMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mediaMimeType: 'image/jpeg',
          mediaOriginalName: 'foto.jpg',
          mediaSizeBytes: 16,
        }),
      }),
    );
  });

  it('does not rewrite media already retained', async () => {
    const { mediaRoot, storage, service } = await setup(true);

    const result = await service.attach({
      companyId: COMPANY_ID,
      batchId: BATCH_ID,
      mediaRoot,
    });

    expect(result).toMatchObject({
      candidates: 0,
      attached: 0,
      alreadyStored: 1,
    });
    expect(storage.write).not.toHaveBeenCalled();
  });

  it('searches pending media from earlier Android imports on the same channel', async () => {
    const { mediaRoot, prisma, service } = await setup();

    await service.attach({
      companyId: COMPANY_ID,
      batchId: BATCH_ID,
      mediaRoot,
    });

    expect(prisma.whatsAppImportExternalRef.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: COMPANY_ID,
          entityType: 'message',
          sourceSystem: 'whatsapp-android-backup',
        }),
      }),
    );
    const referenceQuery =
      prisma.whatsAppImportExternalRef.findMany.mock.calls[0]?.[0]?.where;
    expect(referenceQuery).not.toHaveProperty('batchId');
    expect(prisma.whatsAppMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: COMPANY_ID,
          channelId: CHANNEL_ID,
        }),
      }),
    );
  });

  it('links media received in a ZIP uploaded by the administration screen', async () => {
    const { mediaRoot, prisma, storage, service } = await setup();
    const archivePath = join(mediaRoot, 'midias.zip');
    const zip = new JSZip();
    zip.file(
      'WhatsApp Business/Media/WhatsApp Images/arquivo-sem-referencia.jpg',
      Buffer.alloc(2 * 1024 * 1024, 1),
    );
    zip.file(
      'WhatsApp Business/Media/WhatsApp Images/foto.jpg',
      Buffer.from('imagem-historica'),
    );
    const content = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(archivePath, content);

    const result = await service.attachArchive({
      companyId: COMPANY_ID,
      batchId: BATCH_ID,
      archivePath,
      originalName: 'midias.zip',
      sizeBytes: content.byteLength,
    });

    expect(result).toMatchObject({
      candidates: 1,
      filesScanned: 2,
      attached: 1,
      missing: 0,
    });
    expect(storage.write).toHaveBeenCalledOnce();
    expect(prisma.whatsAppMessage.updateMany).toHaveBeenCalledOnce();
  });

  it('previews stored, new and still missing media before applying the backup', async () => {
    const { mediaRoot, service } = await setup();
    const archivePath = join(mediaRoot, 'previa-midias.zip');
    const zip = new JSZip();
    zip.file(
      'WhatsApp Business/Media/WhatsApp Images/nova.jpg',
      Buffer.from('imagem-nova'),
    );
    const content = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(archivePath, content);

    const result = await service.previewArchive(
      {
        archivePath,
        originalName: 'previa-midias.zip',
        sizeBytes: content.byteLength,
      },
      [
        {
          id: 'stored',
          reference:
            'whatsapp-android-media://Media%2FWhatsApp%20Images%2Farmazenada.jpg',
          stored: true,
        },
        {
          id: 'new',
          reference:
            'whatsapp-android-media://Media%2FWhatsApp%20Images%2Fnova.jpg',
          stored: false,
        },
        {
          id: 'missing',
          reference:
            'whatsapp-android-media://Media%2FWhatsApp%20Images%2Fausente.jpg',
          stored: false,
        },
      ],
    );

    expect(result).toEqual({
      filesTotal: 1,
      mediaStored: 1,
      mediaNew: 1,
      mediaMissing: 1,
    });
  });

  it('links every repeated reference and recovers pathless documents by content hash', async () => {
    const { mediaRoot, prisma, storage, service } = await setup();
    const archivePath = join(mediaRoot, 'midias-completas.zip');
    const pdf = Buffer.from('%PDF-1.7 documento histórico');
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const audio = Buffer.from('audio histórico sem extensão');
    const audioSha256 = createHash('sha256').update(audio).digest('hex');
    const messageIds = [
      MESSAGE_ID,
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
    ];
    prisma.whatsAppImportExternalRef.findMany.mockResolvedValue(
      messageIds.map((internalId, index) => ({
        id: `${index + 6}5555555-5555-4555-8555-555555555555`,
        internalId,
      })),
    );
    prisma.whatsAppMessage.findMany.mockResolvedValue(
      messageIds.map((id, index) => ({
        id,
        conversationId: CONVERSATION_ID,
        media: {
          legacyReference:
            index === 3
              ? `whatsapp-android-media://Media%2FWhatsApp%20Voice%20Notes%2FPTT-2026#sha256=${audioSha256}`
              : index === 2
                ? `whatsapp-android-media://midia-3#sha256=${sha256}`
                : `whatsapp-android-media://Media%2FWhatsApp%20Documents%2Fcontrato.pdf#sha256=${sha256}`,
          mimeType: index === 3 ? 'audio/ogg' : 'application/pdf',
          retentionStatus: 'unavailable',
        },
        mediaStorageKey: null,
      })),
    );
    const zip = new JSZip();
    zip.file('WhatsApp Business/Media/WhatsApp Documents/contrato.pdf', pdf);
    zip.file('WhatsApp Business/Media/WhatsApp Voice Notes/PTT-2026', audio);
    const content = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(archivePath, content);

    const result = await service.attachArchive({
      companyId: COMPANY_ID,
      batchId: BATCH_ID,
      archivePath,
      originalName: 'midias-completas.zip',
      sizeBytes: content.byteLength,
    });

    expect(result).toMatchObject({
      candidates: 4,
      filesScanned: 2,
      attached: 4,
      missing: 0,
      ambiguous: 0,
    });
    expect(storage.write).toHaveBeenCalledTimes(4);
    expect(prisma.whatsAppMessage.updateMany).toHaveBeenCalledTimes(4);
    expect(prisma.whatsAppMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: MessageKind.DOCUMENT,
          mediaMimeType: 'application/pdf',
          mediaOriginalName: 'contrato.pdf',
        }),
      }),
    );
    expect(prisma.whatsAppMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: MessageKind.AUDIO,
          mediaMimeType: 'audio/ogg',
          mediaOriginalName: 'PTT-2026',
        }),
      }),
    );
  });
});

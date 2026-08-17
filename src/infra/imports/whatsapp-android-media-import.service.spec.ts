import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { WhatsAppAndroidMediaImportService } from './whatsapp-android-media-import.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
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
});

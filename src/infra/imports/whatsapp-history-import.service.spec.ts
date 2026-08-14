import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

import { parseWhatsAppExportArchive } from './whatsapp-export-parser';
import { identifyWhatsAppExportMessages } from './whatsapp-export-workbook';
import { WhatsAppHistoryImportService } from './whatsapp-history-import.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_ID = '33333333-3333-4333-8333-333333333333';
const COMMAND_ID = '44444444-4444-4444-8444-444444444444';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'lume-whatsapp-history-'));
  roots.push(root);
  const prisma = {
    whatsAppChannel: {
      findFirst: vi.fn().mockResolvedValue({
        id: CHANNEL_ID,
        name: 'WhatsApp principal',
        phoneNumber: '5534999999999',
      }),
    },
    whatsAppImportExternalRef: { findMany: vi.fn().mockResolvedValue([]) },
    whatsAppMessage: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const config = {
    get: vi.fn((key: string) =>
      key === 'WHATSAPP_IMPORT_ROOT' ? root : undefined,
    ),
  };
  const mediaStorage = {
    write: vi.fn(),
    read: vi.fn(),
    delete: vi.fn(),
  };
  return {
    root,
    prisma,
    mediaStorage,
    service: new WhatsAppHistoryImportService(
      prisma as never,
      mediaStorage,
      config as never,
    ),
  };
}

describe('WhatsAppHistoryImportService.create', () => {
  it('cria um manifesto privado e reutiliza o mesmo comando de forma idempotente', async () => {
    const { root, service } = await setup();
    const input = {
      companyId: COMPANY_ID,
      actorUserId: ACTOR_ID,
      actorUsername: 'admin',
      commandId: COMMAND_ID,
      channelId: CHANNEL_ID,
    };

    const created = await service.create(input);
    const repeated = await service.create(input);
    const manifest = JSON.parse(
      await readFile(
        join(root, 'history-batches', COMPANY_ID, COMMAND_ID, 'manifest.json'),
        'utf8',
      ),
    ) as { id: string; companyId: string; status: string };

    expect(created).toEqual(repeated);
    expect(created).toMatchObject({ id: COMMAND_ID, status: 'draft' });
    expect(manifest).toMatchObject({
      id: COMMAND_ID,
      companyId: COMPANY_ID,
      status: 'draft',
    });
  });

  it('rejeita canal inexistente sem criar um lote', async () => {
    const { prisma, service } = await setup();
    prisma.whatsAppChannel.findFirst.mockResolvedValue(null);

    await expect(
      service.create({
        companyId: COMPANY_ID,
        actorUserId: ACTOR_ID,
        actorUsername: 'admin',
        commandId: COMMAND_ID,
        channelId: CHANNEL_ID,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('WhatsAppHistoryImportService media retention', () => {
  it('stores a ZIP attachment and links it to the imported message', async () => {
    const { root, prisma, mediaStorage, service } = await setup();
    const zip = new JSZip();
    zip.file(
      'Conversa do WhatsApp com Cliente.txt',
      '12/08/2026 09:00 - Cliente: foto.jpg (arquivo anexado)',
    );
    zip.file('foto.jpg', Buffer.from('imagem'));
    const content = await zip.generateAsync({ type: 'nodebuffer' });
    const parsed = await parseWhatsAppExportArchive('cliente.zip', content);
    const mapping = {
      archiveId: parsed.archiveId,
      phoneE164: '5534988888888',
      contactName: 'Cliente',
      companySenderName: 'Milenium',
      state: 'sent-to-human' as const,
      departmentCode: 'commercial',
      ownerUsername: null,
    };
    const identity = identifyWhatsAppExportMessages(
      parsed,
      mapping,
      '5534999999999',
    )[0];
    if (!identity) throw new Error('A mensagem de teste não foi identificada.');
    const messageId = '55555555-5555-4555-8555-555555555555';
    const conversationId = '66666666-6666-4666-8666-666666666666';
    prisma.whatsAppImportExternalRef.findMany.mockResolvedValue([
      { externalId: identity.externalMessageId, internalId: messageId },
    ]);
    prisma.whatsAppMessage.findMany.mockResolvedValue([
      { id: messageId, conversationId, media: {} },
    ]);
    const batchPath = join(root, 'history-batches', COMPANY_ID, COMMAND_ID);
    await mkdir(batchPath, { recursive: true });
    await writeFile(join(batchPath, `${parsed.archiveId}.zip`), content);

    await (
      service as unknown as {
        retainImportedMedia(
          manifest: unknown,
          exports: unknown[],
          mappings: unknown[],
        ): Promise<void>;
      }
    ).retainImportedMedia(
      {
        id: COMMAND_ID,
        companyId: COMPANY_ID,
        channelPhoneE164: '5534999999999',
        archives: [
          {
            archiveId: parsed.archiveId,
            storageFileName: `${parsed.archiveId}.zip`,
          },
        ],
      },
      [parsed],
      [mapping],
    );

    expect(mediaStorage.write).toHaveBeenCalledWith({
      storageKey: expect.stringMatching(
        new RegExp(`^v1/${COMPANY_ID}/${conversationId}/${messageId}/`),
      ),
      content: Buffer.from('imagem'),
    });
    expect(prisma.whatsAppMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: messageId, companyId: COMPANY_ID, conversationId },
        data: expect.objectContaining({
          mediaMimeType: 'image/jpeg',
          mediaOriginalName: 'foto.jpg',
          mediaSizeBytes: 6,
        }),
      }),
    );
  });
});

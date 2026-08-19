import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

import { parseWhatsAppExportArchive } from './whatsapp-export-parser';
import { identifyWhatsAppExportMessages } from './whatsapp-export-workbook';
import {
  ensureImportWorkbookArtifact,
  WhatsAppHistoryImportService,
} from './whatsapp-history-import.service';

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
    whatsAppImportExternalRef: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
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
  const androidMediaImporter = {
    validateArchive: vi.fn().mockResolvedValue({ filesTotal: 1 }),
    previewArchive: vi.fn().mockResolvedValue({
      filesTotal: 1,
      mediaStored: 0,
      mediaNew: 1,
      mediaMissing: 0,
    }),
    attachArchive: vi.fn().mockResolvedValue({
      schemaVersion: '1.0',
      candidates: 1,
      filesScanned: 1,
      attached: 1,
      alreadyStored: 0,
      missing: 0,
      ambiguous: 0,
      skippedOversize: 0,
    }),
  };
  return {
    root,
    prisma,
    mediaStorage,
    service: new WhatsAppHistoryImportService(
      prisma as never,
      mediaStorage,
      androidMediaImporter as never,
      config as never,
    ),
    androidMediaImporter,
  };
}

describe('WhatsAppHistoryImportService.create', () => {
  it('preserva o artefato do bloco em uma retomada da importação', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lume-whatsapp-chunk-'));
    roots.push(root);
    const workbookPath = join(root, 'chunk.xlsx');
    const generate = vi
      .fn<() => Promise<Buffer>>()
      .mockResolvedValueOnce(Buffer.from('primeira-versao'))
      .mockResolvedValueOnce(Buffer.from('segunda-versao'));

    await ensureImportWorkbookArtifact(workbookPath, generate);
    await ensureImportWorkbookArtifact(workbookPath, generate);

    expect(await readFile(workbookPath, 'utf8')).toBe('primeira-versao');
    expect(generate).toHaveBeenCalledOnce();
  });

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

  it('lista somente backups Android concluídos do tenant', async () => {
    const { root, service } = await setup();
    const input = {
      companyId: COMPANY_ID,
      actorUserId: ACTOR_ID,
      actorUsername: 'admin',
      commandId: COMMAND_ID,
      channelId: CHANNEL_ID,
    };
    await service.create(input);
    const manifestPath = join(
      root,
      'history-batches',
      COMPANY_ID,
      COMMAND_ID,
      'manifest.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest.status = 'applied';
    manifest.appliedAt = new Date().toISOString();
    manifest.androidBackup = {
      databaseFileName: 'msgstore.db.crypt15',
      databaseSha256: 'a'.repeat(64),
      encryptedBytes: 128,
      decryptedBytes: 256,
      multiFileBackup: false,
      summary: {
        schemaVersion: '1',
        directConversations: 1,
        directMessages: 2,
        mediaReferences: 3,
        groupConversationsExcluded: 0,
        groupMessagesExcluded: 0,
        otherConversationsExcluded: 0,
        otherMessagesExcluded: 0,
        unmappedDirectConversations: 0,
        startedAt: null,
        endedAt: null,
      },
      state: 'closed',
      departmentCode: 'commercial',
      ownerUsername: null,
      cutoffAt: new Date().toISOString(),
      chunksCompleted: 1,
      conversationsProcessed: 1,
      messagesProcessed: 2,
      errorMessage: null,
      mediaImport: null,
    };
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const result = await service.appliedAndroidBackups(COMPANY_ID);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: COMMAND_ID,
      mode: 'android-backup',
      status: 'applied',
      androidBackup: {
        databaseFileName: 'msgstore.db.crypt15',
      },
    });
    await expect(
      service.appliedAndroidBackups('77777777-7777-4777-8777-777777777777'),
    ).resolves.toEqual([]);
  });
});

describe('WhatsAppHistoryImportService divergence review', () => {
  it('lista as diferenças e registra a decisão humana antes de aplicar', async () => {
    const { root, service } = await setup();
    await service.create({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_ID,
      actorUsername: 'admin',
      commandId: COMMAND_ID,
      channelId: CHANNEL_ID,
    });
    const batchPath = join(root, 'history-batches', COMPANY_ID, COMMAND_ID);
    const manifestPath = join(batchPath, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest.androidBackup = {
      databaseFileName: 'msgstore.db.crypt15',
      databaseSha256: 'a'.repeat(64),
      encryptedBytes: 128,
      decryptedBytes: 256,
      multiFileBackup: false,
      summary: {
        schemaVersion: '1',
        directConversations: 1,
        directMessages: 2,
        mediaReferences: 0,
        groupConversationsExcluded: 0,
        groupMessagesExcluded: 0,
        otherConversationsExcluded: 0,
        otherMessagesExcluded: 0,
        unmappedDirectConversations: 0,
        startedAt: null,
        endedAt: null,
      },
      state: 'closed',
      departmentCode: 'commercial',
      ownerUsername: null,
      cutoffAt: null,
      chunksCompleted: 0,
      conversationsProcessed: 0,
      messagesProcessed: 0,
      errorMessage: null,
      comparison: {
        status: 'ready',
        messagesExisting: 0,
        messagesNew: 0,
        messagesDivergent: 2,
        messagesDivergentPending: 2,
        mediaStored: 0,
        mediaNew: 0,
        mediaMissing: 0,
        updatedAt: new Date().toISOString(),
        errorMessage: null,
      },
      mediaImport: null,
    };
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    const androidPath = join(batchPath, 'android');
    await mkdir(androidPath, { recursive: true });
    const message = (externalMessageId: string) => ({
      externalMessageId,
      internalMessageId: '55555555-5555-4555-8555-555555555555',
      externalConversationId: 'conversation-1',
      contactName: 'Contato',
      phoneE164: '5534999999999',
      senderName: 'Contato',
      existing: {
        direction: 'inbound',
        deliveryStatus: 'received',
        kind: 'text',
        text: 'Mensagem atual',
        occurredAt: '2026-08-19T12:00:00.000Z',
        mediaReference: null,
        payloadHash: 'a'.repeat(64),
      },
      backup: {
        direction: 'inbound',
        deliveryStatus: 'received',
        kind: 'text',
        text: 'Mensagem do backup',
        occurredAt: '2026-08-19T12:00:00.000Z',
        mediaReference: null,
        payloadHash: 'b'.repeat(64),
      },
      resolution: null,
      decidedByUserId: null,
      decidedByUsername: null,
      decidedAt: null,
    });
    await writeFile(
      join(androidPath, 'message-divergences.json'),
      JSON.stringify([message('message-1'), message('message-2')]),
      'utf8',
    );

    await expect(
      service.apply(COMPANY_ID, COMMAND_ID, new Date()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const listed = await service.androidDivergences(COMPANY_ID, COMMAND_ID);
    expect(listed).toMatchObject({ total: 2, pending: 2 });

    const resolved = await service.resolveAndroidDivergence(
      COMPANY_ID,
      COMMAND_ID,
      'message-1',
      'keep-existing',
      ACTOR_ID,
      'admin',
    );

    expect(resolved).toMatchObject({
      pending: 1,
      divergence: {
        externalMessageId: 'message-1',
        resolution: 'keep-existing',
        decidedByUsername: 'admin',
      },
    });
    await expect(
      service.androidDivergences(COMPANY_ID, COMMAND_ID),
    ).resolves.toMatchObject({ total: 2, pending: 1 });
  });

  it('memoriza a versão recusada para não pedir a mesma decisão em uma nova importação', async () => {
    const { prisma, service } = await setup();
    prisma.whatsAppImportExternalRef.findFirst.mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
      payloadHash: 'a'.repeat(64),
      acceptedPayloadHashes: null,
    });
    const applyResolutions = service as unknown as {
      applyAndroidDivergenceResolutions(
        companyId: string,
        batchId: string,
        divergences: readonly Record<string, unknown>[],
      ): Promise<void>;
    };

    await applyResolutions.applyAndroidDivergenceResolutions(
      COMPANY_ID,
      COMMAND_ID,
      [
        {
          externalMessageId: 'message-1',
          internalMessageId: '55555555-5555-4555-8555-555555555555',
          existing: {
            mediaReference: null,
          },
          backup: {
            payloadHash: 'b'.repeat(64),
          },
          resolution: 'keep-existing',
        },
      ],
    );

    expect(prisma.whatsAppImportExternalRef.updateMany).toHaveBeenCalledWith({
      where: {
        id: '66666666-6666-4666-8666-666666666666',
        companyId: COMPANY_ID,
      },
      data: {
        acceptedPayloadHashes: ['b'.repeat(64)],
      },
    });
    expect(prisma.whatsAppMessage.updateMany).not.toHaveBeenCalled();
  });

  it('substitui a mensagem quando a versão do backup é escolhida', async () => {
    const { prisma, service } = await setup();
    prisma.whatsAppImportExternalRef.findFirst.mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
      payloadHash: 'a'.repeat(64),
      acceptedPayloadHashes: null,
    });
    prisma.whatsAppMessage.updateMany.mockResolvedValue({ count: 1 });
    const applyResolutions = service as unknown as {
      applyAndroidDivergenceResolutions(
        companyId: string,
        batchId: string,
        divergences: readonly Record<string, unknown>[],
      ): Promise<void>;
    };

    await applyResolutions.applyAndroidDivergenceResolutions(
      COMPANY_ID,
      COMMAND_ID,
      [
        {
          externalMessageId: 'message-1',
          internalMessageId: '55555555-5555-4555-8555-555555555555',
          existing: {
            mediaReference: null,
          },
          backup: {
            direction: 'inbound',
            deliveryStatus: 'received',
            kind: 'text',
            text: 'Mensagem do backup',
            occurredAt: '2026-08-19T12:00:00.000Z',
            mediaReference: null,
            payloadHash: 'b'.repeat(64),
          },
          resolution: 'use-backup',
        },
      ],
    );

    expect(prisma.whatsAppMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: '55555555-5555-4555-8555-555555555555',
          companyId: COMPANY_ID,
        },
        data: expect.objectContaining({
          text: 'Mensagem do backup',
          occurredAt: new Date('2026-08-19T12:00:00.000Z'),
        }),
      }),
    );
    expect(prisma.whatsAppImportExternalRef.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payloadHash: 'b'.repeat(64),
        }),
      }),
    );
  });
});

describe('WhatsAppHistoryImportService media retention', () => {
  it('prepara o ZIP de mídias antes de liberar a aplicação do backup Android', async () => {
    const { root, service, androidMediaImporter } = await setup();
    await service.create({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_ID,
      actorUsername: 'admin',
      commandId: COMMAND_ID,
      channelId: CHANNEL_ID,
    });
    const manifestPath = join(
      root,
      'history-batches',
      COMPANY_ID,
      COMMAND_ID,
      'manifest.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest.androidBackup = {
      databaseFileName: 'msgstore.db.crypt15',
      databaseSha256: 'a'.repeat(64),
      encryptedBytes: 128,
      decryptedBytes: 256,
      multiFileBackup: false,
      summary: {
        schemaVersion: '1',
        directConversations: 1,
        directMessages: 2,
        mediaReferences: 1,
        groupConversationsExcluded: 0,
        groupMessagesExcluded: 0,
        otherConversationsExcluded: 0,
        otherMessagesExcluded: 0,
        unmappedDirectConversations: 0,
        startedAt: null,
        endedAt: null,
      },
      state: 'closed',
      departmentCode: 'commercial',
      ownerUsername: null,
      cutoffAt: null,
      chunksCompleted: 0,
      conversationsProcessed: 0,
      messagesProcessed: 0,
      errorMessage: null,
      comparison: {
        status: 'ready',
        messagesExisting: 0,
        messagesNew: 2,
        messagesDivergent: 0,
        mediaStored: 0,
        mediaNew: 0,
        mediaMissing: 1,
        updatedAt: new Date().toISOString(),
        errorMessage: null,
      },
      mediaImport: null,
    };
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    const androidPath = join(
      root,
      'history-batches',
      COMPANY_ID,
      COMMAND_ID,
      'android',
    );
    await mkdir(androidPath, { recursive: true });
    await writeFile(
      join(androidPath, 'media-preview-references.json'),
      JSON.stringify([
        {
          id: 'android-message-1',
          reference: 'whatsapp-android-media://Media%2Ffoto.jpg',
          stored: false,
        },
      ]),
      'utf8',
    );

    await expect(
      service.apply(COMPANY_ID, COMMAND_ID, new Date()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const started = await service.createAndroidMediaUpload(
      COMPANY_ID,
      COMMAND_ID,
      { originalName: 'Media.zip', sizeBytes: 30 },
    );
    await service.addAndroidMediaUploadChunk(COMPANY_ID, COMMAND_ID, {
      uploadId: started.uploadId,
      offsetBytes: 0,
      content: Buffer.alloc(30, 1),
    });
    const ready = await service.completeAndroidMediaUpload(
      COMPANY_ID,
      COMMAND_ID,
      started.uploadId,
    );

    expect(ready).toMatchObject({
      status: 'draft',
      androidBackup: { mediaImport: { status: 'ready' } },
    });
    expect(androidMediaImporter.previewArchive).toHaveBeenCalledOnce();
    expect(ready.androidBackup?.comparison).toMatchObject({
      mediaStored: 0,
      mediaNew: 1,
      mediaMissing: 0,
    });
    expect(androidMediaImporter.attachArchive).not.toHaveBeenCalled();
  });

  it('recebe um ZIP grande em blocos retomáveis e processa em segundo plano', async () => {
    const { root, service, androidMediaImporter } = await setup();
    await service.create({
      companyId: COMPANY_ID,
      actorUserId: ACTOR_ID,
      actorUsername: 'admin',
      commandId: COMMAND_ID,
      channelId: CHANNEL_ID,
    });
    const manifestPath = join(
      root,
      'history-batches',
      COMPANY_ID,
      COMMAND_ID,
      'manifest.json',
    );
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    manifest.status = 'applied';
    manifest.appliedAt = new Date().toISOString();
    manifest.androidBackup = {
      databaseFileName: 'msgstore.db.crypt15',
      databaseSha256: 'a'.repeat(64),
      encryptedBytes: 128,
      decryptedBytes: 256,
      multiFileBackup: false,
      summary: {
        schemaVersion: '1',
        directConversations: 1,
        directMessages: 2,
        mediaReferences: 1,
        groupConversationsExcluded: 0,
        groupMessagesExcluded: 0,
        otherConversationsExcluded: 0,
        otherMessagesExcluded: 0,
        unmappedDirectConversations: 0,
        startedAt: null,
        endedAt: null,
      },
      state: 'closed',
      departmentCode: 'commercial',
      ownerUsername: null,
      cutoffAt: new Date().toISOString(),
      chunksCompleted: 1,
      conversationsProcessed: 1,
      messagesProcessed: 2,
      errorMessage: null,
      mediaImport: null,
    };
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const started = await service.createAndroidMediaUpload(
      COMPANY_ID,
      COMMAND_ID,
      { originalName: 'Media.zip', sizeBytes: 30 },
    );
    const resumed = await service.createAndroidMediaUpload(
      COMPANY_ID,
      COMMAND_ID,
      { originalName: 'Media.zip', sizeBytes: 30 },
    );
    expect(resumed.uploadId).toBe(started.uploadId);

    const partial = await service.addAndroidMediaUploadChunk(
      COMPANY_ID,
      COMMAND_ID,
      {
        uploadId: started.uploadId,
        offsetBytes: 0,
        content: Buffer.alloc(20, 1),
      },
    );
    expect(partial.uploadedBytes).toBe(20);
    const replayed = await service.addAndroidMediaUploadChunk(
      COMPANY_ID,
      COMMAND_ID,
      {
        uploadId: started.uploadId,
        offsetBytes: 0,
        content: Buffer.alloc(20, 1),
      },
    );
    expect(replayed.uploadedBytes).toBe(20);
    await service.addAndroidMediaUploadChunk(COMPANY_ID, COMMAND_ID, {
      uploadId: started.uploadId,
      offsetBytes: 20,
      content: Buffer.alloc(10, 2),
    });

    androidMediaImporter.attachArchive.mockRejectedValue(
      new Error('falha transitória'),
    );
    const processing = await service.completeAndroidMediaUpload(
      COMPANY_ID,
      COMMAND_ID,
      started.uploadId,
    );
    expect(processing.androidBackup?.mediaImport).toMatchObject({
      status: 'processing',
      uploadBytesReceived: 30,
      uploadBytesTotal: 30,
    });
    await vi.waitFor(async () => {
      const failed = await service.detail(COMPANY_ID, COMMAND_ID);
      expect(failed.androidBackup?.mediaImport).toMatchObject({
        status: 'failed',
        errorMessage:
          'Não foi possível processar o ZIP de mídias. Tente novamente; os arquivos já armazenados serão preservados.',
      });
    });
    await vi.waitFor(() => {
      expect(
        (
          service as unknown as {
            androidMediaJobs: ReadonlySet<string>;
          }
        ).androidMediaJobs.size,
      ).toBe(0);
    });

    const retry = await service.createAndroidMediaUpload(
      COMPANY_ID,
      COMMAND_ID,
      { originalName: 'Media.zip', sizeBytes: 30 },
    );
    expect(retry).toMatchObject({
      uploadId: started.uploadId,
      uploadedBytes: 30,
      status: 'failed',
    });
    androidMediaImporter.attachArchive.mockResolvedValue({
      schemaVersion: '1.0',
      candidates: 1,
      filesScanned: 1,
      attached: 1,
      alreadyStored: 0,
      missing: 0,
      ambiguous: 0,
      skippedOversize: 0,
    });
    await service.completeAndroidMediaUpload(
      COMPANY_ID,
      COMMAND_ID,
      retry.uploadId,
    );
    await vi.waitFor(async () => {
      const completed = await service.detail(COMPANY_ID, COMMAND_ID);
      expect(completed.androidBackup?.mediaImport).toMatchObject({
        status: 'completed',
        stored: 1,
        pending: 0,
      });
    });
    expect(androidMediaImporter.attachArchive).toHaveBeenCalledTimes(2);
  });

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

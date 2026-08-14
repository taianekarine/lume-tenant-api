import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  };
  const config = {
    get: vi.fn((key: string) =>
      key === 'WHATSAPP_IMPORT_ROOT' ? root : undefined,
    ),
  };
  return {
    root,
    prisma,
    service: new WhatsAppHistoryImportService(prisma as never, config as never),
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

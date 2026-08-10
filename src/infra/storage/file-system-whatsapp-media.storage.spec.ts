import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it } from 'vitest';

import { FileSystemWhatsAppMediaStorage } from './file-system-whatsapp-media.storage';

const companyId = '00000000-0000-4000-8000-000000000001';
const conversationId = '00000000-0000-4000-8000-000000000101';
const messageId = '00000000-0000-4000-8000-000000000501';
const sha256 = 'a'.repeat(64);
const storageKey = `v1/${companyId}/${conversationId}/${messageId}/${sha256}`;

const temporaryDirectories: string[] = [];

async function storage(): Promise<FileSystemWhatsAppMediaStorage> {
  const root = await mkdtemp(join(tmpdir(), 'lume-whatsapp-media-'));
  temporaryDirectories.push(root);
  return storageAt(root);
}

function storageAt(root: string): FileSystemWhatsAppMediaStorage {
  return new FileSystemWhatsAppMediaStorage({
    get: (key: string) =>
      key === 'WHATSAPP_MEDIA_STORAGE_PATH' ? root : undefined,
  } as ConfigService);
}

describe('FileSystemWhatsAppMediaStorage', () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('mantém a mídia disponível para uma nova instância da API', async () => {
    const first = await storage();
    const root = temporaryDirectories[0];
    const content = Buffer.from('durable-whatsapp-media');

    await first.write({ storageKey, content });

    const afterRestart = storageAt(root);
    await expect(afterRestart.read(storageKey)).resolves.toEqual(content);
  });

  it('é idempotente e recusa chaves fora do isolamento esperado', async () => {
    const instance = await storage();
    const content = Buffer.from('same-content');

    await instance.write({ storageKey, content });
    await instance.write({ storageKey, content });
    await expect(instance.read(storageKey)).resolves.toEqual(content);
    await expect(instance.read('../../segredo')).rejects.toThrow(
      'Chave de armazenamento',
    );
  });
});

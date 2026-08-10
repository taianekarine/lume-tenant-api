import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  WhatsAppMediaStorage,
  type PersistWhatsAppMediaInput,
} from '../../application/contracts/whatsapp-media.storage';

const UUID_SEGMENT =
  '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const STORAGE_KEY_PATTERN = new RegExp(
  `^v1/${UUID_SEGMENT}/${UUID_SEGMENT}/${UUID_SEGMENT}/[0-9a-f]{64}$`,
  'i',
);

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : null;
}

@Injectable()
export class FileSystemWhatsAppMediaStorage extends WhatsAppMediaStorage {
  private readonly rootPath: string;

  constructor(config: ConfigService) {
    super();
    this.rootPath = resolve(
      config.get<string>('WHATSAPP_MEDIA_STORAGE_PATH') ??
        './var/whatsapp-media',
    );
  }

  async write(input: PersistWhatsAppMediaInput): Promise<void> {
    const destination = this.resolveStorageKey(input.storageKey);
    await mkdir(dirname(destination), { recursive: true });

    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, input.content, { flag: 'wx', mode: 0o600 });
      try {
        await rename(temporary, destination);
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(errorCode(error) ?? '')) throw error;
        const existing = await readFile(destination);
        if (!existing.equals(input.content)) {
          throw new Error('A chave de mídia já contém outro conteúdo.');
        }
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') throw error;
      });
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.resolveStorageKey(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    await unlink(this.resolveStorageKey(storageKey)).catch((error: unknown) => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }

  private resolveStorageKey(storageKey: string): string {
    if (!STORAGE_KEY_PATTERN.test(storageKey)) {
      throw new Error('Chave de armazenamento de mídia inválida.');
    }
    const absolutePath = resolve(this.rootPath, ...storageKey.split('/'));
    if (!absolutePath.startsWith(`${this.rootPath}${sep}`)) {
      throw new Error('Chave de armazenamento fora do diretório permitido.');
    }
    return absolutePath;
  }
}

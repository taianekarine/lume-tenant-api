import {
  createCipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { decryptWhatsAppCrypt15 } from './whatsapp-crypt15';

const temporaryDirectories: string[] = [];

function deriveKey(rootKey: Buffer): Buffer {
  const privateKey = createHmac('sha256', Buffer.alloc(32))
    .update(rootKey)
    .digest();
  return createHmac('sha256', privateKey)
    .update('backup encryption', 'utf8')
    .update(Buffer.from([1]))
    .digest();
}

function crypt15Fixture(content: Buffer, rootKey: Buffer): Buffer {
  const iv = randomBytes(16);
  const c15 = Buffer.concat([Buffer.from([0x0a, 0x10]), iv]);
  const prefix = Buffer.concat([Buffer.from([0x1a, c15.byteLength]), c15]);
  const header = Buffer.concat([
    Buffer.from([prefix.byteLength, 0x01]),
    prefix,
  ]);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(rootKey), iv);
  const encrypted = Buffer.concat([
    cipher.update(deflateSync(content)),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const checksum = createHash('md5')
    .update(header)
    .update(encrypted)
    .update(tag)
    .digest();
  return Buffer.concat([header, encrypted, tag, checksum]);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('decryptWhatsAppCrypt15', () => {
  it('derives the backup key, authenticates and inflates a crypt15 database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lume-crypt15-'));
    temporaryDirectories.push(directory);
    const rootKey = randomBytes(32);
    const sqlite = Buffer.concat([
      Buffer.from('SQLite format 3\0', 'binary'),
      Buffer.alloc(8_192, 0x2a),
    ]);
    const encryptedPath = join(directory, 'msgstore.db.crypt15');
    const outputPath = join(directory, 'msgstore.db');
    await writeFile(encryptedPath, crypt15Fixture(sqlite, rootKey));

    const result = await decryptWhatsAppCrypt15({
      encryptedPath,
      outputPath,
      rootKeyHex: rootKey.toString('hex'),
      maximumOutputBytes: 20_000,
    });

    expect(await readFile(outputPath)).toEqual(sqlite);
    expect(result.multiFileBackup).toBe(false);
    expect(result.decryptedBytes).toBe(sqlite.byteLength);
    expect(result.encryptedSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a wrong key without retaining a partial database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lume-crypt15-'));
    temporaryDirectories.push(directory);
    const sqlite = Buffer.concat([
      Buffer.from('SQLite format 3\0', 'binary'),
      Buffer.alloc(1_024),
    ]);
    const encryptedPath = join(directory, 'msgstore.db.crypt15');
    const outputPath = join(directory, 'msgstore.db');
    await writeFile(encryptedPath, crypt15Fixture(sqlite, randomBytes(32)));

    await expect(
      decryptWhatsAppCrypt15({
        encryptedPath,
        outputPath,
        rootKeyHex: randomBytes(32).toString('hex'),
        maximumOutputBytes: 20_000,
      }),
    ).rejects.toThrow('chave não corresponde');
    await expect(readFile(outputPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('enforces the decompressed database limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lume-crypt15-'));
    temporaryDirectories.push(directory);
    const rootKey = randomBytes(32);
    const sqlite = Buffer.concat([
      Buffer.from('SQLite format 3\0', 'binary'),
      Buffer.alloc(10_000),
    ]);
    const encryptedPath = join(directory, 'msgstore.db.crypt15');
    await writeFile(encryptedPath, crypt15Fixture(sqlite, rootKey));

    await expect(
      decryptWhatsAppCrypt15({
        encryptedPath,
        outputPath: join(directory, 'msgstore.db'),
        rootKeyHex: rootKey.toString('hex'),
        maximumOutputBytes: 1_000,
      }),
    ).rejects.toThrow('excede o limite');
  });
});

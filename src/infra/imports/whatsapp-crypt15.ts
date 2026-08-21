import {
  createDecipheriv,
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflate } from 'node:zlib';

import { validationError } from '../../core/errors/app-error';

const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary');
const CRYPT15_TAG_BYTES = 16;
const CRYPT15_CHECKSUM_BYTES = 16;
const ZERO_SEED = Buffer.alloc(32);

interface ProtobufField {
  fieldNumber: number;
  wireType: number;
  value: Buffer | bigint;
}

export interface DecryptWhatsAppCrypt15Input {
  encryptedPath: string;
  outputPath: string;
  rootKeyHex: string;
  maximumOutputBytes: number;
}

export interface DecryptedWhatsAppCrypt15 {
  outputPath: string;
  encryptedBytes: number;
  decryptedBytes: number;
  encryptedSha256: string;
  multiFileBackup: boolean;
}

function readVarint(
  input: Buffer,
  initialOffset: number,
): { value: bigint; offset: number } {
  let value = 0n;
  let shift = 0n;
  let offset = initialOffset;
  while (offset < input.byteLength && shift <= 63n) {
    const byte = input[offset];
    value |= BigInt(byte & 0x7f) << shift;
    offset += 1;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7n;
  }
  throw validationError('O cabeçalho crypt15 está incompleto.');
}

function protobufFields(input: Buffer): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < input.byteLength) {
    const tag = readVarint(input, offset);
    offset = tag.offset;
    const fieldNumber = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 0x07n);
    if (fieldNumber < 1) {
      throw validationError('O cabeçalho crypt15 possui um campo inválido.');
    }
    if (wireType === 0) {
      const value = readVarint(input, offset);
      offset = value.offset;
      fields.push({ fieldNumber, wireType, value: value.value });
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(input, offset);
      offset = length.offset;
      const byteLength = Number(length.value);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
        throw validationError('O cabeçalho crypt15 possui tamanho inválido.');
      }
      const end = offset + byteLength;
      if (end > input.byteLength) {
        throw validationError('O cabeçalho crypt15 está truncado.');
      }
      fields.push({
        fieldNumber,
        wireType,
        value: input.subarray(offset, end),
      });
      offset = end;
      continue;
    }
    if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw validationError(
        'O cabeçalho crypt15 usa uma codificação não suportada.',
      );
    }
    if (offset > input.byteLength) {
      throw validationError('O cabeçalho crypt15 está truncado.');
    }
  }
  return fields;
}

function parseCrypt15Header(input: Buffer): {
  iv: Buffer;
  encryptedDataOffset: number;
} {
  if (input.byteLength < 4) {
    throw validationError('O arquivo crypt15 está vazio ou incompleto.');
  }
  const protobufLength = input[0];
  const featureFlagBytes = input[1] === 1 ? 1 : 0;
  const protobufStart = 1 + featureFlagBytes;
  const protobufEnd = protobufStart + protobufLength;
  if (protobufLength < 1 || protobufEnd > input.byteLength) {
    throw validationError('O cabeçalho crypt15 está incompleto.');
  }
  const prefixFields = protobufFields(
    input.subarray(protobufStart, protobufEnd),
  );
  const c15 = prefixFields.find(
    (field) => field.fieldNumber === 3 && Buffer.isBuffer(field.value),
  );
  if (!c15 || !Buffer.isBuffer(c15.value)) {
    throw validationError(
      'O arquivo não possui um cabeçalho crypt15 reconhecível.',
    );
  }
  const ivField = protobufFields(c15.value).find(
    (field) => field.fieldNumber === 1 && Buffer.isBuffer(field.value),
  );
  if (
    !ivField ||
    !Buffer.isBuffer(ivField.value) ||
    ivField.value.byteLength !== 16
  ) {
    throw validationError('O vetor de inicialização crypt15 é inválido.');
  }
  return { iv: ivField.value, encryptedDataOffset: protobufEnd };
}

function deriveCrypt15Key(rootKey: Buffer): Buffer {
  const privateKey = createHmac('sha256', ZERO_SEED).update(rootKey).digest();
  return createHmac('sha256', privateKey)
    .update('backup encryption', 'utf8')
    .update(Buffer.from([1]))
    .digest();
}

async function digestFileRange(
  algorithm: 'md5' | 'sha256',
  path: string,
  endInclusive?: number,
): Promise<Buffer> {
  const digest = createHash(algorithm);
  await pipeline(
    createReadStream(
      path,
      endInclusive === undefined ? {} : { end: endInclusive },
    ),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        digest.update(chunk);
        callback();
      },
    }),
  );
  return digest.digest();
}

function outputLimit(maximumOutputBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > maximumOutputBytes) {
        callback(
          validationError(
            'O banco descriptografado excede o limite de segurança.',
          ),
        );
        return;
      }
      callback(null, chunk);
    },
  });
}

async function readRange(
  path: string,
  start: number,
  length: number,
): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const output = Buffer.alloc(length);
    const { bytesRead } = await handle.read(output, 0, length, start);
    if (bytesRead !== length) {
      throw validationError('O arquivo crypt15 está incompleto.');
    }
    return output;
  } finally {
    await handle.close();
  }
}

export async function decryptWhatsAppCrypt15(
  input: DecryptWhatsAppCrypt15Input,
): Promise<DecryptedWhatsAppCrypt15> {
  const normalizedKey = input.rootKeyHex.replace(/\s/g, '');
  if (!/^[0-9a-f]{64}$/i.test(normalizedKey)) {
    throw validationError(
      'A chave crypt15 deve possuir exatamente 64 caracteres hexadecimais.',
    );
  }
  if (
    !Number.isSafeInteger(input.maximumOutputBytes) ||
    input.maximumOutputBytes < 1
  ) {
    throw new Error('maximumOutputBytes deve ser um inteiro positivo.');
  }

  const encryptedPath = resolve(input.encryptedPath);
  const outputPath = resolve(input.outputPath);
  const encryptedStat = await stat(encryptedPath);
  if (
    !encryptedStat.isFile() ||
    encryptedStat.size < 64 ||
    encryptedStat.size > 2_147_483_647
  ) {
    throw validationError('O arquivo crypt15 possui tamanho inválido.');
  }
  const prefix = await readRange(
    encryptedPath,
    0,
    Math.min(encryptedStat.size, 512),
  );
  const header = parseCrypt15Header(prefix);
  if (header.encryptedDataOffset >= encryptedStat.size - CRYPT15_TAG_BYTES) {
    throw validationError('O arquivo crypt15 não contém dados criptografados.');
  }

  const checksum = await readRange(
    encryptedPath,
    encryptedStat.size - CRYPT15_CHECKSUM_BYTES,
    CRYPT15_CHECKSUM_BYTES,
  );
  const calculatedChecksum = await digestFileRange(
    'md5',
    encryptedPath,
    encryptedStat.size - CRYPT15_CHECKSUM_BYTES - 1,
  );
  const multiFileBackup = !timingSafeEqual(checksum, calculatedChecksum);
  const authenticationTagOffset =
    encryptedStat.size -
    (multiFileBackup
      ? CRYPT15_TAG_BYTES
      : CRYPT15_TAG_BYTES + CRYPT15_CHECKSUM_BYTES);
  const authenticationTag = await readRange(
    encryptedPath,
    authenticationTagOffset,
    CRYPT15_TAG_BYTES,
  );
  const encryptedDataEnd = authenticationTagOffset - 1;

  const temporaryOutput = `${outputPath}.${randomUUID()}.tmp`;
  await mkdir(dirname(outputPath), { recursive: true });
  const decipher = createDecipheriv(
    'aes-256-gcm',
    deriveCrypt15Key(Buffer.from(normalizedKey, 'hex')),
    header.iv,
  );
  decipher.setAuthTag(authenticationTag);
  try {
    await pipeline(
      createReadStream(encryptedPath, {
        start: header.encryptedDataOffset,
        end: encryptedDataEnd,
      }),
      decipher,
      createInflate(),
      outputLimit(input.maximumOutputBytes),
      createWriteStream(temporaryOutput, { flags: 'wx', mode: 0o600 }),
    );
    const decryptedHeader = await readRange(
      temporaryOutput,
      0,
      SQLITE_HEADER.byteLength,
    );
    if (!decryptedHeader.equals(SQLITE_HEADER)) {
      throw validationError(
        'O conteúdo descriptografado não é um banco SQLite do WhatsApp.',
      );
    }
    await rename(temporaryOutput, outputPath);
  } catch (error) {
    await rm(temporaryOutput, { force: true });
    if (
      error instanceof Error &&
      /authenticate data|unable to authenticate/i.test(error.message)
    ) {
      throw validationError(
        'A chave não corresponde ao backup crypt15 ou o arquivo está corrompido.',
      );
    }
    throw error;
  }

  const [outputStat, encryptedSha256] = await Promise.all([
    stat(outputPath),
    digestFileRange('sha256', encryptedPath),
  ]);
  return {
    outputPath,
    encryptedBytes: encryptedStat.size,
    decryptedBytes: outputStat.size,
    encryptedSha256: encryptedSha256.toString('hex'),
    multiFileBackup,
  };
}

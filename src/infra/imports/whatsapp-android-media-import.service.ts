import { createHash } from 'node:crypto';
import { opendir, readFile, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';

import { ConfigService } from '@nestjs/config';

import { WhatsAppMediaStorage } from '../../application/contracts/whatsapp-media.storage';
import { validationError } from '../../core/errors/app-error';
import { Prisma } from '../database/prisma/generated/client';
import { PrismaService } from '../database/prisma/prisma.service';
import { WHATSAPP_ANDROID_BACKUP_SOURCE_SYSTEM } from './whatsapp-android-backup';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 2_000;

interface AndroidManifest {
  id: string;
  companyId: string;
  status: string;
  androidBackup?: { chunksCompleted?: number } | null;
}

interface CandidateMessage {
  id: string;
  conversationId: string;
  media: Prisma.JsonValue | null;
  reference: string;
  canonicalPath: string;
  baseName: string;
}

export interface AttachWhatsAppAndroidMediaInput {
  companyId: string;
  batchId: string;
  mediaRoot: string;
}

export interface AttachWhatsAppAndroidMediaResult {
  schemaVersion: '1.0';
  candidates: number;
  filesScanned: number;
  attached: number;
  alreadyStored: number;
  missing: number;
  ambiguous: number;
  skippedOversize: number;
}

function finiteConfig(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const value = config.get<number | string>(key);
  const parsed =
    typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw validationError(`${label} deve ser um UUID válido.`);
  }
}

function deterministicChildBatchId(
  parentBatchId: string,
  index: number,
): string {
  const value = createHash('sha256')
    .update(
      ['whatsapp-android-import', parentBatchId, String(index)].join('\0'),
    )
    .digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(
    13,
    16,
  )}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function mediaReference(value: Prisma.JsonValue | null): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reference = (value as Record<string, unknown>).legacyReference;
  return typeof reference === 'string' &&
    reference.startsWith('whatsapp-android-media://')
    ? reference
    : null;
}

function decodedReference(value: string): string {
  const encoded = value.slice('whatsapp-android-media://'.length);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function normalizedPath(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/^file:\/\//i, '')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLocaleLowerCase('pt-BR');
}

function canonicalMediaPath(value: string): string {
  const normalized = normalizedPath(value);
  const marker = normalized.lastIndexOf('/media/');
  if (marker >= 0) return normalized.slice(marker + 1);
  if (normalized.startsWith('media/')) return normalized;
  return `media/${normalized}`;
}

function mimeType(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return (
    (
      {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.heic': 'image/heic',
        '.ogg': 'audio/ogg',
        '.opus': 'audio/ogg',
        '.mp3': 'audio/mpeg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.wav': 'audio/wav',
        '.mp4': 'video/mp4',
        '.3gp': 'video/3gpp',
        '.mov': 'video/quicktime',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain',
        '.vcf': 'text/vcard',
      } as Record<string, string>
    )[extension] ?? 'application/octet-stream'
  );
}

async function* files(root: string, directory = root): AsyncGenerator<string> {
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      yield* files(root, path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

export class WhatsAppAndroidMediaImportService {
  private readonly importsRoot: string;
  private readonly maximumFileBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: WhatsAppMediaStorage,
    config: ConfigService,
  ) {
    this.importsRoot = resolve(
      config.get<string>('WHATSAPP_IMPORT_ROOT') ??
        resolve(process.cwd(), 'var', 'imports', 'whatsapp'),
    );
    this.maximumFileBytes = finiteConfig(
      config,
      'WHATSAPP_ANDROID_MEDIA_MAX_FILE_BYTES',
      536_870_912,
    );
  }

  async attach(
    input: AttachWhatsAppAndroidMediaInput,
  ): Promise<AttachWhatsAppAndroidMediaResult> {
    assertUuid(input.companyId, 'companyId');
    assertUuid(input.batchId, 'batchId');
    const mediaRoot = resolve(input.mediaRoot);
    const mediaRootStat = await stat(mediaRoot);
    if (!mediaRootStat.isDirectory()) {
      throw validationError('A raiz de mídias deve ser um diretório.');
    }
    const manifestPath = resolve(
      this.importsRoot,
      'history-batches',
      input.companyId,
      input.batchId,
      'manifest.json',
    );
    if (!manifestPath.startsWith(`${this.importsRoot}${sep}`)) {
      throw validationError('O caminho do lote é inválido.');
    }
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as AndroidManifest;
    if (
      manifest.id !== input.batchId ||
      manifest.companyId !== input.companyId ||
      manifest.status !== 'applied' ||
      !manifest.androidBackup?.chunksCompleted
    ) {
      throw validationError(
        'O lote Android precisa estar aplicado antes de vincular mídias.',
      );
    }

    const batchIds = Array.from(
      { length: manifest.androidBackup.chunksCompleted },
      (_, index) => deterministicChildBatchId(input.batchId, index + 1),
    );
    const candidates: CandidateMessage[] = [];
    let cursor: string | undefined;
    let alreadyStored = 0;
    for (;;) {
      const references = await this.prisma.whatsAppImportExternalRef.findMany({
        where: {
          companyId: input.companyId,
          batchId: { in: batchIds },
          entityType: 'message',
          sourceSystem: WHATSAPP_ANDROID_BACKUP_SOURCE_SYSTEM,
        },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, internalId: true },
      });
      if (references.length === 0) break;
      cursor = references.at(-1)?.id;
      const messages = await this.prisma.whatsAppMessage.findMany({
        where: {
          companyId: input.companyId,
          id: { in: references.map((reference) => reference.internalId) },
        },
        select: {
          id: true,
          conversationId: true,
          media: true,
          mediaStorageKey: true,
        },
      });
      for (const message of messages) {
        const reference = mediaReference(message.media);
        if (!reference) continue;
        if (message.mediaStorageKey) {
          alreadyStored += 1;
          continue;
        }
        const decoded = decodedReference(reference);
        candidates.push({
          id: message.id,
          conversationId: message.conversationId,
          media: message.media,
          reference,
          canonicalPath: canonicalMediaPath(decoded),
          baseName: basename(normalizedPath(decoded)),
        });
      }
      if (references.length < PAGE_SIZE) break;
    }

    const byPath = new Map<string, CandidateMessage[]>();
    const byBaseName = new Map<string, CandidateMessage[]>();
    for (const candidate of candidates) {
      byPath.set(candidate.canonicalPath, [
        ...(byPath.get(candidate.canonicalPath) ?? []),
        candidate,
      ]);
      byBaseName.set(candidate.baseName, [
        ...(byBaseName.get(candidate.baseName) ?? []),
        candidate,
      ]);
    }

    let filesScanned = 0;
    let attached = 0;
    let ambiguous = 0;
    let skippedOversize = 0;
    const attachedIds = new Set<string>();
    for await (const filePath of files(mediaRoot)) {
      filesScanned += 1;
      const relativePath = relative(mediaRoot, filePath);
      const canonical = canonicalMediaPath(relativePath);
      const exact = (byPath.get(canonical) ?? []).filter(
        (candidate) => !attachedIds.has(candidate.id),
      );
      const fallback = (
        byBaseName.get(basename(normalizedPath(filePath))) ?? []
      ).filter((candidate) => !attachedIds.has(candidate.id));
      const matches = exact.length > 0 ? exact : fallback;
      if (matches.length !== 1) {
        if (matches.length > 1) ambiguous += 1;
        continue;
      }
      const candidate = matches[0];
      const fileStat = await stat(filePath);
      if (fileStat.size < 1 || fileStat.size > this.maximumFileBytes) {
        skippedOversize += 1;
        continue;
      }
      const content = await readFile(filePath);
      const sha256 = createHash('sha256').update(content).digest('hex');
      const storageKey = [
        'v1',
        input.companyId,
        candidate.conversationId,
        candidate.id,
        sha256,
      ].join('/');
      await this.storage.write({ storageKey, content });
      const currentMedia =
        candidate.media &&
        typeof candidate.media === 'object' &&
        !Array.isArray(candidate.media)
          ? candidate.media
          : {};
      const originalName = basename(filePath).slice(0, 255);
      const detectedMimeType = mimeType(originalName);
      await this.prisma.whatsAppMessage.updateMany({
        where: {
          id: candidate.id,
          companyId: input.companyId,
          conversationId: candidate.conversationId,
          mediaStorageKey: null,
        },
        data: {
          media: {
            ...currentMedia,
            fileName: originalName,
            mimeType: detectedMimeType,
            size: content.byteLength,
            retentionStatus: 'stored',
          },
          mediaStorageKey: storageKey,
          mediaMimeType: detectedMimeType,
          mediaSizeBytes: content.byteLength,
          mediaOriginalName: originalName,
          mediaSha256: sha256,
          mediaStoredAt: new Date(),
        },
      });
      attachedIds.add(candidate.id);
      attached += 1;
    }

    return {
      schemaVersion: '1.0',
      candidates: candidates.length,
      filesScanned,
      attached,
      alreadyStored,
      missing: candidates.length - attachedIds.size,
      ambiguous,
      skippedOversize,
    };
  }
}

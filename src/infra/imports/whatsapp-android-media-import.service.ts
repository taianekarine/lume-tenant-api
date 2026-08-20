import { createHash } from 'node:crypto';
import { opendir, readFile, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import { WhatsAppMediaStorage } from '../../application/contracts/whatsapp-media.storage';
import { validationError } from '../../core/errors/app-error';
import { MessageKind, Prisma } from '../database/prisma/generated/client';
import { PrismaService } from '../database/prisma/prisma.service';
import { WHATSAPP_ANDROID_BACKUP_SOURCE_SYSTEM } from './whatsapp-android-backup';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 2_000;

interface AndroidManifest {
  id: string;
  companyId: string;
  channelId: string;
  status: string;
  androidBackup?: object | null;
}

interface CandidateMessage {
  id: string;
  conversationId: string;
  media: Prisma.JsonValue | null;
  reference: string;
  canonicalPath: string;
  baseName: string;
  contentSha256: string | null;
}

export interface AttachWhatsAppAndroidMediaInput {
  companyId: string;
  batchId: string;
  mediaRoot: string;
}

export interface AttachWhatsAppAndroidMediaArchiveInput {
  companyId: string;
  batchId: string;
  archivePath: string;
  originalName: string;
  sizeBytes: number;
  onProgress?: (progress: AttachWhatsAppAndroidMediaProgress) => Promise<void>;
}

export type ValidateWhatsAppAndroidMediaArchiveInput = Pick<
  AttachWhatsAppAndroidMediaArchiveInput,
  'archivePath' | 'originalName' | 'sizeBytes'
>;

export interface AttachWhatsAppAndroidMediaProgress {
  phase: 'scanning' | 'storing';
  filesScanned: number;
  filesTotal: number;
  filesProcessed: number;
  attached: number;
  ambiguous: number;
  skippedOversize: number;
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

export interface PreviewWhatsAppAndroidMediaReference {
  id: string;
  reference: string;
  stored: boolean;
}

export interface PreviewWhatsAppAndroidMediaResult {
  filesTotal: number;
  mediaStored: number;
  mediaNew: number;
  mediaMissing: number;
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

function mediaReference(value: Prisma.JsonValue | null): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const reference = (value as Record<string, unknown>).legacyReference;
  return typeof reference === 'string' &&
    reference.startsWith('whatsapp-android-media://')
    ? reference
    : null;
}

function decodedReference(value: string): string {
  const encoded = value
    .slice('whatsapp-android-media://'.length)
    .split('#sha256=', 1)[0];
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function referenceSha256(value: string): string | null {
  const match = /#sha256=([0-9a-f]{64})$/i.exec(value);
  return match?.[1]?.toLowerCase() ?? null;
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
        '.ppt': 'application/vnd.ms-powerpoint',
        '.pptx':
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.odt': 'application/vnd.oasis.opendocument.text',
        '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
        '.csv': 'text/csv',
        '.rtf': 'application/rtf',
        '.zip': 'application/zip',
        '.rar': 'application/vnd.rar',
        '.7z': 'application/x-7z-compressed',
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

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(
      path,
      {
        autoClose: false,
        lazyEntries: true,
        validateEntrySizes: true,
      },
      (error, archive) => {
        if (error || !archive) {
          reject(error ?? new Error('ZIP não pôde ser aberto.'));
          return;
        }
        resolvePromise(archive);
      },
    );
  });
}

function nextZipEntry(archive: ZipFile): Promise<Entry | null> {
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      archive.removeListener('entry', onEntry);
      archive.removeListener('end', onEnd);
      archive.removeListener('error', onError);
    };
    const onEntry = (entry: Entry) => {
      cleanup();
      resolvePromise(entry);
    };
    const onEnd = () => {
      cleanup();
      resolvePromise(null);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    archive.on('entry', onEntry);
    archive.once('end', onEnd);
    archive.once('error', onError);
    archive.readEntry();
  });
}

async function* zipEntries(archive: ZipFile): AsyncGenerator<Entry> {
  for (;;) {
    const entry = await nextZipEntry(archive);
    if (!entry) return;
    yield entry;
  }
}

function entryStream(archive: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolvePromise, reject) => {
    archive.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('Item do ZIP não pôde ser lido.'));
        return;
      }
      resolvePromise(stream);
    });
  });
}

async function readEntry(
  archive: ZipFile,
  entry: Entry,
  maximumBytes: number,
): Promise<Buffer> {
  const stream = await entryStream(archive, entry);
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on('data', (chunk: Buffer | Uint8Array) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maximumBytes) {
        stream.destroy(
          validationError('Uma mídia do ZIP excede o limite permitido.'),
        );
        return;
      }
      chunks.push(buffer);
    });
    stream.once('end', () => resolvePromise(Buffer.concat(chunks, total)));
    stream.once('error', reject);
  });
}

function unsafeZipEntry(entry: Entry): boolean {
  const normalized = entry.fileName.replace(/\\/g, '/');
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const isSymbolicLink = (unixMode & 0o170000) === 0o120000;
  return (
    entry.isEncrypted() ||
    isSymbolicLink ||
    normalized.startsWith('/') ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split('/').includes('..')
  );
}

@Injectable()
export class WhatsAppAndroidMediaImportService {
  private readonly importsRoot: string;
  private readonly maximumFileBytes: number;
  private readonly maximumArchiveBytes: number;
  private readonly maximumArchiveEntries: number;
  private readonly maximumUncompressedBytes: number;
  private readonly archiveConcurrency: number;

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
    this.maximumArchiveBytes = finiteConfig(
      config,
      'WHATSAPP_ANDROID_MEDIA_ARCHIVE_MAX_BYTES',
      8_589_934_592,
    );
    this.maximumArchiveEntries = finiteConfig(
      config,
      'WHATSAPP_ANDROID_MEDIA_ARCHIVE_MAX_ENTRIES',
      250_000,
    );
    this.maximumUncompressedBytes = finiteConfig(
      config,
      'WHATSAPP_ANDROID_MEDIA_ARCHIVE_MAX_UNCOMPRESSED_BYTES',
      17_179_869_184,
    );
    this.archiveConcurrency = Math.min(
      8,
      finiteConfig(config, 'WHATSAPP_ANDROID_MEDIA_ARCHIVE_CONCURRENCY', 4),
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
    const loaded = await this.loadCandidates(input.companyId, input.batchId);
    const candidates = loaded.candidates;
    const alreadyStored = loaded.alreadyStored;

    const byPath = new Map<string, CandidateMessage[]>();
    const byBaseName = new Map<string, CandidateMessage[]>();
    const byHash = new Map<string, CandidateMessage[]>();
    for (const candidate of candidates) {
      byPath.set(candidate.canonicalPath, [
        ...(byPath.get(candidate.canonicalPath) ?? []),
        candidate,
      ]);
      byBaseName.set(candidate.baseName, [
        ...(byBaseName.get(candidate.baseName) ?? []),
        candidate,
      ]);
      if (candidate.contentSha256) {
        byHash.set(candidate.contentSha256, [
          ...(byHash.get(candidate.contentSha256) ?? []),
          candidate,
        ]);
      }
    }

    let filesScanned = 0;
    let attached = 0;
    let ambiguous = 0;
    let skippedOversize = 0;
    const attachedIds = new Set<string>();
    for await (const filePath of files(mediaRoot)) {
      filesScanned += 1;
      const relativePath = relative(mediaRoot, filePath);
      const fileStat = await stat(filePath);
      if (fileStat.size < 1 || fileStat.size > this.maximumFileBytes) {
        skippedOversize += 1;
        continue;
      }
      const content = await readFile(filePath);
      const sha256 = createHash('sha256').update(content).digest('hex');
      const matched = this.matchCandidates(
        relativePath,
        sha256,
        byPath,
        byBaseName,
        byHash,
        attachedIds,
      );
      if (matched.ambiguous) ambiguous += 1;
      for (const candidate of matched.candidates) {
        const stored = await this.storeCandidate(
          input.companyId,
          candidate,
          basename(filePath),
          content,
          sha256,
        );
        if (stored) {
          attachedIds.add(candidate.id);
          attached += 1;
        }
      }
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

  async validateArchive(
    input: ValidateWhatsAppAndroidMediaArchiveInput,
  ): Promise<{ filesTotal: number }> {
    if (!input.originalName.toLocaleLowerCase('pt-BR').endsWith('.zip')) {
      throw validationError('Selecione um arquivo ZIP da pasta Media.');
    }
    const archivePath = resolve(input.archivePath);
    const archiveStat = await stat(archivePath);
    if (
      !archiveStat.isFile() ||
      archiveStat.size !== input.sizeBytes ||
      archiveStat.size < 22 ||
      archiveStat.size > this.maximumArchiveBytes
    ) {
      throw validationError('O arquivo ZIP de mídias possui tamanho inválido.');
    }
    let archive: ZipFile | null = null;
    try {
      archive = await openZip(archivePath);
      let filesTotal = 0;
      let declaredUncompressedBytes = 0;
      for await (const entry of zipEntries(archive)) {
        if (entry.fileName.endsWith('/')) continue;
        filesTotal += 1;
        if (filesTotal > this.maximumArchiveEntries) {
          throw validationError(
            `Cada ZIP deve conter entre 1 e ${this.maximumArchiveEntries} arquivos.`,
          );
        }
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0
        ) {
          throw validationError('O ZIP possui um item com tamanho inválido.');
        }
        declaredUncompressedBytes += entry.uncompressedSize;
        if (declaredUncompressedBytes > this.maximumUncompressedBytes) {
          throw validationError(
            'O conteúdo descompactado excede o limite seguro por arquivo ZIP.',
          );
        }
        if (unsafeZipEntry(entry)) {
          throw validationError('O ZIP contém um caminho de arquivo inseguro.');
        }
      }
      if (filesTotal < 1) {
        throw validationError('O ZIP deve conter pelo menos um arquivo.');
      }
      return { filesTotal };
    } catch (error) {
      if ((error as { code?: string }).code === 'VALIDATION_ERROR') throw error;
      throw validationError('O arquivo ZIP de mídias está corrompido.');
    } finally {
      archive?.close();
    }
  }

  async previewArchive(
    input: ValidateWhatsAppAndroidMediaArchiveInput,
    references: readonly PreviewWhatsAppAndroidMediaReference[],
  ): Promise<PreviewWhatsAppAndroidMediaResult> {
    if (!input.originalName.toLocaleLowerCase('pt-BR').endsWith('.zip')) {
      throw validationError('Selecione um arquivo ZIP da pasta Media.');
    }
    const archivePath = resolve(input.archivePath);
    const archiveStat = await stat(archivePath);
    if (
      !archiveStat.isFile() ||
      archiveStat.size !== input.sizeBytes ||
      archiveStat.size < 22 ||
      archiveStat.size > this.maximumArchiveBytes
    ) {
      throw validationError('O arquivo ZIP de mídias possui tamanho inválido.');
    }
    const uniqueReferences = new Map(
      references
        .filter((item) =>
          item.reference.startsWith('whatsapp-android-media://'),
        )
        .map((item) => [item.id, item]),
    );
    const pending = [...uniqueReferences.values()].filter(
      (item) => !item.stored,
    );
    const byPath = new Map<string, PreviewWhatsAppAndroidMediaReference[]>();
    const byBaseName = new Map<
      string,
      PreviewWhatsAppAndroidMediaReference[]
    >();
    for (const item of pending) {
      const decoded = decodedReference(item.reference);
      const path = canonicalMediaPath(decoded);
      const name = basename(normalizedPath(decoded));
      byPath.set(path, [...(byPath.get(path) ?? []), item]);
      byBaseName.set(name, [...(byBaseName.get(name) ?? []), item]);
    }

    const matched = new Set<string>();
    let filesTotal = 0;
    let declaredUncompressedBytes = 0;
    let archive: ZipFile | null = null;
    try {
      archive = await openZip(archivePath);
      for await (const entry of zipEntries(archive)) {
        if (entry.fileName.endsWith('/')) continue;
        filesTotal += 1;
        if (filesTotal > this.maximumArchiveEntries) {
          throw validationError(
            `Cada ZIP deve conter entre 1 e ${this.maximumArchiveEntries} arquivos.`,
          );
        }
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0
        ) {
          throw validationError('O ZIP possui um item com tamanho inválido.');
        }
        declaredUncompressedBytes += entry.uncompressedSize;
        if (declaredUncompressedBytes > this.maximumUncompressedBytes) {
          throw validationError(
            'O conteúdo descompactado excede o limite seguro por arquivo ZIP.',
          );
        }
        if (unsafeZipEntry(entry)) {
          throw validationError('O ZIP contém um caminho de arquivo inseguro.');
        }
        const exact = (
          byPath.get(canonicalMediaPath(entry.fileName)) ?? []
        ).filter((item) => !matched.has(item.id));
        if (exact.length > 0) {
          exact.forEach((item) => matched.add(item.id));
          continue;
        }
        const fallback = (
          byBaseName.get(basename(normalizedPath(entry.fileName))) ?? []
        ).filter((item) => !matched.has(item.id));
        if (fallback.length === 1) matched.add(fallback[0].id);
      }
      if (filesTotal < 1) {
        throw validationError('O ZIP deve conter pelo menos um arquivo.');
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'VALIDATION_ERROR') throw error;
      throw validationError('O arquivo ZIP de mídias está corrompido.');
    } finally {
      archive?.close();
    }

    const mediaStored = [...uniqueReferences.values()].filter(
      (item) => item.stored,
    ).length;
    return {
      filesTotal,
      mediaStored,
      mediaNew: matched.size,
      mediaMissing: Math.max(
        0,
        uniqueReferences.size - mediaStored - matched.size,
      ),
    };
  }

  async attachArchive(
    input: AttachWhatsAppAndroidMediaArchiveInput,
  ): Promise<AttachWhatsAppAndroidMediaResult> {
    assertUuid(input.companyId, 'companyId');
    assertUuid(input.batchId, 'batchId');
    if (!input.originalName.toLocaleLowerCase('pt-BR').endsWith('.zip')) {
      throw validationError('Selecione um arquivo ZIP da pasta Media.');
    }
    const archivePath = resolve(input.archivePath);
    const archiveStat = await stat(archivePath);
    if (
      !archiveStat.isFile() ||
      archiveStat.size !== input.sizeBytes ||
      archiveStat.size < 22 ||
      archiveStat.size > this.maximumArchiveBytes
    ) {
      throw validationError('O arquivo ZIP de mídias possui tamanho inválido.');
    }
    let archive: ZipFile | null = null;
    let processingArchive: ZipFile | null = null;
    try {
      archive = await openZip(archivePath);
      let filesTotal = 0;
      let declaredUncompressedBytes = 0;
      const archivePaths = new Set<string>();
      const archiveBaseNames = new Set<string>();
      for await (const entry of zipEntries(archive)) {
        if (entry.fileName.endsWith('/')) continue;
        filesTotal += 1;
        if (filesTotal > this.maximumArchiveEntries) {
          throw validationError(
            `Cada ZIP deve conter entre 1 e ${this.maximumArchiveEntries} arquivos.`,
          );
        }
        if (
          !Number.isSafeInteger(entry.uncompressedSize) ||
          entry.uncompressedSize < 0
        ) {
          throw validationError('O ZIP possui um item com tamanho inválido.');
        }
        declaredUncompressedBytes += entry.uncompressedSize;
        if (declaredUncompressedBytes > this.maximumUncompressedBytes) {
          throw validationError(
            'O conteúdo descompactado excede o limite seguro por arquivo ZIP.',
          );
        }
        if (unsafeZipEntry(entry)) {
          throw validationError('O ZIP contém um caminho de arquivo inseguro.');
        }
        archivePaths.add(canonicalMediaPath(entry.fileName));
        archiveBaseNames.add(basename(normalizedPath(entry.fileName)));
      }
      if (filesTotal < 1) {
        throw validationError('O ZIP deve conter pelo menos um arquivo.');
      }
      archive.close();
      archive = null;

      const loaded = await this.loadCandidates(input.companyId, input.batchId);
      await input.onProgress?.({
        phase: 'scanning',
        filesScanned: 0,
        filesTotal,
        filesProcessed: 0,
        attached: 0,
        ambiguous: 0,
        skippedOversize: 0,
      });
      const byPath = new Map<string, CandidateMessage[]>();
      const byBaseName = new Map<string, CandidateMessage[]>();
      const byHash = new Map<string, CandidateMessage[]>();
      for (const candidate of loaded.candidates) {
        byPath.set(candidate.canonicalPath, [
          ...(byPath.get(candidate.canonicalPath) ?? []),
          candidate,
        ]);
        byBaseName.set(candidate.baseName, [
          ...(byBaseName.get(candidate.baseName) ?? []),
          candidate,
        ]);
        if (candidate.contentSha256) {
          byHash.set(candidate.contentSha256, [
            ...(byHash.get(candidate.contentSha256) ?? []),
            candidate,
          ]);
        }
      }
      const hashFallbackCandidateIds = new Set(
        loaded.candidates
          .filter(
            (candidate) =>
              candidate.contentSha256 &&
              !archivePaths.has(candidate.canonicalPath) &&
              !archiveBaseNames.has(candidate.baseName),
          )
          .map((candidate) => candidate.id),
      );
      const reservedIds = new Set<string>();
      let ambiguous = 0;
      let skippedOversize = 0;
      let filesScanned = 0;
      let filesProcessed = 0;
      let attached = 0;
      let batchBytes = 0;
      let lastReportedProcessed = 0;
      let lastReportedAt = Date.now();
      const batch: {
        candidates: CandidateMessage[];
        fileName: string;
        content: Buffer;
        sha256: string;
      }[] = [];
      const reportStorageProgress = async (force = false) => {
        const now = Date.now();
        if (
          !force &&
          filesProcessed - lastReportedProcessed < 250 &&
          now - lastReportedAt < 1_000
        ) {
          return;
        }
        lastReportedProcessed = filesProcessed;
        lastReportedAt = now;
        await input.onProgress?.({
          phase: 'storing',
          filesScanned,
          filesTotal,
          filesProcessed,
          attached,
          ambiguous,
          skippedOversize,
        });
      };
      const flush = async () => {
        if (batch.length === 0) return;
        const results = await Promise.all(
          batch.map(async (job) => {
            const stored = await Promise.all(
              job.candidates.map((candidate) =>
                this.storeCandidate(
                  input.companyId,
                  candidate,
                  job.fileName,
                  job.content,
                  job.sha256,
                ),
              ),
            );
            return stored.filter(Boolean).length;
          }),
        );
        attached += results.reduce((total, count) => total + count, 0);
        filesProcessed += results.length;
        batch.length = 0;
        batchBytes = 0;
        await reportStorageProgress();
      };

      processingArchive = await openZip(archivePath);
      for await (const entry of zipEntries(processingArchive)) {
        if (entry.fileName.endsWith('/')) continue;
        filesScanned += 1;
        if (
          input.onProgress &&
          (filesScanned === 1 || filesScanned % 1_000 === 0)
        ) {
          await input.onProgress({
            phase: 'scanning',
            filesScanned,
            filesTotal,
            filesProcessed,
            attached,
            ambiguous,
            skippedOversize,
          });
        }
        if (
          entry.uncompressedSize < 1 ||
          entry.uncompressedSize > this.maximumFileBytes
        ) {
          skippedOversize += 1;
          continue;
        }
        const entryPath = canonicalMediaPath(entry.fileName);
        const entryBaseName = basename(normalizedPath(entry.fileName));
        const hasPathCandidate = (byPath.get(entryPath) ?? []).some(
          (candidate) => !reservedIds.has(candidate.id),
        );
        const hasNameCandidate = (byBaseName.get(entryBaseName) ?? []).some(
          (candidate) => !reservedIds.has(candidate.id),
        );
        if (
          !hasPathCandidate &&
          !hasNameCandidate &&
          hashFallbackCandidateIds.size === 0
        ) {
          continue;
        }
        const content = await readEntry(
          processingArchive,
          entry,
          this.maximumFileBytes,
        );
        if (content.byteLength < 1) continue;
        const sha256 = createHash('sha256').update(content).digest('hex');
        const matched = this.matchCandidates(
          entry.fileName,
          sha256,
          byPath,
          byBaseName,
          byHash,
          reservedIds,
        );
        if (matched.ambiguous) ambiguous += 1;
        if (matched.candidates.length === 0) continue;
        matched.candidates.forEach((candidate) =>
          reservedIds.add(candidate.id),
        );
        matched.candidates.forEach((candidate) =>
          hashFallbackCandidateIds.delete(candidate.id),
        );
        if (
          batch.length > 0 &&
          (batch.length >= this.archiveConcurrency ||
            batchBytes + entry.uncompressedSize > this.maximumFileBytes)
        ) {
          await flush();
        }
        batch.push({
          candidates: matched.candidates,
          fileName: basename(entry.fileName),
          content,
          sha256,
        });
        batchBytes += content.byteLength;
      }
      await flush();
      await reportStorageProgress(true);

      return {
        schemaVersion: '1.0',
        candidates: loaded.candidates.length,
        filesScanned,
        attached,
        alreadyStored: loaded.alreadyStored,
        missing: Math.max(0, loaded.candidates.length - attached),
        ambiguous,
        skippedOversize,
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'VALIDATION_ERROR') throw error;
      throw validationError('O arquivo ZIP de mídias está corrompido.');
    } finally {
      archive?.close();
      processingArchive?.close();
    }
  }

  private async loadCandidates(companyId: string, batchId: string) {
    const manifestPath = resolve(
      this.importsRoot,
      'history-batches',
      companyId,
      batchId,
      'manifest.json',
    );
    if (!manifestPath.startsWith(`${this.importsRoot}${sep}`)) {
      throw validationError('O caminho do lote é inválido.');
    }
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as AndroidManifest;
    if (
      manifest.id !== batchId ||
      manifest.companyId !== companyId ||
      manifest.status !== 'applied' ||
      !manifest.androidBackup
    ) {
      throw validationError(
        'O lote Android precisa estar aplicado antes de vincular mídias.',
      );
    }

    const candidates: CandidateMessage[] = [];
    let cursor: string | undefined;
    let alreadyStored = 0;
    for (;;) {
      const references = await this.prisma.whatsAppImportExternalRef.findMany({
        where: {
          companyId,
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
          companyId,
          channelId: manifest.channelId,
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
          contentSha256: referenceSha256(reference),
        });
      }
      if (references.length < PAGE_SIZE) break;
    }
    return { candidates, alreadyStored };
  }

  private matchCandidates(
    path: string,
    contentSha256: string,
    byPath: ReadonlyMap<string, CandidateMessage[]>,
    byBaseName: ReadonlyMap<string, CandidateMessage[]>,
    byHash: ReadonlyMap<string, CandidateMessage[]>,
    excludedIds: ReadonlySet<string>,
  ): { candidates: CandidateMessage[]; ambiguous: boolean } {
    const exact = (byPath.get(canonicalMediaPath(path)) ?? []).filter(
      (candidate) =>
        !excludedIds.has(candidate.id) &&
        (!candidate.contentSha256 || candidate.contentSha256 === contentSha256),
    );
    const hashes = (byHash.get(contentSha256) ?? []).filter(
      (candidate) => !excludedIds.has(candidate.id),
    );
    const identified = new Map(
      [...exact, ...hashes].map((candidate) => [candidate.id, candidate]),
    );
    if (identified.size > 0) {
      return { candidates: [...identified.values()], ambiguous: false };
    }
    const fallback = (
      byBaseName.get(basename(normalizedPath(path))) ?? []
    ).filter(
      (candidate) =>
        !excludedIds.has(candidate.id) &&
        (!candidate.contentSha256 || candidate.contentSha256 === contentSha256),
    );
    return {
      candidates: fallback.length === 1 ? fallback : [],
      ambiguous: fallback.length > 1,
    };
  }

  private async storeCandidate(
    companyId: string,
    candidate: CandidateMessage,
    fileName: string,
    content: Buffer,
    knownSha256?: string,
  ): Promise<boolean> {
    const sha256 =
      knownSha256 ?? createHash('sha256').update(content).digest('hex');
    const storageKey = [
      'v1',
      companyId,
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
    const originalName = basename(fileName).slice(0, 255);
    const sourceMimeType = currentMedia.mimeType;
    const detectedMimeType =
      typeof sourceMimeType === 'string' && sourceMimeType.includes('/')
        ? sourceMimeType
        : mimeType(originalName);
    const detectedKind = detectedMimeType.startsWith('image/')
      ? MessageKind.IMAGE
      : detectedMimeType.startsWith('audio/')
        ? MessageKind.AUDIO
        : detectedMimeType.startsWith('video/')
          ? MessageKind.VIDEO
          : detectedMimeType === 'text/vcard' ||
              detectedMimeType === 'text/x-vcard'
            ? MessageKind.CONTACT
            : MessageKind.DOCUMENT;
    const updated = await this.prisma.whatsAppMessage.updateMany({
      where: {
        id: candidate.id,
        companyId,
        conversationId: candidate.conversationId,
        mediaStorageKey: null,
      },
      data: {
        kind: detectedKind,
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
    if (updated.count === 0) {
      const current = await this.prisma.whatsAppMessage.findUnique({
        where: {
          id_companyId: {
            id: candidate.id,
            companyId,
          },
        },
        select: { mediaStorageKey: true },
      });
      if (current?.mediaStorageKey !== storageKey) {
        await this.storage.delete(storageKey);
      }
      return false;
    }
    return true;
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import JSZip from 'jszip';

import { WhatsAppMediaStorage } from '../../application/contracts/whatsapp-media.storage';
import {
  conflict,
  notFound,
  validationError,
} from '../../core/errors/app-error';
import {
  DeliveryStatus,
  MessageDirection,
  MessageKind,
  Prisma,
} from '../database/prisma/generated/client';
import { PrismaService } from '../database/prisma/prisma.service';
import {
  inspectWhatsAppAndroidBackup,
  readWhatsAppAndroidBackup,
  type WhatsAppAndroidBackupSummary,
} from './whatsapp-android-backup';
import {
  type PreviewWhatsAppAndroidMediaReference,
  WhatsAppAndroidMediaImportService,
} from './whatsapp-android-media-import.service';
import { decryptWhatsAppCrypt15 } from './whatsapp-crypt15';
import {
  DEFAULT_WHATSAPP_EXPORT_LIMITS,
  normalizeBrazilianPhone,
  parseWhatsAppExportArchive,
  WHATSAPP_EXPORT_SOURCE_SYSTEM,
  type ParsedWhatsAppExport,
  type WhatsAppExportMessage,
  type WhatsAppExportMessageKind,
  type WhatsAppExportParserLimits,
} from './whatsapp-export-parser';
import {
  createWhatsAppImportWorkbook,
  identifyWhatsAppExportMessages,
  WHATSAPP_HISTORY_STATE_OPTIONS,
  type WhatsAppHistoryConversationMapping,
  type WhatsAppHistoryStateOption,
} from './whatsapp-export-workbook';
import {
  importedMediaMetadata,
  isTransactionWriteConflict,
  WhatsAppImportService,
} from './whatsapp-import.service';
import { importPayloadHash } from './whatsapp-import-package';
import { emptyImportCounts } from './whatsapp-import.types';

const MANIFEST_VERSION = '1.0';
const MANIFEST_FILE = 'manifest.json';
const ANDROID_DIVERGENCES_FILE = 'message-divergences.json';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMPORT_DEPARTMENTS = new Set([
  'commercial',
  'purchasing',
  'controlling',
  'personnel-department',
  'financial',
  'management',
  'maintenance',
  'monitoring',
  'operations',
]);
const EXTERNAL_REFERENCE_CHUNK_SIZE = 1_000;

export async function ensureImportWorkbookArtifact(
  workbookPath: string,
  generate: () => Promise<Buffer>,
): Promise<void> {
  try {
    if ((await stat(workbookPath)).isFile()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFile(workbookPath, await generate(), { mode: 0o600 });
}

const MESSAGE_KIND_BY_EXPORT = {
  text: MessageKind.TEXT,
  image: MessageKind.IMAGE,
  document: MessageKind.DOCUMENT,
  audio: MessageKind.AUDIO,
  video: MessageKind.VIDEO,
  sticker: MessageKind.STICKER,
  location: MessageKind.LOCATION,
  contact: MessageKind.CONTACT,
  unknown: MessageKind.UNKNOWN,
} as const;

const MESSAGE_DIRECTION_BY_IMPORT = {
  inbound: MessageDirection.INBOUND,
  outbound: MessageDirection.OUTBOUND,
} as const;

const DELIVERY_STATUS_BY_IMPORT = {
  received: DeliveryStatus.RECEIVED,
  pending: DeliveryStatus.PENDING,
  sent: DeliveryStatus.SENT,
  delivered: DeliveryStatus.DELIVERED,
  read: DeliveryStatus.READ,
  failed: DeliveryStatus.FAILED,
} as const;

const MESSAGE_KIND_TO_EXPORT: Record<MessageKind, WhatsAppExportMessageKind> = {
  [MessageKind.TEXT]: 'text',
  [MessageKind.IMAGE]: 'image',
  [MessageKind.DOCUMENT]: 'document',
  [MessageKind.AUDIO]: 'audio',
  [MessageKind.VIDEO]: 'video',
  [MessageKind.STICKER]: 'sticker',
  [MessageKind.LOCATION]: 'location',
  [MessageKind.CONTACT]: 'contact',
  [MessageKind.UNKNOWN]: 'unknown',
};

const DELIVERY_STATUS_TO_IMPORT: Record<
  DeliveryStatus,
  StoredAndroidDivergenceMessage['deliveryStatus']
> = {
  [DeliveryStatus.RECEIVED]: 'received',
  [DeliveryStatus.PENDING]: 'pending',
  [DeliveryStatus.SENT]: 'sent',
  [DeliveryStatus.DELIVERED]: 'delivered',
  [DeliveryStatus.READ]: 'read',
  [DeliveryStatus.FAILED]: 'failed',
};

type AndroidDivergenceResolution = 'keep-existing' | 'use-backup';

interface StoredAndroidDivergenceMessage {
  direction: 'inbound' | 'outbound';
  deliveryStatus:
    'received' | 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  kind: WhatsAppExportMessageKind;
  text: string | null;
  occurredAt: string;
  mediaReference: string | null;
  payloadHash: string;
}

interface StoredAndroidDivergence {
  externalMessageId: string;
  internalMessageId: string;
  externalConversationId: string;
  contactName: string | null;
  phoneE164: string | null;
  senderName: string | null;
  existing: StoredAndroidDivergenceMessage;
  backup: StoredAndroidDivergenceMessage;
  resolution: AndroidDivergenceResolution | null;
  decidedByUserId: string | null;
  decidedByUsername: string | null;
  decidedAt: string | null;
}

interface StoredArchive {
  archiveId: string;
  archiveName: string;
  archiveSha256: string;
  storageFileName: string;
  chatFileName: string;
  suggestedContactName: string | null;
  suggestedPhoneE164: string | null;
  senders: readonly { name: string; messageCount: number }[];
  messageCount: number;
  attachmentCount: number;
  missingAttachmentCount: number;
  startedAt: string | null;
  endedAt: string | null;
  mapping: WhatsAppHistoryConversationMapping | null;
}

interface StoredAndroidBackup {
  databaseFileName: string;
  databaseSha256: string;
  encryptedBytes: number;
  decryptedBytes: number;
  multiFileBackup: boolean;
  summary: WhatsAppAndroidBackupSummary;
  state: WhatsAppHistoryStateOption;
  departmentCode: string;
  ownerUsername: string | null;
  cutoffAt: string | null;
  chunksCompleted: number;
  conversationsProcessed: number;
  messagesProcessed: number;
  processingPhase?: 'messages' | 'finalizing' | null;
  errorMessage: string | null;
  comparison?: {
    status: 'processing' | 'ready' | 'failed';
    messagesProcessed?: number;
    messagesTotal?: number;
    messagesExisting: number;
    messagesNew: number;
    messagesDivergent: number;
    messagesDivergentPending?: number;
    mediaStored: number;
    mediaNew: number;
    mediaMissing: number;
    updatedAt: string;
    errorMessage: string | null;
  } | null;
  mediaImport?: {
    archivesProcessed: number;
    filesScanned: number;
    stored: number;
    pending: number;
    ambiguous: number;
    skippedOversize: number;
    updatedAt: string;
    lastArchiveName: string;
    status?:
      | 'uploading'
      | 'validating'
      | 'ready'
      | 'processing'
      | 'completed'
      | 'failed';
    phase?: 'uploading' | 'scanning' | 'storing' | null;
    uploadId?: string | null;
    uploadBytesReceived?: number;
    uploadBytesTotal?: number;
    processingFilesScanned?: number;
    processingFilesTotal?: number;
    processingFilesProcessed?: number;
    processingAttached?: number;
    errorMessage?: string | null;
  } | null;
}

interface StoredAndroidMediaUpload {
  schemaVersion: '1.0';
  uploadId: string;
  companyId: string;
  batchId: string;
  originalName: string;
  expectedBytes: number;
  receivedBytes: number;
  status:
    | 'uploading'
    | 'validating'
    | 'ready'
    | 'processing'
    | 'completed'
    | 'failed';
  createdAt: string;
  updatedAt: string;
  fingerprint?: string;
  checksumSha256?: string | null;
}

interface StoredAndroidDatabaseUpload {
  schemaVersion: '1.0';
  uploadId: string;
  companyId: string;
  batchId: string;
  originalName: string;
  expectedBytes: number;
  receivedBytes: number;
  status: 'uploading' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  errorMessage: string | null;
  fingerprint?: string;
  checksumSha256?: string | null;
}

export interface StoredImportError {
  code: string;
  message: string;
  retryable: boolean;
  occurredAt: string;
}

interface StoredManifest {
  schemaVersion: typeof MANIFEST_VERSION;
  id: string;
  companyId: string;
  channelId: string;
  channelName: string;
  channelPhoneE164: string;
  actorUserId: string;
  actorUsername: string;
  status: 'draft' | 'applying' | 'applied' | 'failed' | 'cancelled' | 'expired';
  phase?: string | null;
  heartbeatAt?: string | null;
  attempts?: number;
  lastError?: StoredImportError | null;
  cancelledAt?: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  appliedAt: string | null;
  archives: StoredArchive[];
  androidBackup: StoredAndroidBackup | null;
  androidDatabaseUpload?: StoredAndroidDatabaseUpload | null;
}

export interface CreateWhatsAppHistoryImportInput {
  companyId: string;
  actorUserId: string;
  actorUsername: string;
  commandId: string;
  channelId: string;
}

export interface UpdateWhatsAppHistoryMappingInput {
  phoneE164: string;
  contactName: string;
  companySenderName: string;
  state: WhatsAppHistoryStateOption;
  departmentCode: string;
  ownerUsername?: string | null;
}

export interface AddWhatsAppAndroidBackupInput {
  originalName: string;
  sizeBytes: number;
  temporaryPath: string;
  rootKeyHex: string;
  state: WhatsAppHistoryStateOption;
  departmentCode: string;
  ownerUsername?: string | null;
  retainTemporaryOnFailure?: boolean;
}

export interface CreateWhatsAppAndroidDatabaseUploadInput {
  originalName: string;
  sizeBytes: number;
  fingerprint?: string;
  checksumSha256?: string | null;
}

export interface AddWhatsAppAndroidDatabaseChunkInput {
  uploadId: string;
  offsetBytes: number;
  content: Buffer;
  checksumSha256?: string | null;
}

export interface AddWhatsAppAndroidMediaArchiveInput {
  originalName: string;
  sizeBytes: number;
  temporaryPath: string;
}

export interface CreateWhatsAppAndroidMediaUploadInput {
  originalName: string;
  sizeBytes: number;
  fingerprint?: string;
  checksumSha256?: string | null;
}

export interface AddWhatsAppAndroidMediaChunkInput {
  uploadId: string;
  offsetBytes: number;
  content: Buffer;
  checksumSha256?: string | null;
}

function presentAndroidMediaUpload(upload: StoredAndroidMediaUpload) {
  return {
    schemaVersion: upload.schemaVersion,
    uploadId: upload.uploadId,
    fileName: upload.originalName,
    totalBytes: upload.expectedBytes,
    uploadedBytes: upload.receivedBytes,
    status: upload.status,
    fingerprint: upload.fingerprint ?? null,
    checksumSha256: upload.checksumSha256 ?? null,
  };
}

function presentAndroidDatabaseUpload(upload: StoredAndroidDatabaseUpload) {
  return {
    schemaVersion: upload.schemaVersion,
    uploadId: upload.uploadId,
    fileName: upload.originalName,
    totalBytes: upload.expectedBytes,
    uploadedBytes: upload.receivedBytes,
    status: upload.status,
    fingerprint: upload.fingerprint ?? null,
    checksumSha256: upload.checksumSha256 ?? null,
  };
}

function normalizedSha256(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw validationError('O checksum SHA-256 informado é inválido.');
  }
  return normalized;
}

function uploadFingerprint(
  kind: 'android-database' | 'android-media',
  fileName: string,
  sizeBytes: number,
  supplied?: string,
): string {
  const normalized = supplied?.trim().toLowerCase();
  if (normalized && /^[0-9a-f]{64}$/.test(normalized)) return normalized;
  if (normalized)
    throw validationError('A identificação do arquivo é inválida.');
  return createHash('sha256')
    .update(`${kind}\0${fileName}\0${sizeBytes}`)
    .digest('hex');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

function importPhase(manifest: StoredManifest): string {
  if (manifest.status === 'cancelled' || manifest.status === 'expired') {
    return manifest.status;
  }
  if (manifest.androidDatabaseUpload?.status === 'uploading') {
    return 'uploading-database';
  }
  if (manifest.androidDatabaseUpload?.status === 'processing') {
    return 'validating-database';
  }
  const media = manifest.androidBackup?.mediaImport;
  if (media?.status === 'uploading') return 'uploading-media';
  if (media?.status === 'validating') return 'validating-media';
  if (media?.status === 'processing')
    return `processing-media:${media.phase ?? 'scanning'}`;
  if (
    manifest.status === 'applying' &&
    manifest.androidBackup?.processingPhase === 'finalizing'
  ) {
    return 'finalizing-import';
  }
  if (manifest.status === 'applying') return 'applying-messages';
  if (manifest.androidBackup?.comparison?.status === 'processing') {
    return 'comparing-messages';
  }
  if ((manifest.androidBackup?.comparison?.messagesDivergentPending ?? 0) > 0) {
    return 'awaiting-divergence-resolution';
  }
  if (manifest.status === 'draft' && manifest.androidBackup) return 'ready';
  return manifest.status;
}

function importProgress(manifest: StoredManifest): {
  total: number;
  processed: number;
  failed: number;
} {
  const android = manifest.androidBackup;
  if (!android) {
    return {
      total: manifest.archives.length,
      processed: manifest.archives.length,
      failed: 0,
    };
  }
  if (android.mediaImport?.status === 'processing') {
    return {
      total:
        android.mediaImport.processingFilesTotal ??
        android.summary.mediaReferences,
      processed: android.mediaImport.processingFilesProcessed ?? 0,
      failed: android.mediaImport.skippedOversize,
    };
  }
  if (android.comparison?.status === 'processing') {
    return {
      total: android.comparison.messagesTotal ?? android.summary.directMessages,
      processed: Math.min(
        android.comparison.messagesProcessed ?? 0,
        android.comparison.messagesTotal ?? android.summary.directMessages,
      ),
      failed: 0,
    };
  }
  return {
    total: android.summary.directMessages,
    processed: Math.min(
      android.messagesProcessed,
      android.summary.directMessages,
    ),
    failed: 0,
  };
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
    throw validationError(`${label} deve ser um identificador válido.`);
  }
}

function assertInside(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw validationError('O caminho do lote de importação é inválido.');
  }
}

function publicImportError(error: unknown, fallback: string): string {
  if (isTransactionWriteConflict(error)) {
    return 'O banco estava ocupado durante a importação. O processamento pode ser retomado com segurança, sem duplicar mensagens.';
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'VALIDATION_ERROR' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message.trim().slice(0, 1_000);
  }
  return fallback;
}

function deterministicUuid(...parts: string[]): string {
  const value = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(
    13,
    16,
  )}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

export function androidImportChunkBatchId(
  parentBatchId: string,
  chunkIndex: number,
  exports: readonly ParsedWhatsAppExport[],
): string {
  const contentHash = createHash('sha256');
  for (const item of exports) {
    contentHash.update(item.externalConversationId ?? item.archiveId);
    contentHash.update('\0');
    for (const message of item.messages) {
      contentHash.update(message.externalMessageId ?? '');
      contentHash.update('\0');
    }
  }
  return deterministicUuid(
    'whatsapp-android-import',
    parentBatchId,
    String(chunkIndex),
    contentHash.digest('hex'),
  );
}

function mappingIssues(
  archive: StoredArchive,
  mapping: WhatsAppHistoryConversationMapping | null,
): string[] {
  if (!mapping) return ['Revise e confirme os dados desta conversa.'];
  const issues: string[] = [];
  if (!normalizeBrazilianPhone(mapping.phoneE164)) {
    issues.push('Informe um número de WhatsApp válido com DDD.');
  }
  if (!mapping.contactName.trim()) issues.push('Informe o nome do contato.');
  if (
    !archive.senders.some((sender) => sender.name === mapping.companySenderName)
  ) {
    issues.push('Selecione qual remetente representa a empresa.');
  }
  if (!WHATSAPP_HISTORY_STATE_OPTIONS.includes(mapping.state)) {
    issues.push('Selecione o estado atual do atendimento.');
  }
  if (!IMPORT_DEPARTMENTS.has(mapping.departmentCode)) {
    issues.push('Selecione um departamento válido.');
  }
  if (mapping.state === 'human-active' && !mapping.ownerUsername?.trim()) {
    issues.push('Atendimento humano ativo exige um atendente responsável.');
  }
  return issues;
}

function importMediaReference(media: Prisma.JsonValue | null): string | null {
  if (!media || Array.isArray(media) || typeof media !== 'object') return null;
  const reference = (media as Record<string, Prisma.JsonValue>)[
    'legacyReference'
  ];
  return typeof reference === 'string' ? reference : null;
}

function acceptedPayloadHashes(
  value: Prisma.JsonValue | null | undefined,
): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string =>
      typeof item === 'string' && /^[0-9a-f]{64}$/i.test(item),
  );
}

function androidBackupMessage(
  parsed: ParsedWhatsAppExport,
  message: WhatsAppExportMessage,
): StoredAndroidDivergenceMessage | null {
  const externalMessageId = message.externalMessageId;
  if (!externalMessageId) return null;
  const mediaReference = message.attachment
    ? (message.attachment.reference ??
      `whatsapp-export://${parsed.archiveId}/${encodeURIComponent(
        message.attachment.fileName,
      )}`)
    : null;
  const value = {
    externalConversationId: parsed.externalConversationId,
    externalMessageId,
    direction: message.outbound ? ('outbound' as const) : ('inbound' as const),
    kind: message.kind,
    occurredAt: message.occurredAt.toISOString(),
    deliveryStatus: message.outbound
      ? ('sent' as const)
      : ('received' as const),
    text: message.system
      ? `[Mensagem do sistema] ${message.text ?? ''}`.trim()
      : (message.text ?? null),
    mediaReference,
    actorUsername: null,
    providerMessageId: null,
    correlationId: externalMessageId,
  };
  return {
    direction: value.direction,
    deliveryStatus: value.deliveryStatus,
    kind: value.kind,
    text: value.text,
    occurredAt: value.occurredAt,
    mediaReference,
    payloadHash: importPayloadHash(value),
  };
}

function presentAndroidDivergence(item: StoredAndroidDivergence) {
  return {
    externalMessageId: item.externalMessageId,
    externalConversationId: item.externalConversationId,
    contactName: item.contactName,
    phoneE164: item.phoneE164,
    senderName: item.senderName,
    occurredAt: item.backup.occurredAt,
    existing: {
      direction: item.existing.direction,
      deliveryStatus: item.existing.deliveryStatus,
      kind: item.existing.kind,
      text: item.existing.text,
      occurredAt: item.existing.occurredAt,
      hasMedia: Boolean(item.existing.mediaReference),
    },
    backup: {
      direction: item.backup.direction,
      deliveryStatus: item.backup.deliveryStatus,
      kind: item.backup.kind,
      text: item.backup.text,
      occurredAt: item.backup.occurredAt,
      hasMedia: Boolean(item.backup.mediaReference),
    },
    resolution: item.resolution,
    decidedByUsername: item.decidedByUsername,
    decidedAt: item.decidedAt,
  };
}

function presentManifest(manifest: StoredManifest) {
  const progress = importProgress(manifest);
  const archives = manifest.archives.map((archive) => {
    const issues = mappingIssues(archive, archive.mapping);
    return {
      archiveId: archive.archiveId,
      archiveName: archive.archiveName,
      contactName: archive.mapping?.contactName ?? archive.suggestedContactName,
      phoneE164: archive.mapping?.phoneE164 ?? archive.suggestedPhoneE164,
      companySenderName: archive.mapping?.companySenderName ?? null,
      state: archive.mapping?.state ?? null,
      departmentCode: archive.mapping?.departmentCode ?? 'commercial',
      ownerUsername: archive.mapping?.ownerUsername ?? null,
      senders: archive.senders,
      messageCount: archive.messageCount,
      attachmentCount: archive.attachmentCount,
      missingAttachmentCount: archive.missingAttachmentCount,
      startedAt: archive.startedAt,
      endedAt: archive.endedAt,
      status: issues.length === 0 ? 'ready' : 'needs-review',
      issues,
    };
  });
  const android = manifest.androidBackup;
  return {
    schemaVersion: manifest.schemaVersion,
    mode: android ? ('android-backup' as const) : ('zip-exports' as const),
    id: manifest.id,
    channel: {
      id: manifest.channelId,
      name: manifest.channelName,
      phoneE164: manifest.channelPhoneE164,
    },
    status: manifest.status,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    expiresAt: manifest.expiresAt,
    appliedAt: manifest.appliedAt,
    operation: {
      phase: importPhase(manifest),
      heartbeatAt: manifest.heartbeatAt ?? manifest.updatedAt,
      attempts: manifest.attempts ?? 0,
      total: progress.total,
      processed: progress.processed,
      failed: progress.failed,
      lastError: manifest.lastError ?? null,
      cancelledAt: manifest.cancelledAt ?? null,
    },
    totals: {
      archives: android ? android.summary.directConversations : archives.length,
      ready: android
        ? android.summary.directConversations
        : archives.filter((archive) => archive.status === 'ready').length,
      needsReview: android
        ? 0
        : archives.filter((archive) => archive.status === 'needs-review')
            .length,
      messages: android
        ? android.summary.directMessages
        : archives.reduce((sum, archive) => sum + archive.messageCount, 0),
      attachments: android
        ? android.summary.mediaReferences
        : archives.reduce((sum, archive) => sum + archive.attachmentCount, 0),
      missingAttachments: android
        ? android.summary.mediaReferences
        : archives.reduce(
            (sum, archive) => sum + archive.missingAttachmentCount,
            0,
          ),
    },
    archives,
    androidBackup: android
      ? {
          databaseFileName: android.databaseFileName,
          encryptedBytes: android.encryptedBytes,
          decryptedBytes: android.decryptedBytes,
          summary: android.summary,
          state: android.state,
          departmentCode: android.departmentCode,
          ownerUsername: android.ownerUsername,
          chunksCompleted: android.chunksCompleted,
          conversationsProcessed: android.conversationsProcessed,
          messagesProcessed: android.messagesProcessed,
          errorMessage: android.errorMessage,
          comparison: android.comparison
            ? {
                ...android.comparison,
                messagesDivergentPending:
                  android.comparison.messagesDivergentPending ??
                  android.comparison.messagesDivergent,
              }
            : manifest.status === 'draft'
              ? {
                  status: 'processing' as const,
                  messagesProcessed: 0,
                  messagesTotal: android.summary.directMessages,
                  messagesExisting: 0,
                  messagesNew: 0,
                  messagesDivergent: 0,
                  messagesDivergentPending: 0,
                  mediaStored: 0,
                  mediaNew: 0,
                  mediaMissing: android.summary.mediaReferences,
                  updatedAt: manifest.updatedAt,
                  errorMessage: null,
                }
              : null,
          mediaImport: android.mediaImport ?? null,
        }
      : null,
  };
}

@Injectable()
export class WhatsAppHistoryImportService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WhatsAppHistoryImportService.name);
  private readonly root: string;
  private readonly limits: WhatsAppExportParserLimits;
  private readonly maximumArchives: number;
  private readonly retentionMs: number;
  private readonly maximumAndroidDatabaseBytes: number;
  private readonly maximumAndroidMediaArchiveBytes: number;
  private readonly androidDatabaseUploadChunkBytes: number;
  private readonly androidMediaUploadChunkBytes: number;
  private readonly androidImportChunkMessages: number;
  private readonly instanceId = randomUUID();
  private readonly leaseMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly maximumActiveBatchesPerTenant: number;
  private readonly maximumTemporaryBytesPerTenant: number;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly androidJobs = new Set<string>();
  private readonly androidPreviewJobs = new Set<string>();
  private readonly androidMediaValidationJobs = new Set<string>();
  private readonly androidMediaJobs = new Set<string>();
  private readonly androidMediaJobResumeRequested = new Set<string>();
  private readonly cancelledBatches = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaStorage: WhatsAppMediaStorage,
    private readonly androidMediaImporter: WhatsAppAndroidMediaImportService,
    config: ConfigService,
  ) {
    this.root = resolve(
      config.get<string>('WHATSAPP_IMPORT_ROOT') ??
        resolve(process.cwd(), 'var', 'imports', 'whatsapp'),
    );
    this.maximumArchives = finiteConfig(
      config,
      'WHATSAPP_HISTORY_IMPORT_MAX_ARCHIVES',
      5_000,
    );
    this.retentionMs =
      finiteConfig(config, 'WHATSAPP_HISTORY_IMPORT_RETENTION_HOURS', 48) *
      60 *
      60 *
      1_000;
    this.maximumAndroidDatabaseBytes = finiteConfig(
      config,
      'WHATSAPP_ANDROID_BACKUP_MAX_DECRYPTED_BYTES',
      4_294_967_296,
    );
    this.maximumAndroidMediaArchiveBytes = finiteConfig(
      config,
      'WHATSAPP_ANDROID_MEDIA_ARCHIVE_MAX_BYTES',
      8_589_934_592,
    );
    this.androidDatabaseUploadChunkBytes = Math.min(
      32 * 1024 * 1024,
      Math.max(
        1 * 1024 * 1024,
        finiteConfig(
          config,
          'WHATSAPP_ANDROID_BACKUP_UPLOAD_CHUNK_BYTES',
          16 * 1024 * 1024,
        ),
      ),
    );
    this.androidMediaUploadChunkBytes = Math.min(
      32 * 1024 * 1024,
      Math.max(
        1 * 1024 * 1024,
        finiteConfig(
          config,
          'WHATSAPP_ANDROID_MEDIA_UPLOAD_CHUNK_BYTES',
          16 * 1024 * 1024,
        ),
      ),
    );
    this.androidImportChunkMessages = Math.min(
      50_000,
      Math.max(
        1_000,
        finiteConfig(config, 'WHATSAPP_ANDROID_IMPORT_CHUNK_MESSAGES', 25_000),
      ),
    );
    this.leaseMs =
      finiteConfig(config, 'WHATSAPP_HISTORY_IMPORT_LEASE_SECONDS', 900) *
      1_000;
    this.recoveryIntervalMs =
      Math.max(
        5,
        finiteConfig(
          config,
          'WHATSAPP_HISTORY_IMPORT_RECOVERY_INTERVAL_SECONDS',
          15,
        ),
      ) * 1_000;
    this.cleanupIntervalMs =
      finiteConfig(
        config,
        'WHATSAPP_HISTORY_IMPORT_CLEANUP_INTERVAL_MINUTES',
        15,
      ) *
      60 *
      1_000;
    this.maximumActiveBatchesPerTenant = finiteConfig(
      config,
      'WHATSAPP_HISTORY_IMPORT_MAX_ACTIVE_BATCHES_PER_TENANT',
      2,
    );
    this.maximumTemporaryBytesPerTenant = finiteConfig(
      config,
      'WHATSAPP_HISTORY_IMPORT_MAX_TEMPORARY_BYTES_PER_TENANT',
      16 * 1_073_741_824,
    );
    this.limits = {
      maximumArchiveBytes: finiteConfig(
        config,
        'WHATSAPP_HISTORY_IMPORT_MAX_ARCHIVE_BYTES',
        DEFAULT_WHATSAPP_EXPORT_LIMITS.maximumArchiveBytes,
      ),
      maximumEntries: finiteConfig(
        config,
        'WHATSAPP_HISTORY_IMPORT_MAX_ENTRIES',
        DEFAULT_WHATSAPP_EXPORT_LIMITS.maximumEntries,
      ),
      maximumUncompressedBytes: finiteConfig(
        config,
        'WHATSAPP_HISTORY_IMPORT_MAX_UNCOMPRESSED_BYTES',
        DEFAULT_WHATSAPP_EXPORT_LIMITS.maximumUncompressedBytes,
      ),
      maximumTextBytes: finiteConfig(
        config,
        'WHATSAPP_HISTORY_IMPORT_MAX_TEXT_BYTES',
        DEFAULT_WHATSAPP_EXPORT_LIMITS.maximumTextBytes,
      ),
    };
  }

  onModuleInit(): void {
    setImmediate(() => {
      void this.runLifecycleTask('recovery', () => this.recoverDurableJobs());
      void this.runLifecycleTask('cleanup', () => this.cleanupExpiredImports());
    });
    this.cleanupTimer = setInterval(() => {
      void this.runLifecycleTask('cleanup', () => this.cleanupExpiredImports());
    }, this.cleanupIntervalMs);
    this.cleanupTimer.unref();
    this.recoveryTimer = setInterval(() => {
      void this.runLifecycleTask('recovery', () => this.recoverDurableJobs());
    }, this.recoveryIntervalMs);
    this.recoveryTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.cleanupTimer = null;
    this.recoveryTimer = null;
  }

  private async runLifecycleTask(
    task: 'recovery' | 'cleanup',
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'whatsapp_history_import_lifecycle_failed',
          task,
          error: error instanceof Error ? error.message : 'Erro desconhecido',
        }),
      );
    }
  }

  async channels(companyId: string) {
    return this.prisma.whatsAppChannel.findMany({
      where: { companyId, enabled: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, phoneNumber: true },
    });
  }

  async appliedAndroidBackups(companyId: string) {
    assertUuid(companyId, 'companyId');
    const durable = await this.prisma.whatsAppHistoryImportState.findMany({
      where: { companyId, status: { in: ['completed', 'processing-media'] } },
      orderBy: { updatedAt: 'desc' },
      select: { manifest: true },
    });
    const manifests = durable.map(
      (row) => row.manifest as unknown as StoredManifest,
    );

    const applied = manifests
      .filter(
        (manifest): manifest is StoredManifest =>
          manifest !== null &&
          manifest.status === 'applied' &&
          manifest.androidBackup !== null,
      )
      .sort(
        (left, right) =>
          new Date(right.appliedAt ?? right.updatedAt).getTime() -
          new Date(left.appliedAt ?? left.updatedAt).getTime(),
      );
    return applied.map(presentManifest);
  }

  async active(companyId: string, actorUserId: string) {
    assertUuid(companyId, 'companyId');
    assertUuid(actorUserId, 'actorUserId');
    const row = await this.prisma.whatsAppHistoryImportState.findFirst({
      where: {
        companyId,
        actorUserId,
        status: {
          notIn: ['completed', 'cancelled', 'expired'],
        },
        expiresAt: { gt: new Date() },
      },
      orderBy: { updatedAt: 'desc' },
      select: { manifest: true },
    });
    if (!row) return null;
    const manifest = row.manifest as unknown as StoredManifest;
    return presentManifest(manifest);
  }

  async uploadStatus(companyId: string, batchId: string, uploadId: string) {
    assertUuid(companyId, 'companyId');
    assertUuid(batchId, 'batchId');
    assertUuid(uploadId, 'uploadId');
    const upload = await this.prisma.whatsAppHistoryUploadSession.findFirst({
      where: { id: uploadId, batchId, companyId },
    });
    if (!upload) throw notFound('Envio');
    return {
      schemaVersion: '1.0',
      uploadId: upload.id,
      kind: upload.kind,
      fileName: upload.fileName,
      totalBytes: Number(upload.expectedBytes),
      uploadedBytes: Number(upload.uploadedBytes),
      fingerprint: upload.fingerprint,
      checksumSha256: upload.checksumSha256,
      status: upload.status,
      errorCode: upload.errorCode,
      errorMessage: upload.errorMessage,
      updatedAt: upload.updatedAt.toISOString(),
      expiresAt: upload.expiresAt.toISOString(),
    };
  }

  async create(input: CreateWhatsAppHistoryImportInput) {
    assertUuid(input.commandId, 'commandId');
    assertUuid(input.channelId, 'channelId');
    return this.withBatchLock(
      `${input.companyId}:${input.commandId}`,
      async () => {
        const recoverable =
          await this.prisma.whatsAppHistoryImportState.findFirst({
            where: {
              companyId: input.companyId,
              actorUserId: input.actorUserId,
              status: { notIn: ['completed', 'cancelled', 'expired'] },
              expiresAt: { gt: new Date() },
            },
            orderBy: { updatedAt: 'desc' },
            select: { id: true, channelId: true, manifest: true },
          });
        if (recoverable && recoverable.id !== input.commandId) {
          if (recoverable.channelId === input.channelId) {
            return presentManifest(
              recoverable.manifest as unknown as StoredManifest,
            );
          }
          throw conflict(
            'Já existe uma importação recuperável. Retome ou cancele o lote atual antes de iniciar outro.',
          );
        }
        const activeCount = await this.prisma.whatsAppHistoryImportState.count({
          where: {
            companyId: input.companyId,
            status: { notIn: ['completed', 'cancelled', 'expired'] },
            expiresAt: { gt: new Date() },
          },
        });
        if (activeCount >= this.maximumActiveBatchesPerTenant) {
          throw conflict(
            'O limite de importações simultâneas desta empresa foi atingido.',
          );
        }
        const channel = await this.prisma.whatsAppChannel.findFirst({
          where: {
            id: input.channelId,
            companyId: input.companyId,
            enabled: true,
          },
          select: { id: true, name: true, phoneNumber: true },
        });
        if (!channel) throw notFound('Canal de WhatsApp');
        const batchPath = this.batchPath(input.companyId, input.commandId);
        await mkdir(batchPath, { recursive: true });
        const existing = await this.tryReadManifest(
          input.companyId,
          input.commandId,
        );
        if (existing) {
          if (
            existing.actorUserId !== input.actorUserId ||
            existing.channelId !== input.channelId
          ) {
            throw validationError(
              'Este identificador de importação já foi utilizado com outros dados.',
            );
          }
          return presentManifest(existing);
        }
        const now = new Date();
        const manifest: StoredManifest = {
          schemaVersion: MANIFEST_VERSION,
          id: input.commandId,
          companyId: input.companyId,
          channelId: channel.id,
          channelName: channel.name,
          channelPhoneE164: channel.phoneNumber,
          actorUserId: input.actorUserId,
          actorUsername: input.actorUsername,
          status: 'draft',
          phase: 'draft',
          heartbeatAt: now.toISOString(),
          attempts: 0,
          lastError: null,
          cancelledAt: null,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + this.retentionMs).toISOString(),
          appliedAt: null,
          archives: [],
          androidBackup: null,
          androidDatabaseUpload: null,
        };
        await this.writeManifest(manifest);
        return presentManifest(manifest);
      },
    );
  }

  async detail(companyId: string, batchId: string) {
    const manifest = await this.readManifest(companyId, batchId);
    return presentManifest(manifest);
  }

  async androidDivergences(companyId: string, batchId: string) {
    const manifest = await this.readManifest(companyId, batchId);
    const comparison = manifest.androidBackup?.comparison;
    if (!manifest.androidBackup) {
      throw validationError('Este lote não contém um backup Android.');
    }
    if (!comparison || comparison.status === 'processing') {
      throw validationError('Aguarde a comparação do backup.');
    }
    const divergences = await this.readAndroidDivergences(
      companyId,
      batchId,
      comparison.messagesDivergent > 0,
    );
    return {
      items: divergences.map(presentAndroidDivergence),
      total: divergences.length,
      pending: divergences.filter((item) => item.resolution === null).length,
    };
  }

  async resolveAndroidDivergence(
    companyId: string,
    batchId: string,
    externalMessageId: string,
    resolution: AndroidDivergenceResolution,
    actorUserId: string,
    actorUsername: string,
  ) {
    if (!externalMessageId || externalMessageId.length > 160) {
      throw validationError('A identificação da mensagem é inválida.');
    }
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (manifest.status !== 'draft' || !manifest.androidBackup) {
        throw validationError(
          'Somente uma importação em revisão pode ser corrigida.',
        );
      }
      const comparison = manifest.androidBackup.comparison;
      if (!comparison || comparison.status !== 'ready') {
        throw validationError('Aguarde a comparação do backup.');
      }
      const divergences = await this.readAndroidDivergences(
        companyId,
        batchId,
        true,
      );
      const divergence = divergences.find(
        (item) => item.externalMessageId === externalMessageId,
      );
      if (!divergence) throw notFound('Mensagem divergente');
      const now = new Date().toISOString();
      divergence.resolution = resolution;
      divergence.decidedByUserId = actorUserId;
      divergence.decidedByUsername = actorUsername;
      divergence.decidedAt = now;
      await this.writeAndroidDivergences(companyId, batchId, divergences);
      comparison.messagesDivergentPending = divergences.filter(
        (item) => item.resolution === null,
      ).length;
      comparison.updatedAt = now;
      manifest.updatedAt = now;
      await this.writeManifest(manifest);
      return {
        divergence: presentAndroidDivergence(divergence),
        pending: comparison.messagesDivergentPending,
      };
    });
  }

  async addArchive(
    companyId: string,
    batchId: string,
    file: {
      originalName: string;
      sizeBytes: number;
      content: Buffer;
    },
  ) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (manifest.status !== 'draft') {
        throw validationError(
          'Uma importação concluída não aceita novos backups.',
        );
      }
      if (manifest.androidBackup) {
        throw validationError(
          'Este lote já utiliza um backup completo do Android.',
        );
      }
      if (file.content.byteLength !== file.sizeBytes) {
        throw validationError('O backup recebido está incompleto.');
      }
      const parsed = await parseWhatsAppExportArchive(
        file.originalName,
        file.content,
        this.limits,
      );
      const duplicate = manifest.archives.find(
        (archive) => archive.archiveSha256 === parsed.archiveSha256,
      );
      if (duplicate) return presentManifest(manifest);
      if (manifest.archives.length >= this.maximumArchives) {
        throw validationError(
          `Cada lote aceita no máximo ${this.maximumArchives} backups.`,
        );
      }
      const storageFileName = `${parsed.archiveId}.zip`;
      const archivePath = resolve(
        this.batchPath(companyId, batchId),
        storageFileName,
      );
      assertInside(this.batchPath(companyId, batchId), archivePath);
      await writeFile(archivePath, file.content, {
        flag: 'wx',
        mode: 0o600,
      }).catch(async (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const current = await readFile(archivePath);
        if (!current.equals(file.content)) {
          throw validationError(
            'O backup conflita com um arquivo já recebido.',
          );
        }
      });
      manifest.archives.push(this.storedArchive(parsed, storageFileName));
      manifest.updatedAt = new Date().toISOString();
      await this.writeManifest(manifest);
      return presentManifest(manifest);
    });
  }

  async addAndroidBackup(
    companyId: string,
    batchId: string,
    input: AddWhatsAppAndroidBackupInput,
  ) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      let accepted = false;
      try {
        const manifest = await this.readManifest(companyId, batchId);
        if (manifest.status !== 'draft') {
          throw validationError(
            'Uma importação iniciada ou concluída não aceita outro backup.',
          );
        }
        if (manifest.archives.length > 0) {
          throw validationError(
            'Crie um lote separado para o backup completo do Android.',
          );
        }
        if (!input.originalName.toLowerCase().endsWith('.crypt15')) {
          throw validationError('Selecione o arquivo msgstore.db.crypt15.');
        }
        if (input.sizeBytes < 64 || input.sizeBytes > 2_147_483_647) {
          throw validationError('O arquivo msgstore possui tamanho inválido.');
        }
        if (!WHATSAPP_HISTORY_STATE_OPTIONS.includes(input.state)) {
          throw validationError('Selecione o estado das conversas importadas.');
        }
        if (!IMPORT_DEPARTMENTS.has(input.departmentCode)) {
          throw validationError('Selecione um departamento válido.');
        }
        const ownerUsername = input.ownerUsername?.trim() || null;
        if (input.state === 'human-active' && !ownerUsername) {
          throw validationError(
            'Atendimento humano ativo exige um atendente responsável.',
          );
        }

        const androidPath = resolve(
          this.batchPath(companyId, batchId),
          'android',
        );
        assertInside(this.batchPath(companyId, batchId), androidPath);
        await mkdir(androidPath, { recursive: true });
        const databasePath = resolve(androidPath, 'msgstore.db');
        const decrypted = await decryptWhatsAppCrypt15({
          encryptedPath: input.temporaryPath,
          outputPath: databasePath,
          rootKeyHex: input.rootKeyHex,
          maximumOutputBytes: this.maximumAndroidDatabaseBytes,
        });
        const summary = inspectWhatsAppAndroidBackup(databasePath);
        if (summary.directConversations < 1 || summary.directMessages < 1) {
          throw validationError(
            'Nenhuma conversa individual importável foi encontrada no backup.',
          );
        }
        manifest.androidBackup = {
          databaseFileName: input.originalName.slice(0, 255),
          databaseSha256: decrypted.encryptedSha256,
          encryptedBytes: decrypted.encryptedBytes,
          decryptedBytes: decrypted.decryptedBytes,
          multiFileBackup: decrypted.multiFileBackup,
          summary,
          state: input.state,
          departmentCode: input.departmentCode,
          ownerUsername,
          cutoffAt: null,
          chunksCompleted: 0,
          conversationsProcessed: 0,
          messagesProcessed: 0,
          processingPhase: null,
          errorMessage: null,
          comparison: {
            status: 'processing',
            messagesProcessed: 0,
            messagesTotal: summary.directMessages,
            messagesExisting: 0,
            messagesNew: 0,
            messagesDivergent: 0,
            messagesDivergentPending: 0,
            mediaStored: 0,
            mediaNew: 0,
            mediaMissing: summary.mediaReferences,
            updatedAt: new Date().toISOString(),
            errorMessage: null,
          },
          mediaImport: null,
        };
        if (manifest.androidDatabaseUpload?.status !== 'processing') {
          manifest.androidDatabaseUpload = null;
        }
        manifest.updatedAt = new Date().toISOString();
        await this.writeManifest(manifest);
        accepted = true;
        this.resumeAndroidPreview(manifest);
        return presentManifest(manifest);
      } finally {
        if (!input.retainTemporaryOnFailure || accepted) {
          await rm(input.temporaryPath, { force: true });
        }
      }
    });
  }

  async createAndroidDatabaseUpload(
    companyId: string,
    batchId: string,
    input: CreateWhatsAppAndroidDatabaseUploadInput,
  ) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (
        manifest.status !== 'draft' ||
        manifest.androidBackup ||
        manifest.archives.length > 0
      ) {
        throw validationError(
          'Este lote não está disponível para receber outro backup Android.',
        );
      }
      const originalName = input.originalName.trim().slice(0, 255);
      if (!originalName.toLocaleLowerCase('pt-BR').endsWith('.crypt15')) {
        throw validationError('Selecione o arquivo msgstore.db.crypt15.');
      }
      if (
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 64 ||
        input.sizeBytes > 2_147_483_647
      ) {
        throw validationError('O arquivo msgstore possui tamanho inválido.');
      }
      const fingerprint = uploadFingerprint(
        'android-database',
        originalName,
        input.sizeBytes,
        input.fingerprint,
      );
      const checksumSha256 = normalizedSha256(input.checksumSha256);

      const current = manifest.androidDatabaseUpload;
      if (
        current &&
        (current.fingerprint ??
          uploadFingerprint(
            'android-database',
            current.originalName,
            current.expectedBytes,
          )) === fingerprint &&
        ['uploading', 'failed'].includes(current.status)
      ) {
        const uploadDirectory = this.androidDatabaseUploadPath(
          companyId,
          batchId,
          current.uploadId,
        );
        const upload = await this.readAndroidDatabaseUpload(uploadDirectory);
        if (
          upload.companyId !== companyId ||
          upload.batchId !== batchId ||
          upload.uploadId !== current.uploadId
        ) {
          throw validationError('Este envio de backup não está disponível.');
        }
        if (upload.status === 'failed') {
          upload.status = 'uploading';
          upload.errorMessage = null;
          upload.updatedAt = new Date().toISOString();
          await this.writeAndroidDatabaseUpload(uploadDirectory, upload);
          manifest.androidDatabaseUpload = upload;
          manifest.updatedAt = upload.updatedAt;
          await this.writeManifest(manifest);
        }
        return {
          ...presentAndroidDatabaseUpload(upload),
          chunkSizeBytes: this.androidDatabaseUploadChunkBytes,
        };
      }
      if (current?.status === 'uploading' || current?.status === 'processing') {
        throw validationError(
          'Já existe um backup Android sendo enviado ou processado neste lote.',
        );
      }
      await this.assertTemporaryQuota(companyId, input.sizeBytes);
      if (current) {
        await rm(
          this.androidDatabaseUploadPath(companyId, batchId, current.uploadId),
          { recursive: true, force: true },
        );
      }

      const uploadId = randomUUID();
      const now = new Date().toISOString();
      const upload: StoredAndroidDatabaseUpload = {
        schemaVersion: '1.0',
        uploadId,
        companyId,
        batchId,
        originalName,
        expectedBytes: input.sizeBytes,
        receivedBytes: 0,
        status: 'uploading',
        createdAt: now,
        updatedAt: now,
        errorMessage: null,
        fingerprint,
        checksumSha256,
      };
      const uploadDirectory = this.androidDatabaseUploadPath(
        companyId,
        batchId,
        uploadId,
      );
      await mkdir(uploadDirectory, { recursive: true });
      await writeFile(
        this.androidDatabaseArchivePath(uploadDirectory),
        Buffer.alloc(0),
        { mode: 0o600 },
      );
      await this.writeAndroidDatabaseUpload(uploadDirectory, upload);
      manifest.androidDatabaseUpload = upload;
      manifest.updatedAt = now;
      await this.writeManifest(manifest);
      return {
        ...presentAndroidDatabaseUpload(upload),
        chunkSizeBytes: this.androidDatabaseUploadChunkBytes,
      };
    });
  }

  async addAndroidDatabaseUploadChunk(
    companyId: string,
    batchId: string,
    input: AddWhatsAppAndroidDatabaseChunkInput,
  ) {
    assertUuid(input.uploadId, 'uploadId');
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      if (
        !Number.isSafeInteger(input.offsetBytes) ||
        input.offsetBytes < 0 ||
        input.content.byteLength < 1 ||
        input.content.byteLength > this.androidDatabaseUploadChunkBytes
      ) {
        throw validationError(
          'O bloco enviado possui tamanho ou posição inválida.',
        );
      }
      const chunkChecksum = normalizedSha256(input.checksumSha256);
      if (
        chunkChecksum &&
        createHash('sha256').update(input.content).digest('hex') !==
          chunkChecksum
      ) {
        throw validationError(
          'O bloco recebido não corresponde ao checksum informado.',
        );
      }
      const manifest = await this.readManifest(companyId, batchId);
      const current = manifest.androidDatabaseUpload;
      if (
        manifest.status !== 'draft' ||
        manifest.androidBackup ||
        !current ||
        current.uploadId !== input.uploadId
      ) {
        throw validationError('Este envio de backup não está disponível.');
      }
      const uploadDirectory = this.androidDatabaseUploadPath(
        companyId,
        batchId,
        input.uploadId,
      );
      const upload = await this.readAndroidDatabaseUpload(uploadDirectory);
      if (
        upload.companyId !== companyId ||
        upload.batchId !== batchId ||
        upload.status !== 'uploading'
      ) {
        throw validationError('Este envio de backup não está disponível.');
      }
      const archivePath = this.androidDatabaseArchivePath(uploadDirectory);
      const archiveStat = await stat(archivePath);
      if (archiveStat.size !== upload.receivedBytes) {
        throw validationError(
          'O envio parcial não pôde ser retomado com segurança.',
        );
      }
      if (input.offsetBytes < upload.receivedBytes) {
        const replayEnd = input.offsetBytes + input.content.byteLength;
        if (replayEnd > upload.receivedBytes) {
          throw validationError(
            `O envio deve continuar a partir de ${upload.receivedBytes} bytes.`,
          );
        }
        const existing = Buffer.alloc(input.content.byteLength);
        const handle = await open(archivePath, 'r');
        try {
          const { bytesRead } = await handle.read(
            existing,
            0,
            existing.byteLength,
            input.offsetBytes,
          );
          if (
            bytesRead !== existing.byteLength ||
            !existing.equals(input.content)
          ) {
            throw validationError(
              'O bloco repetido não corresponde ao conteúdo já recebido.',
            );
          }
        } finally {
          await handle.close();
        }
        return {
          ...presentAndroidDatabaseUpload(upload),
          chunkSizeBytes: this.androidDatabaseUploadChunkBytes,
        };
      }
      if (upload.receivedBytes !== input.offsetBytes) {
        throw validationError(
          `O envio deve continuar a partir de ${upload.receivedBytes} bytes.`,
        );
      }
      if (
        upload.receivedBytes + input.content.byteLength >
        upload.expectedBytes
      ) {
        throw validationError('O bloco excede o tamanho declarado do backup.');
      }
      await appendFile(archivePath, input.content);
      upload.receivedBytes += input.content.byteLength;
      upload.updatedAt = new Date().toISOString();
      await this.writeAndroidDatabaseUpload(uploadDirectory, upload);
      manifest.androidDatabaseUpload = upload;
      manifest.updatedAt = upload.updatedAt;
      await this.writeManifest(manifest);
      return {
        ...presentAndroidDatabaseUpload(upload),
        chunkSizeBytes: this.androidDatabaseUploadChunkBytes,
      };
    });
  }

  async completeAndroidDatabaseUpload(
    companyId: string,
    batchId: string,
    uploadId: string,
    input: Omit<
      AddWhatsAppAndroidBackupInput,
      | 'temporaryPath'
      | 'sizeBytes'
      | 'originalName'
      | 'retainTemporaryOnFailure'
    >,
  ) {
    assertUuid(uploadId, 'uploadId');
    const preparation = await this.withBatchLock(
      `${companyId}:${batchId}`,
      async () => {
        const manifest = await this.readManifest(companyId, batchId);
        const current = manifest.androidDatabaseUpload;
        if (
          manifest.androidBackup &&
          current?.uploadId === uploadId &&
          current.status === 'completed'
        ) {
          return { result: presentManifest(manifest) } as const;
        }
        if (
          manifest.status !== 'draft' ||
          manifest.androidBackup ||
          !current ||
          current.uploadId !== uploadId
        ) {
          throw validationError('Este envio de backup não está disponível.');
        }
        const uploadDirectory = this.androidDatabaseUploadPath(
          companyId,
          batchId,
          uploadId,
        );
        const stored = await this.readAndroidDatabaseUpload(uploadDirectory);
        const archivePath = this.androidDatabaseArchivePath(uploadDirectory);
        const archiveStat = await stat(archivePath);
        if (
          stored.companyId !== companyId ||
          stored.batchId !== batchId ||
          stored.uploadId !== uploadId ||
          archiveStat.size !== stored.receivedBytes
        ) {
          throw validationError(
            'O envio parcial não pôde ser retomado com segurança.',
          );
        }
        if (stored.receivedBytes !== stored.expectedBytes) {
          throw validationError(
            `O backup ainda não foi enviado por completo: ${stored.receivedBytes} de ${stored.expectedBytes} bytes.`,
          );
        }
        const actualChecksum = await sha256File(archivePath);
        if (stored.checksumSha256 && stored.checksumSha256 !== actualChecksum) {
          throw validationError(
            'O arquivo recebido não corresponde ao checksum informado.',
          );
        }
        stored.checksumSha256 = actualChecksum;
        stored.status = 'processing';
        stored.errorMessage = null;
        stored.updatedAt = new Date().toISOString();
        await this.writeAndroidDatabaseUpload(uploadDirectory, stored);
        manifest.androidDatabaseUpload = stored;
        manifest.updatedAt = stored.updatedAt;
        await this.writeManifest(manifest);
        return { upload: stored } as const;
      },
    );
    if ('result' in preparation) return preparation.result;
    const upload = preparation.upload;

    const uploadDirectory = this.androidDatabaseUploadPath(
      companyId,
      batchId,
      uploadId,
    );
    try {
      const result = await this.addAndroidBackup(companyId, batchId, {
        ...input,
        originalName: upload.originalName,
        sizeBytes: upload.expectedBytes,
        temporaryPath: this.androidDatabaseArchivePath(uploadDirectory),
        retainTemporaryOnFailure: true,
      });
      await this.withBatchLock(`${companyId}:${batchId}`, async () => {
        const manifest = await this.readManifest(companyId, batchId);
        const current = manifest.androidDatabaseUpload;
        if (!current || current.uploadId !== uploadId) return;
        current.status = 'completed';
        current.errorMessage = null;
        current.updatedAt = new Date().toISOString();
        manifest.updatedAt = current.updatedAt;
        await this.writeManifest(manifest);
      });
      await rm(uploadDirectory, { recursive: true, force: true });
      return result;
    } catch (error) {
      const decryptedDatabasePath = resolve(
        this.batchPath(companyId, batchId),
        'android',
        'msgstore.db',
      );
      assertInside(this.batchPath(companyId, batchId), decryptedDatabasePath);
      await rm(decryptedDatabasePath, { force: true }).catch(() => undefined);
      await this.withBatchLock(`${companyId}:${batchId}`, async () => {
        const manifest = await this.readManifest(companyId, batchId);
        const current = manifest.androidDatabaseUpload;
        if (!current || current.uploadId !== uploadId) return;
        current.status = 'failed';
        current.errorMessage = publicImportError(
          error,
          'O backup não pôde ser validado. Tente novamente.',
        );
        current.updatedAt = new Date().toISOString();
        manifest.updatedAt = current.updatedAt;
        await this.writeAndroidDatabaseUpload(uploadDirectory, current);
        await this.writeManifest(manifest);
      }).catch(() => undefined);
      throw error;
    }
  }

  async addAndroidMediaArchive(
    companyId: string,
    batchId: string,
    input: AddWhatsAppAndroidMediaArchiveInput,
  ) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      try {
        const manifest = await this.readManifest(companyId, batchId);
        if (!manifest.androidBackup || manifest.status !== 'applied') {
          throw validationError(
            'Conclua a importação do backup Android antes de vincular mídias.',
          );
        }
        const result = await this.androidMediaImporter.attachArchive({
          companyId,
          batchId,
          archivePath: input.temporaryPath,
          originalName: input.originalName,
          sizeBytes: input.sizeBytes,
        });
        const previous = manifest.androidBackup.mediaImport;
        manifest.androidBackup.mediaImport = {
          archivesProcessed: (previous?.archivesProcessed ?? 0) + 1,
          filesScanned: (previous?.filesScanned ?? 0) + result.filesScanned,
          stored: result.alreadyStored + result.attached,
          pending: result.missing,
          ambiguous: (previous?.ambiguous ?? 0) + result.ambiguous,
          skippedOversize:
            (previous?.skippedOversize ?? 0) + result.skippedOversize,
          updatedAt: new Date().toISOString(),
          lastArchiveName: input.originalName.slice(0, 255),
          status: 'completed',
          phase: null,
          uploadId: null,
          uploadBytesReceived: input.sizeBytes,
          uploadBytesTotal: input.sizeBytes,
          processingFilesScanned: result.filesScanned,
          processingFilesTotal: result.filesScanned,
          processingFilesProcessed: result.filesScanned,
          processingAttached: result.attached,
          errorMessage: null,
        };
        if (manifest.androidBackup.comparison) {
          manifest.androidBackup.comparison.mediaStored = result.alreadyStored;
          manifest.androidBackup.comparison.mediaNew = result.attached;
          manifest.androidBackup.comparison.mediaMissing = result.missing;
          manifest.androidBackup.comparison.updatedAt =
            new Date().toISOString();
        }
        manifest.updatedAt = new Date().toISOString();
        await this.writeManifest(manifest);
        return presentManifest(manifest);
      } finally {
        await rm(input.temporaryPath, { force: true });
      }
    });
  }

  async createAndroidMediaUpload(
    companyId: string,
    batchId: string,
    input: CreateWhatsAppAndroidMediaUploadInput,
  ) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (
        !manifest.androidBackup ||
        !['draft', 'failed', 'applied'].includes(manifest.status)
      ) {
        throw validationError(
          'O backup Android não está disponível para receber mídias.',
        );
      }
      const originalName = input.originalName.trim().slice(0, 255);
      const fingerprint = uploadFingerprint(
        'android-media',
        originalName,
        input.sizeBytes,
        input.fingerprint,
      );
      const checksumSha256 = normalizedSha256(input.checksumSha256);
      if (!originalName.toLocaleLowerCase('pt-BR').endsWith('.zip')) {
        throw validationError('Selecione um arquivo ZIP da pasta Media.');
      }
      if (
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 22 ||
        input.sizeBytes > this.maximumAndroidMediaArchiveBytes
      ) {
        throw validationError(
          `O ZIP de mídias deve possuir no máximo ${Math.floor(
            this.maximumAndroidMediaArchiveBytes / 1_073_741_824,
          )} GB.`,
        );
      }
      const current = manifest.androidBackup.mediaImport;
      if (
        current?.status === 'uploading' &&
        current.uploadId &&
        current.uploadBytesTotal === input.sizeBytes
      ) {
        const existingDirectory = this.androidMediaUploadPath(
          companyId,
          batchId,
          current.uploadId,
        );
        const existing = await this.readAndroidMediaUpload(existingDirectory);
        if (existing.fingerprint === fingerprint) {
          return {
            ...presentAndroidMediaUpload(existing),
            chunkSizeBytes: this.androidMediaUploadChunkBytes,
          };
        }
      }
      if (
        current?.status === 'failed' &&
        current.uploadId &&
        current.uploadBytesTotal === input.sizeBytes
      ) {
        const existingDirectory = this.androidMediaUploadPath(
          companyId,
          batchId,
          current.uploadId,
        );
        const existing = await this.readAndroidMediaUpload(existingDirectory);
        if (
          existing.fingerprint === fingerprint &&
          existing.receivedBytes < existing.expectedBytes
        ) {
          existing.status = 'uploading';
          existing.updatedAt = new Date().toISOString();
          await this.writeAndroidMediaUpload(existingDirectory, existing);
          current.status = 'uploading';
          current.phase = 'uploading';
          current.errorMessage = null;
          current.updatedAt = existing.updatedAt;
          manifest.updatedAt = existing.updatedAt;
          await this.writeManifest(manifest);
        }
        if (existing.fingerprint === fingerprint) {
          return {
            ...presentAndroidMediaUpload(existing),
            chunkSizeBytes: this.androidMediaUploadChunkBytes,
          };
        }
      }
      if (current?.status === 'uploading' || current?.status === 'processing') {
        throw validationError(
          'Já existe um ZIP de mídias sendo enviado ou processado para este backup.',
        );
      }

      await this.assertTemporaryQuota(companyId, input.sizeBytes);

      if (
        (current?.status === 'failed' || current?.status === 'ready') &&
        current.uploadId
      ) {
        await rm(
          this.androidMediaUploadPath(companyId, batchId, current.uploadId),
          { recursive: true, force: true },
        );
      }

      const uploadId = randomUUID();
      const now = new Date().toISOString();
      const upload: StoredAndroidMediaUpload = {
        schemaVersion: '1.0',
        uploadId,
        companyId,
        batchId,
        originalName,
        expectedBytes: input.sizeBytes,
        receivedBytes: 0,
        status: 'uploading',
        createdAt: now,
        updatedAt: now,
        fingerprint,
        checksumSha256,
      };
      const uploadDirectory = this.androidMediaUploadPath(
        companyId,
        batchId,
        uploadId,
      );
      await mkdir(uploadDirectory, { recursive: true });
      await writeFile(
        this.androidMediaArchivePath(uploadDirectory),
        Buffer.alloc(0),
        {
          mode: 0o600,
        },
      );
      await this.writeAndroidMediaUpload(uploadDirectory, upload);

      manifest.androidBackup.mediaImport = {
        archivesProcessed: current?.archivesProcessed ?? 0,
        filesScanned: current?.filesScanned ?? 0,
        stored: current?.stored ?? 0,
        pending:
          current?.pending ?? manifest.androidBackup.summary.mediaReferences,
        ambiguous: current?.ambiguous ?? 0,
        skippedOversize: current?.skippedOversize ?? 0,
        updatedAt: now,
        lastArchiveName: originalName,
        status: 'uploading',
        phase: 'uploading',
        uploadId,
        uploadBytesReceived: 0,
        uploadBytesTotal: input.sizeBytes,
        processingFilesScanned: 0,
        processingFilesTotal: 0,
        processingFilesProcessed: 0,
        processingAttached: 0,
        errorMessage: null,
      };
      manifest.updatedAt = now;
      await this.writeManifest(manifest);
      return {
        ...presentAndroidMediaUpload(upload),
        chunkSizeBytes: this.androidMediaUploadChunkBytes,
      };
    });
  }

  async addAndroidMediaUploadChunk(
    companyId: string,
    batchId: string,
    input: AddWhatsAppAndroidMediaChunkInput,
  ) {
    assertUuid(input.uploadId, 'uploadId');
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      if (
        !Number.isSafeInteger(input.offsetBytes) ||
        input.offsetBytes < 0 ||
        input.content.byteLength < 1 ||
        input.content.byteLength > this.androidMediaUploadChunkBytes
      ) {
        throw validationError(
          'O bloco enviado possui tamanho ou posição inválida.',
        );
      }
      const chunkChecksum = normalizedSha256(input.checksumSha256);
      if (
        chunkChecksum &&
        createHash('sha256').update(input.content).digest('hex') !==
          chunkChecksum
      ) {
        throw validationError(
          'O bloco recebido não corresponde ao checksum informado.',
        );
      }
      const manifest = await this.readManifest(companyId, batchId);
      if (
        !manifest.androidBackup ||
        !['draft', 'failed', 'applied'].includes(manifest.status)
      ) {
        throw validationError(
          'O backup Android não está disponível para mídias.',
        );
      }
      const uploadDirectory = this.androidMediaUploadPath(
        companyId,
        batchId,
        input.uploadId,
      );
      const upload = await this.readAndroidMediaUpload(uploadDirectory);
      if (
        upload.companyId !== companyId ||
        upload.batchId !== batchId ||
        upload.status !== 'uploading'
      ) {
        throw validationError('Este envio de mídias não está disponível.');
      }
      const archivePath = this.androidMediaArchivePath(uploadDirectory);
      const archiveStat = await stat(archivePath);
      if (archiveStat.size !== upload.receivedBytes) {
        throw validationError(
          'O envio parcial não pôde ser retomado com segurança.',
        );
      }
      if (input.offsetBytes < upload.receivedBytes) {
        const replayEnd = input.offsetBytes + input.content.byteLength;
        if (replayEnd > upload.receivedBytes) {
          throw validationError(
            `O envio deve continuar a partir de ${upload.receivedBytes} bytes.`,
          );
        }
        const existing = Buffer.alloc(input.content.byteLength);
        const handle = await open(archivePath, 'r');
        try {
          const { bytesRead } = await handle.read(
            existing,
            0,
            existing.byteLength,
            input.offsetBytes,
          );
          if (
            bytesRead !== existing.byteLength ||
            !existing.equals(input.content)
          ) {
            throw validationError(
              'O bloco repetido não corresponde ao conteúdo já recebido.',
            );
          }
        } finally {
          await handle.close();
        }
        return {
          ...presentAndroidMediaUpload(upload),
          chunkSizeBytes: this.androidMediaUploadChunkBytes,
        };
      }
      if (upload.receivedBytes !== input.offsetBytes) {
        throw validationError(
          `O envio deve continuar a partir de ${upload.receivedBytes} bytes.`,
        );
      }
      if (
        upload.receivedBytes + input.content.byteLength >
        upload.expectedBytes
      ) {
        throw validationError('O bloco excede o tamanho declarado do ZIP.');
      }
      await appendFile(archivePath, input.content);
      upload.receivedBytes += input.content.byteLength;
      upload.updatedAt = new Date().toISOString();
      await this.writeAndroidMediaUpload(uploadDirectory, upload);

      const mediaImport = manifest.androidBackup.mediaImport;
      if (mediaImport?.uploadId === upload.uploadId) {
        mediaImport.uploadBytesReceived = upload.receivedBytes;
        mediaImport.updatedAt = upload.updatedAt;
        manifest.updatedAt = upload.updatedAt;
        await this.writeManifest(manifest);
      }
      return {
        ...presentAndroidMediaUpload(upload),
        chunkSizeBytes: this.androidMediaUploadChunkBytes,
      };
    });
  }

  async completeAndroidMediaUpload(
    companyId: string,
    batchId: string,
    uploadId: string,
  ) {
    assertUuid(uploadId, 'uploadId');
    const manifest = await this.withBatchLock(
      `${companyId}:${batchId}`,
      async () => {
        const currentManifest = await this.readManifest(companyId, batchId);
        if (
          !currentManifest.androidBackup ||
          !['draft', 'failed', 'applied'].includes(currentManifest.status)
        ) {
          throw validationError(
            'O backup Android não está disponível para mídias.',
          );
        }
        const uploadDirectory = this.androidMediaUploadPath(
          companyId,
          batchId,
          uploadId,
        );
        const upload = await this.readAndroidMediaUpload(uploadDirectory);
        if (upload.companyId !== companyId || upload.batchId !== batchId) {
          throw validationError('Este envio de mídias não pertence ao backup.');
        }
        if (upload.receivedBytes !== upload.expectedBytes) {
          throw validationError(
            `O ZIP ainda não foi enviado por completo: ${upload.receivedBytes} de ${upload.expectedBytes} bytes.`,
          );
        }
        if (
          upload.status === 'completed' ||
          upload.status === 'ready' ||
          upload.status === 'validating'
        ) {
          return currentManifest;
        }
        upload.status = 'validating';
        upload.updatedAt = new Date().toISOString();
        await this.writeAndroidMediaUpload(uploadDirectory, upload);
        const mediaImport = currentManifest.androidBackup.mediaImport;
        currentManifest.androidBackup.mediaImport = {
          archivesProcessed: mediaImport?.archivesProcessed ?? 0,
          filesScanned: mediaImport?.filesScanned ?? 0,
          stored: mediaImport?.stored ?? 0,
          pending:
            mediaImport?.pending ??
            currentManifest.androidBackup.summary.mediaReferences,
          ambiguous: mediaImport?.ambiguous ?? 0,
          skippedOversize: mediaImport?.skippedOversize ?? 0,
          updatedAt: upload.updatedAt,
          lastArchiveName: upload.originalName,
          status: 'validating',
          phase: 'scanning',
          uploadId,
          uploadBytesReceived: upload.receivedBytes,
          uploadBytesTotal: upload.expectedBytes,
          processingFilesScanned: 0,
          processingFilesTotal: 0,
          processingFilesProcessed: 0,
          processingAttached: 0,
          errorMessage: null,
        };
        currentManifest.updatedAt = upload.updatedAt;
        await this.writeManifest(currentManifest);
        return currentManifest;
      },
    );
    this.resumeAndroidMediaValidationJob(manifest);
    return presentManifest(manifest);
  }

  async updateMapping(
    companyId: string,
    batchId: string,
    archiveId: string,
    input: UpdateWhatsAppHistoryMappingInput,
  ) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (manifest.status !== 'draft') {
        throw validationError(
          'Uma importação concluída não pode ser alterada.',
        );
      }
      const archive = manifest.archives.find(
        (item) => item.archiveId === archiveId,
      );
      if (!archive) throw notFound('Conversa importada');
      const phoneE164 = normalizeBrazilianPhone(input.phoneE164);
      const mapping: WhatsAppHistoryConversationMapping = {
        archiveId,
        phoneE164: phoneE164 ?? input.phoneE164.trim(),
        contactName: input.contactName.trim().slice(0, 160),
        companySenderName: input.companySenderName.trim(),
        state: input.state,
        departmentCode: input.departmentCode,
        ownerUsername: input.ownerUsername?.trim() || null,
      };
      const issues = mappingIssues(archive, mapping);
      if (issues.length > 0) {
        throw validationError(issues.join(' '));
      }
      archive.mapping = mapping;
      manifest.updatedAt = new Date().toISOString();
      await this.writeManifest(manifest);
      return presentManifest(manifest);
    });
  }

  async workbook(companyId: string, batchId: string) {
    const manifest = await this.readManifest(companyId, batchId);
    if (manifest.androidBackup) {
      throw validationError(
        'O backup completo é processado diretamente e não gera uma única planilha.',
      );
    }
    const generated = await this.generateWorkbook(manifest);
    return {
      ...generated,
      fileName: `historico-whatsapp-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`,
    };
  }

  async apply(companyId: string, batchId: string, cutoffAt: Date) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (!Number.isFinite(cutoffAt.getTime())) {
        throw validationError('Informe uma data de corte válida.');
      }
      if (manifest.androidBackup) {
        if (manifest.status === 'applied') return presentManifest(manifest);
        const comparison = manifest.androidBackup.comparison;
        if (!comparison || comparison.status === 'processing') {
          throw validationError(
            'Aguarde a comparação do backup com as mensagens já incorporadas.',
          );
        }
        if (comparison.status === 'failed') {
          throw validationError(
            comparison.errorMessage ||
              'Não foi possível comparar este backup com o histórico atual.',
          );
        }
        const divergences = await this.readAndroidDivergences(
          companyId,
          batchId,
          comparison.messagesDivergent > 0,
        );
        const unresolvedDivergences = divergences.filter(
          (item) => item.resolution === null,
        ).length;
        if (unresolvedDivergences > 0) {
          throw validationError(
            'Corrija todas as mensagens divergentes antes de importar.',
          );
        }
        if (
          manifest.androidBackup.summary.mediaReferences > 0 &&
          manifest.androidBackup.mediaImport?.status !== 'ready'
        ) {
          throw validationError(
            'Selecione e envie por completo o ZIP da pasta Media antes de aplicar o backup.',
          );
        }
        const cutoffIso = cutoffAt.toISOString();
        if (
          manifest.androidBackup.cutoffAt &&
          manifest.androidBackup.cutoffAt !== cutoffIso
        ) {
          throw validationError(
            'Uma retomada deve usar a mesma data de corte da primeira execução.',
          );
        }
        manifest.androidBackup.cutoffAt = cutoffIso;
        manifest.androidBackup.errorMessage = null;
        manifest.status = 'applying';
        manifest.updatedAt = new Date().toISOString();
        await this.writeManifest(manifest);
        this.resumeAndroidImport(manifest);
        return presentManifest(manifest);
      }
      const loaded = await this.loadExports(manifest);
      const previouslyImported = await this.previouslyImportedArchives(
        companyId,
        loaded.exports,
        loaded.mappings,
        manifest.channelPhoneE164,
      );
      const exportsToImport = loaded.exports.filter(
        (parsed) => !previouslyImported.has(parsed.archiveId),
      );
      const mappingsToImport = loaded.mappings.filter(
        (mapping) => !previouslyImported.has(mapping.archiveId),
      );
      const generated = await createWhatsAppImportWorkbook(
        exportsToImport,
        mappingsToImport,
        manifest.channelPhoneE164,
      );
      const packagePath = resolve(
        this.batchPath(companyId, batchId),
        'package',
      );
      assertInside(this.batchPath(companyId, batchId), packagePath);
      await mkdir(packagePath, { recursive: true });
      const workbookPath = resolve(
        packagePath,
        'modelo-importacao-atendimentos-whatsapp.xlsx',
      );
      await writeFile(workbookPath, generated.content, { mode: 0o600 });
      const importer = new WhatsAppImportService(this.prisma, this.root);
      const batchName = `historico-whatsapp-${batchId}`;
      const importInput = {
        companyId,
        channelId: manifest.channelId,
        actorUsername: manifest.actorUsername,
        batchName,
        batchId,
        packagePath,
        cutoffAt,
        confirmation: `APPLY:${batchId}`,
      };
      let result: Awaited<ReturnType<WhatsAppImportService['apply']>>;
      if (exportsToImport.length === 0) {
        result = {
          schemaVersion: '1.0',
          mode: 'apply',
          batchId,
          status: 'applied',
          idempotentReplay: true,
          counts: emptyImportCounts(),
          outboxCreatedByImporter: 0,
        };
      } else {
        const validation = await importer.validate(importInput);
        if (!validation.valid) {
          const details = validation.issues
            .filter((issue) => issue.severity === 'error')
            .slice(0, 3)
            .map((issue) => issue.message.trim())
            .filter(Boolean)
            .join(' ');
          throw validationError(
            details ||
              'A revisão final encontrou dados inválidos. Corrija as conversas antes de importar.',
          );
        }
        result = await importer.apply(importInput);
      }
      await this.retainImportedMedia(manifest, loaded.exports, loaded.mappings);
      manifest.status = 'applied';
      manifest.appliedAt = new Date().toISOString();
      manifest.updatedAt = manifest.appliedAt;
      await this.writeManifest(manifest);
      return result;
    });
  }

  private resumeAndroidPreview(manifest: StoredManifest): void {
    const comparison = manifest.androidBackup?.comparison;
    if (manifest.status !== 'draft' || comparison?.status !== 'processing') {
      return;
    }
    const jobKey = `${manifest.companyId}:${manifest.id}`;
    if (this.androidPreviewJobs.has(jobKey)) return;
    this.androidPreviewJobs.add(jobKey);
    setImmediate(() => {
      void this.runClaimedJob(manifest.companyId, manifest.id, 'preview', () =>
        this.runAndroidPreview(manifest.companyId, manifest.id),
      ).finally(() => this.androidPreviewJobs.delete(jobKey));
    });
  }

  private resumeAndroidImport(manifest: StoredManifest): void {
    if (manifest.status !== 'applying' || !manifest.androidBackup?.cutoffAt) {
      return;
    }
    const jobKey = `${manifest.companyId}:${manifest.id}`;
    if (this.androidJobs.has(jobKey)) return;
    this.androidJobs.add(jobKey);
    setImmediate(() => {
      void this.runClaimedJob(manifest.companyId, manifest.id, 'import', () =>
        this.runAndroidImport(manifest.companyId, manifest.id),
      ).finally(() => this.androidJobs.delete(jobKey));
    });
  }

  private async runAndroidPreview(
    companyId: string,
    batchId: string,
  ): Promise<void> {
    try {
      const manifest = await this.readManifest(companyId, batchId);
      const android = manifest.androidBackup;
      if (
        !android ||
        manifest.status !== 'draft' ||
        android.comparison?.status !== 'processing'
      ) {
        return;
      }
      const databasePath = resolve(
        this.batchPath(companyId, batchId),
        'android',
        'msgstore.db',
      );
      assertInside(this.batchPath(companyId, batchId), databasePath);
      let chunkMessages = 0;
      let exports: ParsedWhatsAppExport[] = [];
      let messagesExisting = 0;
      let messagesNew = 0;
      let messagesDivergent = 0;
      let mediaStored = 0;
      let mediaReferences = 0;
      let messagesCompared = 0;
      let lastProgressPersistedAt = 0;
      const newMessageIds: string[] = [];
      const divergences: StoredAndroidDivergence[] = [];
      const mediaPreviewReferences: PreviewWhatsAppAndroidMediaReference[] = [];

      const persistPreviewProgress = async (force = false): Promise<void> => {
        const nowMs = Date.now();
        if (!force && nowMs - lastProgressPersistedAt < 5_000) return;
        lastProgressPersistedAt = nowMs;
        await this.withBatchLock(`${companyId}:${batchId}`, async () => {
          const current = await this.readManifest(companyId, batchId);
          const currentComparison = current.androidBackup?.comparison;
          if (
            current.status !== 'draft' ||
            currentComparison?.status !== 'processing'
          ) {
            return;
          }
          const now = new Date().toISOString();
          currentComparison.messagesProcessed = messagesCompared;
          currentComparison.messagesTotal = android.summary.directMessages;
          currentComparison.messagesExisting = messagesExisting;
          currentComparison.messagesNew = messagesNew;
          currentComparison.messagesDivergent = messagesDivergent;
          currentComparison.mediaStored = mediaStored;
          currentComparison.mediaMissing = Math.max(
            0,
            mediaReferences - mediaStored,
          );
          currentComparison.updatedAt = now;
          current.updatedAt = now;
          await this.writeManifest(current);
        });
      };

      const flush = async (): Promise<void> => {
        if (exports.length === 0) return;
        const chunkRows = exports.flatMap((item) => item.messages);
        const externalIds = chunkRows.flatMap((message) =>
          message.externalMessageId ? [message.externalMessageId] : [],
        );
        const existingReferences = await this.androidMessageReferences(
          companyId,
          externalIds,
        );
        const existingByExternalId = new Map(
          existingReferences.map((reference) => [
            reference.externalId,
            reference,
          ]),
        );
        const existingMessageIds = existingReferences.map(
          (reference) => reference.internalId,
        );
        const existingMessages =
          existingMessageIds.length > 0
            ? await this.prisma.whatsAppMessage.findMany({
                where: {
                  companyId,
                  channelId: manifest.channelId,
                  id: { in: existingMessageIds },
                },
                select: {
                  id: true,
                  direction: true,
                  deliveryStatus: true,
                  kind: true,
                  text: true,
                  occurredAt: true,
                  media: true,
                  contact: {
                    select: {
                      displayName: true,
                      phoneNormalized: true,
                    },
                  },
                },
              })
            : [];
        const existingMessageById = new Map(
          existingMessages.map((message) => [message.id, message]),
        );
        for (const parsed of exports) {
          for (const message of parsed.messages) {
            const externalMessageId = message.externalMessageId;
            if (!externalMessageId) continue;
            const existing = existingByExternalId.get(externalMessageId);
            const backup = androidBackupMessage(parsed, message);
            if (!backup) continue;
            if (!existing) {
              messagesNew += 1;
              newMessageIds.push(externalMessageId);
            } else if (
              existing.payloadHash === backup.payloadHash ||
              existing.acceptedPayloadHashes.includes(backup.payloadHash)
            ) {
              messagesExisting += 1;
            } else {
              messagesDivergent += 1;
              const current = existingMessageById.get(existing.internalId);
              if (!current) {
                throw validationError(
                  'Uma mensagem divergente não está mais disponível no histórico atual.',
                );
              }
              divergences.push({
                externalMessageId,
                internalMessageId: current.id,
                externalConversationId:
                  parsed.externalConversationId ?? parsed.archiveId,
                contactName:
                  current.contact.displayName ?? parsed.suggestedContactName,
                phoneE164:
                  current.contact.phoneNormalized ?? parsed.suggestedPhoneE164,
                senderName: message.senderName,
                existing: {
                  direction:
                    current.direction === MessageDirection.OUTBOUND
                      ? 'outbound'
                      : 'inbound',
                  deliveryStatus:
                    DELIVERY_STATUS_TO_IMPORT[current.deliveryStatus],
                  kind: MESSAGE_KIND_TO_EXPORT[current.kind],
                  text: current.text,
                  occurredAt: current.occurredAt.toISOString(),
                  mediaReference: importMediaReference(current.media),
                  payloadHash: existing.payloadHash ?? '',
                },
                backup,
                resolution: null,
                decidedByUserId: null,
                decidedByUsername: null,
                decidedAt: null,
              });
            }
            if (message.attachment) mediaReferences += 1;
          }
        }
        const attachmentRows = chunkRows.flatMap((message) => {
          const reference = message.attachment?.reference;
          const externalMessageId = message.externalMessageId;
          if (!reference || !externalMessageId) return [];
          const internalId = message.externalMessageId
            ? existingByExternalId.get(message.externalMessageId)?.internalId
            : undefined;
          return [{ externalMessageId, internalId, reference }];
        });
        const mediaInternalIds = attachmentRows.flatMap((item) =>
          item.internalId ? [item.internalId] : [],
        );
        const storedInternalIds = new Set<string>();
        for (
          let offset = 0;
          offset < mediaInternalIds.length;
          offset += EXTERNAL_REFERENCE_CHUNK_SIZE
        ) {
          const stored = await this.prisma.whatsAppMessage.findMany({
            where: {
              companyId,
              channelId: manifest.channelId,
              id: {
                in: mediaInternalIds.slice(
                  offset,
                  offset + EXTERNAL_REFERENCE_CHUNK_SIZE,
                ),
              },
              mediaStorageKey: { not: null },
            },
            select: { id: true },
          });
          stored.forEach((message) => storedInternalIds.add(message.id));
        }
        mediaStored += storedInternalIds.size;
        mediaPreviewReferences.push(
          ...attachmentRows.map((item) => ({
            id: item.externalMessageId,
            reference: item.reference,
            stored: item.internalId
              ? storedInternalIds.has(item.internalId)
              : false,
          })),
        );
        messagesCompared += chunkRows.length;
        exports = [];
        chunkMessages = 0;
        await persistPreviewProgress();
      };

      for (const item of readWhatsAppAndroidBackup(databasePath, {
        departmentCode: android.departmentCode,
        state: android.state,
        ownerUsername: android.ownerUsername,
      })) {
        for (
          let offset = 0;
          offset < item.parsed.messages.length;
          offset += this.androidImportChunkMessages
        ) {
          const messages = item.parsed.messages.slice(
            offset,
            offset + this.androidImportChunkMessages,
          );
          if (
            chunkMessages > 0 &&
            chunkMessages + messages.length > this.androidImportChunkMessages
          ) {
            await flush();
          }
          exports.push({
            ...item.parsed,
            messages,
            messageCount: messages.length,
            attachmentCount: messages.filter((message) => message.attachment)
              .length,
            missingAttachmentCount: messages.filter(
              (message) => message.attachment,
            ).length,
            startedAt: messages[0]?.occurredAt ?? null,
            endedAt: messages.at(-1)?.occurredAt ?? null,
          });
          chunkMessages += messages.length;
          if (
            offset + this.androidImportChunkMessages <
            item.parsed.messages.length
          ) {
            await flush();
          }
        }
      }
      await flush();
      await persistPreviewProgress(true);
      const newIdsPath = resolve(
        this.batchPath(companyId, batchId),
        'android',
        'new-message-ids.json',
      );
      assertInside(this.batchPath(companyId, batchId), newIdsPath);
      await writeFile(newIdsPath, JSON.stringify(newMessageIds), {
        encoding: 'utf8',
        mode: 0o600,
      });
      const mediaReferencesPath = resolve(
        this.batchPath(companyId, batchId),
        'android',
        'media-preview-references.json',
      );
      assertInside(this.batchPath(companyId, batchId), mediaReferencesPath);
      await writeFile(
        mediaReferencesPath,
        JSON.stringify(mediaPreviewReferences),
        { encoding: 'utf8', mode: 0o600 },
      );
      await this.writeAndroidDivergences(companyId, batchId, divergences);
      await this.withBatchLock(`${companyId}:${batchId}`, async () => {
        const current = await this.readManifest(companyId, batchId);
        if (!current.androidBackup || current.status !== 'draft') return;
        const now = new Date().toISOString();
        current.androidBackup.comparison = {
          status: 'ready',
          messagesProcessed: android.summary.directMessages,
          messagesTotal: android.summary.directMessages,
          messagesExisting,
          messagesNew,
          messagesDivergent,
          messagesDivergentPending: divergences.length,
          mediaStored,
          mediaNew: 0,
          mediaMissing: Math.max(0, mediaReferences - mediaStored),
          updatedAt: now,
          errorMessage: null,
        };
        current.updatedAt = now;
        await this.writeManifest(current);
      });
    } catch (error) {
      await this.withBatchLock(`${companyId}:${batchId}`, async () => {
        const manifest = await this.readManifest(companyId, batchId);
        if (!manifest.androidBackup || manifest.status !== 'draft') return;
        const now = new Date().toISOString();
        manifest.androidBackup.comparison = {
          status: 'failed',
          messagesProcessed:
            manifest.androidBackup.comparison?.messagesProcessed ?? 0,
          messagesTotal: manifest.androidBackup.summary.directMessages,
          messagesExisting: 0,
          messagesNew: 0,
          messagesDivergent: 0,
          messagesDivergentPending: 0,
          mediaStored: 0,
          mediaNew: 0,
          mediaMissing: manifest.androidBackup.summary.mediaReferences,
          updatedAt: now,
          errorMessage: publicImportError(
            error,
            'Não foi possível comparar este backup. Tente novamente.',
          ),
        };
        manifest.updatedAt = now;
        await this.writeManifest(manifest);
      }).catch(() => undefined);
    }
  }

  private async androidMessageReferences(
    companyId: string,
    externalIds: readonly string[],
  ): Promise<
    {
      externalId: string;
      internalId: string;
      payloadHash: string | null;
      acceptedPayloadHashes: string[];
    }[]
  > {
    const references: {
      externalId: string;
      internalId: string;
      payloadHash: string | null;
      acceptedPayloadHashes: string[];
    }[] = [];
    for (
      let offset = 0;
      offset < externalIds.length;
      offset += EXTERNAL_REFERENCE_CHUNK_SIZE
    ) {
      references.push(
        ...(
          await this.prisma.whatsAppImportExternalRef.findMany({
            where: {
              companyId,
              entityType: 'message',
              sourceSystem: 'whatsapp-android-backup',
              externalId: {
                in: externalIds.slice(
                  offset,
                  offset + EXTERNAL_REFERENCE_CHUNK_SIZE,
                ),
              },
            },
            select: {
              externalId: true,
              internalId: true,
              payloadHash: true,
              acceptedPayloadHashes: true,
            },
          })
        ).map((reference) => ({
          ...reference,
          acceptedPayloadHashes: acceptedPayloadHashes(
            reference.acceptedPayloadHashes,
          ),
        })),
      );
    }
    return references;
  }

  private async applyAndroidDivergenceResolutions(
    companyId: string,
    batchId: string,
    divergences: readonly StoredAndroidDivergence[],
  ): Promise<void> {
    for (const divergence of divergences) {
      if (!divergence.resolution) {
        throw validationError(
          'Corrija todas as mensagens divergentes antes de importar.',
        );
      }
      const reference = await this.prisma.whatsAppImportExternalRef.findFirst({
        where: {
          companyId,
          entityType: 'message',
          sourceSystem: 'whatsapp-android-backup',
          externalId: divergence.externalMessageId,
          internalId: divergence.internalMessageId,
        },
        select: {
          id: true,
          payloadHash: true,
          acceptedPayloadHashes: true,
        },
      });
      if (!reference) {
        throw validationError(
          'A mensagem divergente não está mais disponível no histórico atual.',
        );
      }
      if (divergence.resolution === 'keep-existing') {
        const accepted = new Set(
          acceptedPayloadHashes(reference.acceptedPayloadHashes),
        );
        accepted.add(divergence.backup.payloadHash);
        await this.prisma.whatsAppImportExternalRef.updateMany({
          where: { id: reference.id, companyId },
          data: {
            acceptedPayloadHashes: [...accepted],
          },
        });
        continue;
      }

      const mediaMetadata = importedMediaMetadata(
        divergence.backup.mediaReference,
        divergence.externalMessageId,
      );
      const mediaChanged =
        divergence.existing.mediaReference !== divergence.backup.mediaReference;
      const updated = await this.prisma.whatsAppMessage.updateMany({
        where: {
          id: divergence.internalMessageId,
          companyId,
        },
        data: {
          direction: MESSAGE_DIRECTION_BY_IMPORT[divergence.backup.direction],
          deliveryStatus:
            DELIVERY_STATUS_BY_IMPORT[divergence.backup.deliveryStatus],
          kind: MESSAGE_KIND_BY_EXPORT[divergence.backup.kind],
          text: divergence.backup.text,
          occurredAt: new Date(divergence.backup.occurredAt),
          media: mediaMetadata ?? Prisma.DbNull,
          ...(mediaChanged
            ? {
                mediaStorageKey: null,
                mediaMimeType: null,
                mediaSizeBytes: null,
                mediaOriginalName: null,
                mediaSha256: null,
                mediaStoredAt: null,
              }
            : {}),
        },
      });
      if (updated.count !== 1) {
        throw validationError(
          'A mensagem divergente não pôde ser atualizada com o conteúdo do backup.',
        );
      }
      await this.prisma.whatsAppImportExternalRef.updateMany({
        where: { id: reference.id, companyId },
        data: {
          payloadHash: divergence.backup.payloadHash,
          acceptedPayloadHashes: Prisma.DbNull,
        },
      });
    }
  }

  private async runAndroidImport(
    companyId: string,
    batchId: string,
  ): Promise<void> {
    try {
      const manifest = await this.readManifest(companyId, batchId);
      const android = manifest.androidBackup;
      if (!android?.cutoffAt) {
        throw validationError('O backup Android não possui data de corte.');
      }
      const cutoffAt = new Date(android.cutoffAt);
      const databasePath = resolve(
        this.batchPath(companyId, batchId),
        'android',
        'msgstore.db',
      );
      assertInside(this.batchPath(companyId, batchId), databasePath);
      const importer = new WhatsAppImportService(this.prisma, this.root);
      const newIdsPath = resolve(
        this.batchPath(companyId, batchId),
        'android',
        'new-message-ids.json',
      );
      assertInside(this.batchPath(companyId, batchId), newIdsPath);
      const newMessageIds = new Set(
        JSON.parse(await readFile(newIdsPath, 'utf8')) as string[],
      );
      const divergences = await this.readAndroidDivergences(
        companyId,
        batchId,
        (android.comparison?.messagesDivergent ?? 0) > 0,
      );
      await this.applyAndroidDivergenceResolutions(
        companyId,
        batchId,
        divergences,
      );
      let chunkIndex = 0;
      let chunkMessages = 0;
      let examinedMessages = 0;
      let exports: ParsedWhatsAppExport[] = [];
      let mappings: WhatsAppHistoryConversationMapping[] = [];
      const processedPhones = new Set<string>();

      android.chunksCompleted = 0;
      android.conversationsProcessed = 0;
      android.messagesProcessed = 0;
      android.processingPhase = 'messages';
      android.errorMessage = null;
      manifest.updatedAt = new Date().toISOString();
      await this.writeManifest(manifest);

      const flush = async (): Promise<void> => {
        if (exports.length === 0) return;
        chunkIndex += 1;
        const packagePath = resolve(
          this.batchPath(companyId, batchId),
          'android',
          'package',
          `chunk-${chunkIndex.toString().padStart(4, '0')}`,
        );
        assertInside(this.batchPath(companyId, batchId), packagePath);
        await mkdir(packagePath, { recursive: true });
        const workbookPath = resolve(
          packagePath,
          'modelo-importacao-atendimentos-whatsapp.xlsx',
        );
        await ensureImportWorkbookArtifact(workbookPath, async () => {
          const generated = await createWhatsAppImportWorkbook(
            exports,
            mappings,
            manifest.channelPhoneE164,
          );
          return generated.content;
        });
        const childBatchId = androidImportChunkBatchId(
          batchId,
          chunkIndex,
          exports,
        );
        const importInput = {
          companyId,
          channelId: manifest.channelId,
          actorUsername: manifest.actorUsername,
          batchName: `android-${batchId.slice(0, 8)}-${chunkIndex
            .toString()
            .padStart(4, '0')}`,
          batchId: childBatchId,
          packagePath,
          cutoffAt,
          confirmation: `APPLY:${childBatchId}`,
        };
        await importer.apply(importInput);
        for (const mapping of mappings) {
          processedPhones.add(mapping.phoneE164);
        }
        android.chunksCompleted = chunkIndex;
        android.conversationsProcessed = processedPhones.size;
        android.messagesProcessed = examinedMessages;
        manifest.updatedAt = new Date().toISOString();
        await this.writeManifest(manifest);
        exports = [];
        mappings = [];
        chunkMessages = 0;
      };

      for (const item of readWhatsAppAndroidBackup(databasePath, {
        cutoffAt,
        departmentCode: android.departmentCode,
        state: android.state,
        ownerUsername: android.ownerUsername,
      })) {
        for (
          let offset = 0;
          offset < item.parsed.messages.length;
          offset += this.androidImportChunkMessages
        ) {
          const sourceMessages = item.parsed.messages.slice(
            offset,
            offset + this.androidImportChunkMessages,
          );
          examinedMessages += sourceMessages.length;
          const messages = sourceMessages.filter((message) =>
            message.externalMessageId
              ? newMessageIds.has(message.externalMessageId)
              : false,
          );
          if (messages.length === 0) continue;
          if (
            chunkMessages > 0 &&
            chunkMessages + messages.length > this.androidImportChunkMessages
          ) {
            await flush();
          }
          const segment: ParsedWhatsAppExport = {
            ...item.parsed,
            messages,
            messageCount: messages.length,
            attachmentCount: messages.filter((message) => message.attachment)
              .length,
            missingAttachmentCount: messages.filter(
              (message) => message.attachment,
            ).length,
            startedAt: messages[0]?.occurredAt ?? null,
            endedAt: messages.at(-1)?.occurredAt ?? null,
          };
          exports.push(segment);
          mappings.push(item.mapping);
          chunkMessages += messages.length;
          if (
            offset + this.androidImportChunkMessages <
            item.parsed.messages.length
          ) {
            await flush();
          }
        }
      }
      await flush();
      android.messagesProcessed = android.summary.directMessages;
      android.processingPhase = 'finalizing';
      manifest.updatedAt = new Date().toISOString();
      await this.writeManifest(manifest);
      if (chunkIndex < 1 && newMessageIds.size > 0) {
        throw validationError(
          'Nenhuma mensagem anterior à data de corte foi encontrada.',
        );
      }
      const mediaImport = android.mediaImport;
      if (mediaImport?.status === 'ready' && mediaImport.uploadId) {
        const uploadDirectory = this.androidMediaUploadPath(
          companyId,
          batchId,
          mediaImport.uploadId,
        );
        const upload = await this.readAndroidMediaUpload(uploadDirectory);
        if (
          upload.status !== 'ready' ||
          upload.receivedBytes !== upload.expectedBytes
        ) {
          throw validationError(
            'O ZIP da pasta Media não está pronto para ser vinculado.',
          );
        }
        const now = new Date().toISOString();
        upload.status = 'processing';
        upload.updatedAt = now;
        await this.writeAndroidMediaUpload(uploadDirectory, upload);
        mediaImport.status = 'processing';
        mediaImport.phase = 'scanning';
        mediaImport.updatedAt = now;
        mediaImport.processingFilesScanned = 0;
        mediaImport.processingFilesTotal = 0;
        mediaImport.processingFilesProcessed = 0;
        mediaImport.processingAttached = 0;
        mediaImport.errorMessage = null;
      }
      manifest.status = 'applied';
      android.processingPhase = null;
      manifest.appliedAt = new Date().toISOString();
      manifest.updatedAt = manifest.appliedAt;
      await this.writeManifest(manifest);
      this.resumeAndroidMediaJob(manifest, true);
    } catch (error) {
      this.logger.error(
        `Falha ao importar o backup Android ${batchId}.`,
        error instanceof Error ? error.stack : String(error),
      );
      const manifest = await this.readManifest(companyId, batchId);
      manifest.status = 'failed';
      if (manifest.androidBackup) {
        manifest.androidBackup.processingPhase = null;
        manifest.androidBackup.errorMessage = publicImportError(
          error,
          'Não foi possível concluir a importação. Tente novamente; as mensagens já incorporadas não serão duplicadas.',
        );
      }
      manifest.updatedAt = new Date().toISOString();
      await this.writeManifest(manifest);
    }
  }

  private async generateWorkbook(manifest: StoredManifest) {
    const loaded = await this.loadExports(manifest);
    return createWhatsAppImportWorkbook(
      loaded.exports,
      loaded.mappings,
      manifest.channelPhoneE164,
    );
  }

  private async loadExports(manifest: StoredManifest): Promise<{
    readonly exports: ParsedWhatsAppExport[];
    readonly mappings: WhatsAppHistoryConversationMapping[];
  }> {
    const incomplete = manifest.archives.filter(
      (archive) => mappingIssues(archive, archive.mapping).length > 0,
    );
    if (manifest.archives.length === 0) {
      throw validationError(
        'Adicione pelo menos um backup antes de continuar.',
      );
    }
    if (incomplete.length > 0) {
      const description =
        incomplete.length === 1
          ? 'Uma conversa ainda precisa de revisão.'
          : `${incomplete.length} conversas ainda precisam de revisão.`;
      throw validationError(description);
    }
    const exports: ParsedWhatsAppExport[] = [];
    for (const archive of manifest.archives) {
      const archivePath = resolve(
        this.batchPath(manifest.companyId, manifest.id),
        archive.storageFileName,
      );
      assertInside(
        this.batchPath(manifest.companyId, manifest.id),
        archivePath,
      );
      const archiveStat = await stat(archivePath);
      const content = await readFile(archivePath);
      if (archiveStat.size !== content.byteLength) {
        throw validationError(
          `O backup ${archive.archiveName} está incompleto.`,
        );
      }
      const parsed = await parseWhatsAppExportArchive(
        archive.archiveName,
        content,
        this.limits,
      );
      if (parsed.archiveSha256 !== archive.archiveSha256) {
        throw validationError(`O backup ${archive.archiveName} foi alterado.`);
      }
      exports.push(parsed);
    }
    return {
      exports,
      mappings: manifest.archives.map(
        (archive) => archive.mapping as WhatsAppHistoryConversationMapping,
      ),
    };
  }

  private async previouslyImportedArchives(
    companyId: string,
    exports: readonly ParsedWhatsAppExport[],
    mappings: readonly WhatsAppHistoryConversationMapping[],
    channelPhoneE164: string,
  ): Promise<ReadonlySet<string>> {
    const mappingByArchive = new Map(
      mappings.map((mapping) => [mapping.archiveId, mapping]),
    );
    const identitiesByArchive = new Map<string, readonly string[]>();
    const externalIds: string[] = [];

    for (const parsed of exports) {
      const mapping = mappingByArchive.get(parsed.archiveId);
      if (!mapping) continue;
      const identities = identifyWhatsAppExportMessages(
        parsed,
        mapping,
        channelPhoneE164,
      ).map((identity) => identity.externalMessageId);
      identitiesByArchive.set(parsed.archiveId, identities);
      externalIds.push(...identities);
    }

    const importedIds = new Set<string>();
    for (
      let offset = 0;
      offset < externalIds.length;
      offset += EXTERNAL_REFERENCE_CHUNK_SIZE
    ) {
      const references = await this.prisma.whatsAppImportExternalRef.findMany({
        where: {
          companyId,
          entityType: 'message',
          sourceSystem: WHATSAPP_EXPORT_SOURCE_SYSTEM,
          externalId: {
            in: externalIds.slice(
              offset,
              offset + EXTERNAL_REFERENCE_CHUNK_SIZE,
            ),
          },
        },
        select: { externalId: true },
      });
      references.forEach((reference) => importedIds.add(reference.externalId));
    }

    return new Set(
      [...identitiesByArchive.entries()]
        .filter(
          ([, identities]) =>
            identities.length > 0 &&
            identities.every((externalId) => importedIds.has(externalId)),
        )
        .map(([archiveId]) => archiveId),
    );
  }

  private async retainImportedMedia(
    manifest: StoredManifest,
    exports: readonly ParsedWhatsAppExport[],
    mappings: readonly WhatsAppHistoryConversationMapping[],
  ): Promise<void> {
    const mappingByArchive = new Map(
      mappings.map((mapping) => [mapping.archiveId, mapping]),
    );

    for (const parsed of exports) {
      const mapping = mappingByArchive.get(parsed.archiveId);
      const storedArchive = manifest.archives.find(
        (archive) => archive.archiveId === parsed.archiveId,
      );
      if (!mapping || !storedArchive) continue;
      const identities = identifyWhatsAppExportMessages(
        parsed,
        mapping,
        manifest.channelPhoneE164,
      ).filter((identity) => identity.message.attachment?.entryName);
      if (identities.length === 0) continue;

      const references = new Map<string, string>();
      const externalIds = identities.map(
        (identity) => identity.externalMessageId,
      );
      for (
        let offset = 0;
        offset < externalIds.length;
        offset += EXTERNAL_REFERENCE_CHUNK_SIZE
      ) {
        const rows = await this.prisma.whatsAppImportExternalRef.findMany({
          where: {
            companyId: manifest.companyId,
            entityType: 'message',
            sourceSystem: WHATSAPP_EXPORT_SOURCE_SYSTEM,
            externalId: {
              in: externalIds.slice(
                offset,
                offset + EXTERNAL_REFERENCE_CHUNK_SIZE,
              ),
            },
          },
          select: { externalId: true, internalId: true },
        });
        rows.forEach((row) => references.set(row.externalId, row.internalId));
      }

      const messageIds = [...references.values()];
      const messages = new Map<
        string,
        { id: string; conversationId: string; media: Prisma.JsonValue | null }
      >();
      for (
        let offset = 0;
        offset < messageIds.length;
        offset += EXTERNAL_REFERENCE_CHUNK_SIZE
      ) {
        const rows = await this.prisma.whatsAppMessage.findMany({
          where: {
            companyId: manifest.companyId,
            id: {
              in: messageIds.slice(
                offset,
                offset + EXTERNAL_REFERENCE_CHUNK_SIZE,
              ),
            },
          },
          select: { id: true, conversationId: true, media: true },
        });
        rows.forEach((row) => messages.set(row.id, row));
      }

      const archivePath = resolve(
        this.batchPath(manifest.companyId, manifest.id),
        storedArchive.storageFileName,
      );
      assertInside(
        this.batchPath(manifest.companyId, manifest.id),
        archivePath,
      );
      const zip = await JSZip.loadAsync(await readFile(archivePath), {
        checkCRC32: true,
      });
      const extracted = new Map<string, Buffer>();

      for (const identity of identities) {
        const attachment = identity.message.attachment;
        const entryName = attachment?.entryName;
        const messageId = references.get(identity.externalMessageId);
        const message = messageId ? messages.get(messageId) : undefined;
        if (!attachment || !entryName || !message) continue;

        let content = extracted.get(entryName);
        if (!content) {
          const entry = zip.file(entryName);
          if (!entry) continue;
          content = await entry.async('nodebuffer');
          extracted.set(entryName, content);
        }
        if (content.byteLength < 1 || content.byteLength > 2_147_483_647) {
          throw validationError(
            `O arquivo ${attachment.fileName} possui tamanho inválido.`,
          );
        }
        if (
          attachment.sizeBytes !== null &&
          attachment.sizeBytes !== content.byteLength
        ) {
          throw validationError(
            `O arquivo ${attachment.fileName} está incompleto no backup.`,
          );
        }

        const sha256 = createHash('sha256').update(content).digest('hex');
        const storageKey = [
          'v1',
          manifest.companyId,
          message.conversationId,
          message.id,
          sha256,
        ].join('/');
        await this.mediaStorage.write({ storageKey, content });
        const currentMedia =
          message.media &&
          typeof message.media === 'object' &&
          !Array.isArray(message.media)
            ? message.media
            : {};
        await this.prisma.whatsAppMessage.updateMany({
          where: {
            id: message.id,
            companyId: manifest.companyId,
            conversationId: message.conversationId,
          },
          data: {
            kind: MESSAGE_KIND_BY_EXPORT[attachment.kind],
            media: {
              ...currentMedia,
              reference: `whatsapp-export://${parsed.archiveId}/${encodeURIComponent(
                attachment.fileName,
              )}`,
              mimeType: attachment.mimeType,
              size: content.byteLength,
              fileName: attachment.fileName,
              retentionStatus: 'stored',
            },
            mediaStorageKey: storageKey,
            mediaMimeType: attachment.mimeType,
            mediaSizeBytes: content.byteLength,
            mediaOriginalName: attachment.fileName,
            mediaSha256: sha256,
            mediaStoredAt: new Date(),
          },
        });
      }
    }
  }

  private storedArchive(
    parsed: ParsedWhatsAppExport,
    storageFileName: string,
  ): StoredArchive {
    return {
      archiveId: parsed.archiveId,
      archiveName: parsed.archiveName,
      archiveSha256: parsed.archiveSha256,
      storageFileName,
      chatFileName: parsed.chatFileName,
      suggestedContactName: parsed.suggestedContactName,
      suggestedPhoneE164: parsed.suggestedPhoneE164,
      senders: parsed.senders,
      messageCount: parsed.messageCount,
      attachmentCount: parsed.attachmentCount,
      missingAttachmentCount: parsed.missingAttachmentCount,
      startedAt: parsed.startedAt?.toISOString() ?? null,
      endedAt: parsed.endedAt?.toISOString() ?? null,
      mapping: null,
    };
  }

  private androidMediaUploadPath(
    companyId: string,
    batchId: string,
    uploadId: string,
  ): string {
    assertUuid(uploadId, 'uploadId');
    const batchPath = this.batchPath(companyId, batchId);
    const path = resolve(batchPath, 'android-media-uploads', uploadId);
    assertInside(batchPath, path);
    return path;
  }

  private androidDatabaseUploadPath(
    companyId: string,
    batchId: string,
    uploadId: string,
  ): string {
    assertUuid(uploadId, 'uploadId');
    const batchPath = this.batchPath(companyId, batchId);
    const path = resolve(batchPath, 'android-database-uploads', uploadId);
    assertInside(batchPath, path);
    return path;
  }

  private androidDatabaseArchivePath(uploadDirectory: string): string {
    const path = resolve(uploadDirectory, 'database.crypt15');
    assertInside(uploadDirectory, path);
    return path;
  }

  private async readAndroidDatabaseUpload(
    uploadDirectory: string,
  ): Promise<StoredAndroidDatabaseUpload> {
    const path = resolve(uploadDirectory, 'upload.json');
    assertInside(uploadDirectory, path);
    let upload: StoredAndroidDatabaseUpload;
    try {
      upload = JSON.parse(
        await readFile(path, 'utf8'),
      ) as StoredAndroidDatabaseUpload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw notFound('Envio do backup Android');
      }
      throw validationError('O envio do backup Android está corrompido.');
    }
    if (
      upload.schemaVersion !== '1.0' ||
      !UUID_PATTERN.test(upload.uploadId) ||
      !Number.isSafeInteger(upload.expectedBytes) ||
      !Number.isSafeInteger(upload.receivedBytes)
    ) {
      throw validationError('O envio do backup Android é inválido.');
    }
    return upload;
  }

  private async writeAndroidDatabaseUpload(
    uploadDirectory: string,
    upload: StoredAndroidDatabaseUpload,
  ): Promise<void> {
    await mkdir(uploadDirectory, { recursive: true });
    const destination = resolve(uploadDirectory, 'upload.json');
    const temporary = resolve(uploadDirectory, `upload.${randomUUID()}.tmp`);
    assertInside(uploadDirectory, destination);
    assertInside(uploadDirectory, temporary);
    await writeFile(temporary, JSON.stringify(upload), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, destination);
    await this.persistUploadSession(
      'android-database',
      upload,
      this.androidDatabaseArchivePath(uploadDirectory),
    );
  }

  private androidMediaArchivePath(uploadDirectory: string): string {
    const path = resolve(uploadDirectory, 'archive.zip');
    assertInside(uploadDirectory, path);
    return path;
  }

  private async readAndroidMediaUpload(
    uploadDirectory: string,
  ): Promise<StoredAndroidMediaUpload> {
    const path = resolve(uploadDirectory, 'upload.json');
    assertInside(uploadDirectory, path);
    let upload: StoredAndroidMediaUpload;
    try {
      upload = JSON.parse(
        await readFile(path, 'utf8'),
      ) as StoredAndroidMediaUpload;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw notFound('Envio de mídias');
      }
      throw validationError('O envio de mídias está corrompido.');
    }
    if (
      upload.schemaVersion !== '1.0' ||
      !UUID_PATTERN.test(upload.uploadId) ||
      !Number.isSafeInteger(upload.expectedBytes) ||
      !Number.isSafeInteger(upload.receivedBytes)
    ) {
      throw validationError('O envio de mídias é inválido.');
    }
    return upload;
  }

  private async writeAndroidMediaUpload(
    uploadDirectory: string,
    upload: StoredAndroidMediaUpload,
  ): Promise<void> {
    await mkdir(uploadDirectory, { recursive: true });
    const destination = resolve(uploadDirectory, 'upload.json');
    const temporary = resolve(uploadDirectory, `upload.${randomUUID()}.tmp`);
    assertInside(uploadDirectory, destination);
    assertInside(uploadDirectory, temporary);
    await writeFile(temporary, JSON.stringify(upload), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, destination);
    await this.persistUploadSession(
      'android-media',
      upload,
      this.androidMediaArchivePath(uploadDirectory),
    );
  }

  private async persistUploadSession(
    kind: 'android-database' | 'android-media',
    upload: StoredAndroidDatabaseUpload | StoredAndroidMediaUpload,
    temporaryPath: string,
  ): Promise<void> {
    const fingerprint =
      upload.fingerprint ??
      uploadFingerprint(kind, upload.originalName, upload.expectedBytes);
    upload.fingerprint = fingerprint;
    const completed = upload.status === 'completed';
    const failed = upload.status === 'failed';
    await this.prisma.whatsAppHistoryUploadSession.upsert({
      where: { id: upload.uploadId },
      create: {
        id: upload.uploadId,
        batchId: upload.batchId,
        companyId: upload.companyId,
        kind,
        fileName: upload.originalName,
        mimeType:
          kind === 'android-media'
            ? 'application/zip'
            : 'application/octet-stream',
        expectedBytes: BigInt(upload.expectedBytes),
        uploadedBytes: BigInt(upload.receivedBytes),
        fingerprint,
        checksumSha256: upload.checksumSha256 ?? null,
        temporaryPath,
        status: upload.status,
        errorMessage: 'errorMessage' in upload ? upload.errorMessage : null,
        expiresAt: new Date(Date.now() + this.retentionMs),
        completedAt: completed ? new Date() : null,
      },
      update: {
        uploadedBytes: BigInt(upload.receivedBytes),
        checksumSha256: upload.checksumSha256 ?? null,
        status: upload.status,
        errorCode: failed ? 'UPLOAD_FAILED' : null,
        errorMessage: 'errorMessage' in upload ? upload.errorMessage : null,
        expiresAt: new Date(Date.now() + this.retentionMs),
        ...(completed ? { completedAt: new Date() } : {}),
      },
    });
  }

  private async assertTemporaryQuota(
    companyId: string,
    additionalBytes: number,
  ): Promise<void> {
    const usage = await this.prisma.whatsAppHistoryUploadSession.aggregate({
      where: {
        companyId,
        status: { in: ['uploading', 'ready', 'processing', 'failed'] },
        expiresAt: { gt: new Date() },
      },
      _sum: { expectedBytes: true },
    });
    const current = usage._sum.expectedBytes ?? 0n;
    if (
      current + BigInt(additionalBytes) >
      BigInt(this.maximumTemporaryBytesPerTenant)
    ) {
      throw conflict(
        'O limite temporário de arquivos desta empresa foi atingido. Cancele uma importação antiga ou tente novamente mais tarde.',
      );
    }
  }

  private resumeAndroidMediaValidationJob(manifest: StoredManifest): void {
    const mediaImport = manifest.androidBackup?.mediaImport;
    if (
      !['draft', 'applied'].includes(manifest.status) ||
      mediaImport?.status !== 'validating' ||
      !mediaImport.uploadId ||
      !UUID_PATTERN.test(mediaImport.uploadId)
    ) {
      return;
    }
    const jobKey = `${manifest.companyId}:${manifest.id}:${mediaImport.uploadId}`;
    if (this.androidMediaValidationJobs.has(jobKey)) return;
    this.androidMediaValidationJobs.add(jobKey);
    setImmediate(() => {
      void this.runClaimedJob(
        manifest.companyId,
        manifest.id,
        'media-validation',
        () =>
          this.runAndroidMediaValidationJob(
            manifest.companyId,
            manifest.id,
            mediaImport.uploadId as string,
          ),
      ).finally(() => this.androidMediaValidationJobs.delete(jobKey));
    });
  }

  private async runAndroidMediaValidationJob(
    companyId: string,
    batchId: string,
    uploadId: string,
  ): Promise<void> {
    const uploadDirectory = this.androidMediaUploadPath(
      companyId,
      batchId,
      uploadId,
    );
    try {
      const manifest = await this.readManifest(companyId, batchId);
      const mediaImport = manifest.androidBackup?.mediaImport;
      if (
        !manifest.androidBackup ||
        !['draft', 'applied'].includes(manifest.status) ||
        mediaImport?.status !== 'validating' ||
        mediaImport.uploadId !== uploadId
      ) {
        return;
      }
      const upload = await this.readAndroidMediaUpload(uploadDirectory);
      if (upload.status !== 'validating') return;
      const archivePath = this.androidMediaArchivePath(uploadDirectory);
      const actualChecksum = await sha256File(archivePath);
      if (upload.checksumSha256 && upload.checksumSha256 !== actualChecksum) {
        throw validationError(
          'O ZIP recebido não corresponde ao checksum informado.',
        );
      }
      upload.checksumSha256 = actualChecksum;

      let stagedMediaPreview:
        | {
            filesTotal: number;
            mediaStored: number;
            mediaNew: number;
            mediaMissing: number;
          }
        | undefined;
      if (manifest.status === 'draft') {
        const mediaReferencesPath = resolve(
          this.batchPath(companyId, batchId),
          'android',
          'media-preview-references.json',
        );
        assertInside(this.batchPath(companyId, batchId), mediaReferencesPath);
        const references = JSON.parse(
          await readFile(mediaReferencesPath, 'utf8').catch(() => {
            throw validationError(
              'Aguarde a comparação das mensagens antes de concluir o ZIP de mídias.',
            );
          }),
        ) as PreviewWhatsAppAndroidMediaReference[];
        stagedMediaPreview = await this.androidMediaImporter.previewArchive(
          {
            archivePath,
            originalName: upload.originalName,
            sizeBytes: upload.expectedBytes,
          },
          references,
        );
      }

      let shouldResumeMediaImport = false;
      await this.withBatchLock(`${companyId}:${batchId}`, async () => {
        const current = await this.readManifest(companyId, batchId);
        const currentMedia = current.androidBackup?.mediaImport;
        if (
          !current.androidBackup ||
          currentMedia?.status !== 'validating' ||
          currentMedia.uploadId !== uploadId
        ) {
          return;
        }
        const shouldStage = current.status !== 'applied';
        const now = new Date().toISOString();
        upload.status = shouldStage ? 'ready' : 'processing';
        upload.updatedAt = now;
        await this.writeAndroidMediaUpload(uploadDirectory, upload);
        current.androidBackup.mediaImport = {
          ...currentMedia,
          status: shouldStage ? 'ready' : 'processing',
          phase: shouldStage ? null : 'scanning',
          processingFilesTotal: stagedMediaPreview?.filesTotal ?? 0,
          updatedAt: now,
          errorMessage: null,
        };
        if (stagedMediaPreview && current.androidBackup.comparison) {
          current.androidBackup.comparison.mediaStored =
            stagedMediaPreview.mediaStored;
          current.androidBackup.comparison.mediaNew =
            stagedMediaPreview.mediaNew;
          current.androidBackup.comparison.mediaMissing =
            stagedMediaPreview.mediaMissing;
          current.androidBackup.comparison.updatedAt = now;
        }
        current.updatedAt = now;
        await this.writeManifest(current);
        shouldResumeMediaImport = current.status === 'applied';
      });
      if (shouldResumeMediaImport) {
        const current = await this.readManifest(companyId, batchId);
        this.resumeAndroidMediaJob(current, true);
      }
    } catch (error) {
      this.logger.error(
        `Falha ao validar o ZIP de mídias do backup Android ${batchId}.`,
        error instanceof Error ? error.stack : String(error),
      );
      const message = publicImportError(
        error,
        'Não foi possível validar o ZIP de mídias. Tente novamente.',
      );
      const upload = await this.readAndroidMediaUpload(uploadDirectory).catch(
        () => null,
      );
      if (upload) {
        upload.status = 'failed';
        upload.updatedAt = new Date().toISOString();
        await this.writeAndroidMediaUpload(uploadDirectory, upload).catch(
          () => undefined,
        );
      }
      await this.withBatchLock(`${companyId}:${batchId}`, async () => {
        const current = await this.readManifest(companyId, batchId);
        const currentMedia = current.androidBackup?.mediaImport;
        if (!currentMedia || currentMedia.uploadId !== uploadId) return;
        currentMedia.status = 'failed';
        currentMedia.phase = null;
        currentMedia.errorMessage = message;
        currentMedia.updatedAt = new Date().toISOString();
        current.updatedAt = currentMedia.updatedAt;
        await this.writeManifest(current);
      }).catch(() => undefined);
    }
  }

  private resumeAndroidMediaJob(
    manifest: StoredManifest,
    resumeAfterActiveJob = false,
  ): void {
    const mediaImport = manifest.androidBackup?.mediaImport;
    if (
      manifest.status !== 'applied' ||
      mediaImport?.status !== 'processing' ||
      !mediaImport.uploadId ||
      !UUID_PATTERN.test(mediaImport.uploadId)
    ) {
      return;
    }
    const jobKey = `${manifest.companyId}:${manifest.id}:${mediaImport.uploadId}`;
    if (this.androidMediaJobs.has(jobKey)) {
      if (resumeAfterActiveJob) {
        // A tentativa anterior pode estar terminando no mesmo instante em que
        // o usuário solicita a retomada. Reconfira o manifesto quando ela
        // liberar a chave para não perder essa nova execução.
        this.androidMediaJobResumeRequested.add(jobKey);
      }
      return;
    }
    this.androidMediaJobs.add(jobKey);
    setImmediate(() => {
      void this.runClaimedJob(manifest.companyId, manifest.id, 'media', () =>
        this.runAndroidMediaJob(
          manifest.companyId,
          manifest.id,
          mediaImport.uploadId as string,
        ),
      ).finally(() => {
        this.androidMediaJobs.delete(jobKey);
        if (!this.androidMediaJobResumeRequested.delete(jobKey)) return;
        void this.readManifest(manifest.companyId, manifest.id)
          .then((current) => this.resumeAndroidMediaJob(current))
          .catch(() => undefined);
      });
    });
  }

  private async runAndroidMediaJob(
    companyId: string,
    batchId: string,
    uploadId: string,
  ): Promise<void> {
    const uploadDirectory = this.androidMediaUploadPath(
      companyId,
      batchId,
      uploadId,
    );
    try {
      const upload = await this.readAndroidMediaUpload(uploadDirectory);
      const archivePath = this.androidMediaArchivePath(uploadDirectory);
      let lastProgressPersistedAt = 0;
      const result = await this.androidMediaImporter.attachArchive({
        companyId,
        batchId,
        archivePath,
        originalName: upload.originalName,
        sizeBytes: upload.expectedBytes,
        onProgress: async (progress) => {
          const nowMs = Date.now();
          const completed =
            progress.filesTotal > 0 &&
            progress.filesProcessed >= progress.filesTotal;
          if (!completed && nowMs - lastProgressPersistedAt < 2_000) return;
          lastProgressPersistedAt = nowMs;
          await this.withBatchLock(`${companyId}:${batchId}`, async () => {
            const manifest = await this.readManifest(companyId, batchId);
            const mediaImport = manifest.androidBackup?.mediaImport;
            if (
              !mediaImport ||
              mediaImport.uploadId !== uploadId ||
              mediaImport.status !== 'processing'
            ) {
              return;
            }
            mediaImport.phase = progress.phase;
            mediaImport.processingFilesScanned = progress.filesScanned;
            mediaImport.processingFilesTotal = progress.filesTotal;
            mediaImport.processingFilesProcessed = progress.filesProcessed;
            mediaImport.processingAttached = progress.attached;
            mediaImport.updatedAt = new Date().toISOString();
            manifest.updatedAt = mediaImport.updatedAt;
            await this.writeManifest(manifest);
          });
        },
      });
      await this.withBatchLock(`${companyId}:${batchId}`, async () => {
        const manifest = await this.readManifest(companyId, batchId);
        const mediaImport = manifest.androidBackup?.mediaImport;
        if (!manifest.androidBackup || mediaImport?.uploadId !== uploadId)
          return;
        const now = new Date().toISOString();
        manifest.androidBackup.mediaImport = {
          ...mediaImport,
          archivesProcessed: mediaImport.archivesProcessed + 1,
          filesScanned: mediaImport.filesScanned + result.filesScanned,
          stored: result.alreadyStored + result.attached,
          pending: result.missing,
          ambiguous: mediaImport.ambiguous + result.ambiguous,
          skippedOversize: mediaImport.skippedOversize + result.skippedOversize,
          updatedAt: now,
          status: 'completed',
          phase: null,
          uploadId: null,
          processingFilesScanned: result.filesScanned,
          processingFilesTotal: result.filesScanned,
          processingFilesProcessed: result.filesScanned,
          processingAttached: result.attached,
          errorMessage: null,
        };
        if (manifest.androidBackup.comparison) {
          manifest.androidBackup.comparison.mediaStored = result.alreadyStored;
          manifest.androidBackup.comparison.mediaNew = result.attached;
          manifest.androidBackup.comparison.mediaMissing = result.missing;
          manifest.androidBackup.comparison.updatedAt = now;
        }
        manifest.updatedAt = now;
        await this.writeManifest(manifest);
      });
      upload.status = 'completed';
      upload.updatedAt = new Date().toISOString();
      await this.writeAndroidMediaUpload(uploadDirectory, upload);
      await rm(uploadDirectory, { recursive: true, force: true });
    } catch (error) {
      this.logger.error(
        `Falha ao vincular as mídias do backup Android ${batchId}.`,
        error instanceof Error ? error.stack : String(error),
      );
      const message = publicImportError(
        error,
        'Não foi possível processar o ZIP de mídias. Tente novamente; os arquivos já armazenados serão preservados.',
      );
      const upload = await this.readAndroidMediaUpload(uploadDirectory).catch(
        () => null,
      );
      if (upload) {
        upload.status = 'failed';
        upload.updatedAt = new Date().toISOString();
        await this.writeAndroidMediaUpload(uploadDirectory, upload).catch(
          () => undefined,
        );
      }
      await this.withBatchLock(`${companyId}:${batchId}`, async () => {
        const manifest = await this.readManifest(companyId, batchId);
        const mediaImport = manifest.androidBackup?.mediaImport;
        if (!mediaImport || mediaImport.uploadId !== uploadId) return;
        mediaImport.status = 'failed';
        mediaImport.phase = null;
        mediaImport.errorMessage = message;
        mediaImport.updatedAt = new Date().toISOString();
        manifest.updatedAt = mediaImport.updatedAt;
        await this.writeManifest(manifest);
      }).catch(() => undefined);
    }
  }

  private batchPath(companyId: string, batchId: string): string {
    assertUuid(companyId, 'companyId');
    assertUuid(batchId, 'batchId');
    const path = resolve(this.root, 'history-batches', companyId, batchId);
    assertInside(this.root, path);
    return path;
  }

  private manifestPath(companyId: string, batchId: string): string {
    return resolve(this.batchPath(companyId, batchId), MANIFEST_FILE);
  }

  private androidDivergencesPath(companyId: string, batchId: string): string {
    const path = resolve(
      this.batchPath(companyId, batchId),
      'android',
      ANDROID_DIVERGENCES_FILE,
    );
    assertInside(this.batchPath(companyId, batchId), path);
    return path;
  }

  private async readAndroidDivergences(
    companyId: string,
    batchId: string,
    required: boolean,
  ): Promise<StoredAndroidDivergence[]> {
    try {
      const content = await readFile(
        this.androidDivergencesPath(companyId, batchId),
        'utf8',
      );
      const parsed = JSON.parse(content) as unknown;
      if (!Array.isArray(parsed)) throw new Error('invalid');
      return parsed as StoredAndroidDivergence[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !required) {
        return [];
      }
      throw validationError(
        'A comparação das mensagens divergentes precisa ser executada novamente.',
      );
    }
  }

  private async writeAndroidDivergences(
    companyId: string,
    batchId: string,
    divergences: readonly StoredAndroidDivergence[],
  ): Promise<void> {
    const destination = this.androidDivergencesPath(companyId, batchId);
    await mkdir(resolve(destination, '..'), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    assertInside(this.batchPath(companyId, batchId), temporary);
    await writeFile(temporary, JSON.stringify(divergences), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, destination);
  }

  private async tryReadManifest(
    companyId: string,
    batchId: string,
  ): Promise<StoredManifest | null> {
    try {
      return await this.readManifest(companyId, batchId);
    } catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  private async readManifest(
    companyId: string,
    batchId: string,
  ): Promise<StoredManifest> {
    let manifest: StoredManifest;
    const durable = await this.prisma.whatsAppHistoryImportState.findFirst({
      where: { id: batchId, companyId },
      select: { manifest: true },
    });
    if (durable) {
      manifest = durable.manifest as unknown as StoredManifest;
    } else {
      let content: string;
      try {
        content = await readFile(this.manifestPath(companyId, batchId), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw notFound('Lote de importação');
        }
        throw error;
      }
      try {
        manifest = JSON.parse(content) as StoredManifest;
      } catch {
        throw validationError('O lote de importação está corrompido.');
      }
    }
    if (
      manifest.schemaVersion !== MANIFEST_VERSION ||
      manifest.id !== batchId ||
      manifest.companyId !== companyId ||
      !Array.isArray(manifest.archives)
    ) {
      throw validationError('O lote de importação é inválido.');
    }
    manifest.androidBackup ??= null;
    manifest.androidDatabaseUpload ??= null;
    manifest.phase ??= importPhase(manifest);
    manifest.heartbeatAt ??= manifest.updatedAt;
    manifest.attempts ??= 0;
    manifest.lastError ??= null;
    manifest.cancelledAt ??= null;
    if (
      new Date(manifest.expiresAt) < new Date() &&
      manifest.status === 'draft'
    ) {
      manifest.status = 'expired';
      manifest.phase = 'expired';
      manifest.updatedAt = new Date().toISOString();
      await this.persistDurableManifest(manifest);
      await rm(this.batchPath(companyId, batchId), {
        recursive: true,
        force: true,
      });
      throw validationError('Este lote expirou. Inicie uma nova importação.');
    }
    if (!durable) await this.persistDurableManifest(manifest);
    return manifest;
  }

  private async writeManifest(manifest: StoredManifest): Promise<void> {
    const cancellationKey = `${manifest.companyId}:${manifest.id}`;
    const durableState =
      manifest.status === 'cancelled'
        ? null
        : await this.prisma.whatsAppHistoryImportState.findUnique({
            where: { id: manifest.id },
            select: { companyId: true, status: true },
          });
    if (
      manifest.status !== 'cancelled' &&
      (this.cancelledBatches.has(cancellationKey) ||
        (durableState?.companyId === manifest.companyId &&
          durableState.status === 'cancelled'))
    ) {
      throw conflict('Esta importação foi cancelada.');
    }
    const directory = this.batchPath(manifest.companyId, manifest.id);
    await mkdir(directory, { recursive: true });
    const destination = this.manifestPath(manifest.companyId, manifest.id);
    const temporary = resolve(
      directory,
      `${MANIFEST_FILE}.${randomUUID()}.tmp`,
    );
    assertInside(directory, temporary);
    await writeFile(temporary, JSON.stringify(manifest), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, destination);
    await this.persistDurableManifest(manifest);
  }

  private durableStatus(manifest: StoredManifest): string {
    if (manifest.status === 'applied') {
      return ['validating', 'processing'].includes(
        manifest.androidBackup?.mediaImport?.status ?? '',
      )
        ? 'processing-media'
        : 'completed';
    }
    if (manifest.status === 'applying') return 'applying';
    if (manifest.status === 'failed') return 'failed';
    if (manifest.status === 'cancelled') return 'cancelled';
    if (manifest.status === 'expired') return 'expired';
    const phase = importPhase(manifest);
    if (phase.startsWith('uploading')) return 'uploading';
    if (phase.startsWith('validating')) return 'validating';
    if (phase.startsWith('comparing')) return 'processing';
    if (phase === 'awaiting-divergence-resolution') return phase;
    if (phase === 'ready') return 'ready';
    return 'draft';
  }

  private async persistDurableManifest(
    manifest: StoredManifest,
  ): Promise<void> {
    const now = new Date();
    const progress = importProgress(manifest);
    const phase = importPhase(manifest);
    manifest.phase = phase;
    manifest.heartbeatAt = now.toISOString();
    const durableStatus = this.durableStatus(manifest);
    const error = manifest.lastError;
    const finished = ['completed', 'cancelled', 'expired'].includes(
      durableStatus,
    );
    await this.prisma.whatsAppHistoryImportState.upsert({
      where: { id: manifest.id },
      create: {
        id: manifest.id,
        companyId: manifest.companyId,
        channelId: manifest.channelId,
        actorUserId: manifest.actorUserId,
        status: durableStatus,
        phase,
        manifest: manifest as unknown as Prisma.InputJsonValue,
        total: progress.total,
        processed: progress.processed,
        failed: progress.failed,
        attempts: manifest.attempts ?? 0,
        heartbeatAt: now,
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null,
        errorRetryable: error?.retryable ?? null,
        errorOccurredAt: error ? new Date(error.occurredAt) : null,
        expiresAt: new Date(manifest.expiresAt),
        cancelledAt: manifest.cancelledAt
          ? new Date(manifest.cancelledAt)
          : null,
        finishedAt: finished ? now : null,
        createdAt: new Date(manifest.createdAt),
      },
      update: {
        channelId: manifest.channelId,
        actorUserId: manifest.actorUserId,
        status: durableStatus,
        phase,
        manifest: manifest as unknown as Prisma.InputJsonValue,
        total: progress.total,
        processed: progress.processed,
        failed: progress.failed,
        attempts: manifest.attempts ?? 0,
        heartbeatAt: now,
        errorCode: error?.code ?? null,
        errorMessage: error?.message ?? null,
        errorRetryable: error?.retryable ?? null,
        errorOccurredAt: error ? new Date(error.occurredAt) : null,
        expiresAt: new Date(manifest.expiresAt),
        cancelledAt: manifest.cancelledAt
          ? new Date(manifest.cancelledAt)
          : null,
        ...(finished ? { finishedAt: now } : {}),
      },
    });
    await this.prisma.whatsAppHistoryImportState.updateMany({
      where: { id: manifest.id, leaseOwner: this.instanceId },
      data: {
        heartbeatAt: now,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
      },
    });
  }

  private async claimBatch(
    companyId: string,
    batchId: string,
  ): Promise<boolean> {
    const now = new Date();
    const claimed = await this.prisma.whatsAppHistoryImportState.updateMany({
      where: {
        id: batchId,
        companyId,
        status: {
          notIn: ['completed', 'cancelled', 'expired'],
        },
        OR: [
          { leaseOwner: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        leaseOwner: this.instanceId,
        leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
        heartbeatAt: now,
        attempts: { increment: 1 },
      },
    });
    return claimed.count === 1;
  }

  private async releaseBatch(
    companyId: string,
    batchId: string,
  ): Promise<void> {
    await this.prisma.whatsAppHistoryImportState.updateMany({
      where: { id: batchId, companyId, leaseOwner: this.instanceId },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
  }

  private async runClaimedJob(
    companyId: string,
    batchId: string,
    phase: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    if (!(await this.claimBatch(companyId, batchId))) return;
    const startedAt = Date.now();
    const heartbeatTimer = setInterval(
      () => {
        const now = new Date();
        void this.prisma.whatsAppHistoryImportState
          .updateMany({
            where: { id: batchId, companyId, leaseOwner: this.instanceId },
            data: {
              heartbeatAt: now,
              leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
            },
          })
          .catch(() => undefined);
      },
      Math.max(5_000, Math.floor(this.leaseMs / 3)),
    );
    heartbeatTimer.unref();
    this.logger.log(
      JSON.stringify({
        event: 'whatsapp_history_import_job_started',
        companyId,
        batchId,
        phase,
      }),
    );
    try {
      const claimedManifest = await this.readManifest(companyId, batchId);
      claimedManifest.attempts = (claimedManifest.attempts ?? 0) + 1;
      claimedManifest.updatedAt = new Date().toISOString();
      await this.writeManifest(claimedManifest);
      await operation();
    } finally {
      clearInterval(heartbeatTimer);
      await this.releaseBatch(companyId, batchId).catch(() => undefined);
      const memory = process.memoryUsage();
      this.logger.log(
        JSON.stringify({
          event: 'whatsapp_history_import_job_finished',
          companyId,
          batchId,
          phase,
          durationMs: Date.now() - startedAt,
          heapUsedBytes: memory.heapUsed,
          rssBytes: memory.rss,
        }),
      );
      const current = await this.readManifest(companyId, batchId).catch(
        () => null,
      );
      if (current) {
        this.resumeAndroidPreview(current);
        this.resumeAndroidImport(current);
        this.resumeAndroidMediaValidationJob(current);
        this.resumeAndroidMediaJob(current);
      }
    }
  }

  private async recoverDurableJobs(): Promise<void> {
    const now = new Date();
    const rows = await this.prisma.whatsAppHistoryImportState.findMany({
      where: {
        status: {
          in: ['validating', 'processing', 'applying', 'processing-media'],
        },
        OR: [
          { leaseOwner: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      take: 100,
      select: { manifest: true },
    });
    for (const row of rows) {
      const manifest = row.manifest as unknown as StoredManifest;
      this.resumeAndroidPreview(manifest);
      this.resumeAndroidImport(manifest);
      this.resumeAndroidMediaValidationJob(manifest);
      this.resumeAndroidMediaJob(manifest);
    }
    if (rows.length > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'whatsapp_history_import_recovery_scheduled',
          jobs: rows.length,
        }),
      );
    }
  }

  private async cleanupExpiredImports(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.whatsAppHistoryImportState.findMany({
      where: {
        expiresAt: { lt: now },
        status: { in: ['draft', 'uploading', 'validating', 'ready', 'failed'] },
      },
      take: 100,
      select: { id: true, companyId: true, manifest: true },
    });
    for (const row of expired) {
      const manifest = row.manifest as unknown as StoredManifest;
      manifest.status = 'expired';
      manifest.phase = 'expired';
      manifest.updatedAt = new Date().toISOString();
      await this.persistDurableManifest(manifest);
      await this.prisma.whatsAppHistoryUploadSession.updateMany({
        where: { companyId: row.companyId, batchId: row.id },
        data: { status: 'expired' },
      });
      await rm(this.batchPath(row.companyId, row.id), {
        recursive: true,
        force: true,
      });
      await this.audit({
        companyId: row.companyId,
        batchId: row.id,
        action: 'batch.expired',
        phase: 'retention',
      });
    }

    const expiredUploads =
      await this.prisma.whatsAppHistoryUploadSession.findMany({
        where: {
          expiresAt: { lt: now },
          status: { notIn: ['cancelled', 'expired'] },
        },
        take: 200,
        select: {
          id: true,
          batchId: true,
          companyId: true,
          temporaryPath: true,
        },
      });
    for (const upload of expiredUploads) {
      const batchDirectory = this.batchPath(upload.companyId, upload.batchId);
      const uploadDirectory = dirname(upload.temporaryPath);
      assertInside(batchDirectory, uploadDirectory);
      await rm(uploadDirectory, { recursive: true, force: true });
      await this.prisma.whatsAppHistoryUploadSession.updateMany({
        where: { id: upload.id, companyId: upload.companyId },
        data: { status: 'expired' },
      });
      await this.audit({
        companyId: upload.companyId,
        batchId: upload.batchId,
        uploadId: upload.id,
        action: 'upload.expired',
        phase: 'retention',
      });
    }
  }

  private async audit(input: {
    companyId: string;
    batchId: string;
    action: string;
    phase?: string | null;
    uploadId?: string | null;
    actorUserId?: string | null;
    actorUsername?: string | null;
    oldValue?: Prisma.InputJsonValue;
    newValue?: Prisma.InputJsonValue;
    metadata?: Prisma.InputJsonValue;
  }): Promise<void> {
    await this.prisma.whatsAppHistoryImportAuditEvent.create({
      data: {
        companyId: input.companyId,
        batchId: input.batchId,
        action: input.action,
        phase: input.phase ?? null,
        uploadId: input.uploadId ?? null,
        actorUserId: input.actorUserId ?? null,
        actorUsername: input.actorUsername ?? null,
        ...(input.oldValue === undefined ? {} : { oldValue: input.oldValue }),
        ...(input.newValue === undefined ? {} : { newValue: input.newValue }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      },
    });
  }

  async cancel(
    companyId: string,
    batchId: string,
    actorUserId: string,
    actorUsername: string,
  ) {
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const manifest = await this.readManifest(companyId, batchId);
      if (manifest.status === 'applied') {
        throw conflict('Uma importação concluída não pode ser cancelada.');
      }
      if (manifest.status === 'cancelled') return presentManifest(manifest);
      const now = new Date().toISOString();
      this.cancelledBatches.add(`${companyId}:${batchId}`);
      manifest.status = 'cancelled';
      manifest.phase = 'cancelled';
      manifest.cancelledAt = now;
      manifest.updatedAt = now;
      await this.writeManifest(manifest);
      await this.prisma.whatsAppHistoryImportState.updateMany({
        where: { id: batchId, companyId },
        data: { leaseOwner: null, leaseExpiresAt: null },
      });
      await this.prisma.whatsAppHistoryUploadSession.updateMany({
        where: {
          batchId,
          companyId,
          status: { notIn: ['completed', 'cancelled'] },
        },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      await this.audit({
        companyId,
        batchId,
        actorUserId,
        actorUsername,
        action: 'batch.cancelled',
        phase: 'cancelled',
      });
      await rm(this.batchPath(companyId, batchId), {
        recursive: true,
        force: true,
      });
      return presentManifest(manifest);
    });
  }

  async cancelUpload(
    companyId: string,
    batchId: string,
    uploadId: string,
    actorUserId: string,
    actorUsername: string,
  ) {
    assertUuid(uploadId, 'uploadId');
    return this.withBatchLock(`${companyId}:${batchId}`, async () => {
      const upload = await this.prisma.whatsAppHistoryUploadSession.findFirst({
        where: { id: uploadId, batchId, companyId },
      });
      if (!upload) throw notFound('Envio');
      if (upload.status === 'completed') {
        throw conflict('Um envio concluído não pode ser cancelado.');
      }
      if (upload.status !== 'cancelled') {
        await this.prisma.whatsAppHistoryUploadSession.updateMany({
          where: { id: uploadId, batchId, companyId },
          data: {
            status: 'cancelled',
            cancelledAt: new Date(),
            errorCode: null,
            errorMessage: null,
          },
        });
      }

      const manifest = await this.readManifest(companyId, batchId);
      if (manifest.androidDatabaseUpload?.uploadId === uploadId) {
        manifest.androidDatabaseUpload = null;
      }
      const mediaImport = manifest.androidBackup?.mediaImport;
      if (mediaImport?.uploadId === uploadId) {
        mediaImport.status = 'failed';
        mediaImport.phase = null;
        mediaImport.uploadId = null;
        mediaImport.uploadBytesReceived = 0;
        mediaImport.uploadBytesTotal = 0;
        mediaImport.errorMessage = 'Envio cancelado.';
        mediaImport.updatedAt = new Date().toISOString();
      }
      manifest.updatedAt = new Date().toISOString();
      await this.writeManifest(manifest);

      const batchDirectory = this.batchPath(companyId, batchId);
      const uploadDirectory = resolve(upload.temporaryPath, '..');
      assertInside(batchDirectory, uploadDirectory);
      await rm(uploadDirectory, { recursive: true, force: true });
      await this.audit({
        companyId,
        batchId,
        uploadId,
        actorUserId,
        actorUsername,
        action: 'upload.cancelled',
        phase: upload.kind,
        metadata: {
          fileName: upload.fileName,
          uploadedBytes: upload.uploadedBytes.toString(),
          expectedBytes: upload.expectedBytes.toString(),
        },
      });
      return { uploadId, status: 'cancelled' as const };
    });
  }

  private async withBatchLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WhatsAppMediaStorage } from '../../../application/contracts/whatsapp-media.storage';
import {
  MAXIMUM_PANEL_ATTACHMENT_BYTES,
  PANEL_ARCHIVE_MIME_TYPES,
} from '../../../domain/whatsapp/whatsapp-media-policy';
import {
  AppError,
  conversionNotSupported,
  externalServiceUnavailable,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import {
  MessageDirection,
  MessageKind,
} from '../../database/prisma/generated/client';
import { PrismaService } from '../../database/prisma/prisma.service';

type JsonObject = Readonly<Record<string, unknown>>;

const MEDIA_KINDS = new Set<MessageKind>([
  MessageKind.IMAGE,
  MessageKind.DOCUMENT,
  MessageKind.AUDIO,
  MessageKind.VIDEO,
  MessageKind.STICKER,
  MessageKind.CONTACT,
]);

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/vcard': '.vcf',
  'text/x-vcard': '.vcf',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

const RESERVED_FILE_NAME_CHARACTERS = new Set([
  '"',
  '<',
  '>',
  ':',
  '|',
  '?',
  '*',
]);

export interface WhatsAppMediaContent {
  readonly content: Buffer;
  readonly fileName: string;
  readonly mimeType: string;
  readonly kind:
    'image' | 'document' | 'audio' | 'video' | 'sticker' | 'contact';
}

interface MediaMessageRow {
  readonly id: string;
  readonly companyId: string;
  readonly conversationId: string;
  readonly providerMessageId: string | null;
  readonly direction: MessageDirection;
  readonly kind: MessageKind;
  readonly media: unknown;
  readonly mediaStorageKey: string | null;
  readonly mediaMimeType: string | null;
  readonly mediaSizeBytes: number | null;
  readonly mediaOriginalName: string | null;
  readonly mediaSha256: string | null;
  readonly mediaStoredAt: Date | null;
  readonly proposalDocument: {
    readonly content: Uint8Array;
    readonly fileName: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  } | null;
}

export interface RetainWhatsAppMediaResult {
  readonly status: 'stored' | 'already-stored' | 'unavailable' | 'too-large';
  readonly messageId: string;
  readonly sizeBytes?: number;
  readonly mimeType?: string;
}

function optionalObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function normalizeMimeType(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().split(';')[0]
    : '';
}

function canonicalKind(kind: MessageKind): WhatsAppMediaContent['kind'] {
  switch (kind) {
    case MessageKind.IMAGE:
      return 'image';
    case MessageKind.DOCUMENT:
      return 'document';
    case MessageKind.AUDIO:
      return 'audio';
    case MessageKind.VIDEO:
      return 'video';
    case MessageKind.STICKER:
      return 'sticker';
    case MessageKind.CONTACT:
      return 'contact';
    default:
      throw notFound('Conteúdo da mídia');
  }
}

function isMimeCompatible(kind: MessageKind, mimeType: string): boolean {
  switch (kind) {
    case MessageKind.IMAGE:
    case MessageKind.STICKER:
      return mimeType.startsWith('image/');
    case MessageKind.AUDIO:
      return mimeType.startsWith('audio/');
    case MessageKind.VIDEO:
      return mimeType.startsWith('video/');
    case MessageKind.DOCUMENT:
      return true;
    case MessageKind.CONTACT:
      return mimeType === 'text/vcard' || mimeType === 'text/x-vcard';
    default:
      return false;
  }
}

function decodeBase64(value: unknown, maximumBytes: number): Buffer {
  if (typeof value !== 'string' || !value.trim()) {
    throw conversionNotSupported(
      'A mídia não pôde ser recuperada para visualização.',
    );
  }

  const dataUrl = /^data:[^;]+;base64,(.*)$/s.exec(value.trim());
  const compact = (dataUrl?.[1] ?? value).replace(/\s+/g, '');
  if (
    !compact ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw conversionNotSupported('A mídia recebida possui conteúdo inválido.');
  }

  const withoutPadding = compact.replace(/=+$/g, '');
  const padded = withoutPadding.padEnd(
    Math.ceil(withoutPadding.length / 4) * 4,
    '=',
  );
  const estimatedBytes =
    Math.floor((padded.length * 3) / 4) -
    (padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0);
  if (estimatedBytes < 1 || estimatedBytes > maximumBytes) {
    throw validationError(
      'A mídia excede o limite permitido para visualização.',
    );
  }

  const content = Buffer.from(padded, 'base64');
  if (
    content.byteLength < 1 ||
    content.byteLength > maximumBytes ||
    content.toString('base64').replace(/=+$/g, '') !== withoutPadding
  ) {
    throw conversionNotSupported('A mídia recebida possui conteúdo inválido.');
  }

  return content;
}

function replaceUnsafeFileNameCharacters(value: string): string {
  return Array.from(value)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const unsafe =
        codePoint <= 0x1f ||
        codePoint === 0x7f ||
        RESERVED_FILE_NAME_CHARACTERS.has(character);
      return unsafe ? '_' : character;
    })
    .join('');
}

function normalizedFileName(
  value: unknown,
  kind: MessageKind,
  mimeType: string,
  messageId: string,
): string {
  const raw =
    typeof value === 'string' ? (value.split(/[\\/]/).pop() ?? '').trim() : '';
  const safeName = replaceUnsafeFileNameCharacters(raw).slice(0, 180);
  const removedEncryptedSuffix = safeName.replace(/\.enc$/i, '');
  const extension = MIME_EXTENSIONS[mimeType] ?? '';
  const fallback = `whatsapp-${canonicalKind(kind)}-${messageId.slice(0, 8)}`;
  let fileName = removedEncryptedSuffix || fallback;

  const currentExtension = /\.[a-z0-9]{1,10}$/i
    .exec(fileName)?.[0]
    ?.toLowerCase();
  const shouldReplaceExtension =
    Boolean(extension) &&
    (!currentExtension ||
      (kind !== MessageKind.DOCUMENT && currentExtension !== extension));

  if (shouldReplaceExtension) {
    fileName = currentExtension
      ? `${fileName.slice(0, -currentExtension.length)}${extension}`
      : `${fileName}${extension}`;
  }

  return fileName.slice(0, 200);
}

function unavailableMedia(): AppError {
  return new AppError(
    'NOT_FOUND',
    'Este arquivo não está mais disponível. Mídias antigas que expiraram antes do armazenamento próprio não podem ser recuperadas.',
  );
}

@Injectable()
export class EvolutionMediaContentService {
  private readonly baseUrl: string;
  private readonly instanceName: string;
  private readonly apiKey: string;
  private readonly maximumBytes: number;
  private readonly panelMaximumBytes: number;
  private readonly allowedMimeTypes: ReadonlySet<string>;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: WhatsAppMediaStorage,
    config: ConfigService,
  ) {
    this.baseUrl = (config.get<string>('EVOLUTION_BASE_URL') ?? '').replace(
      /\/+$/,
      '',
    );
    this.instanceName = config.get<string>('EVOLUTION_INSTANCE_NAME') ?? '';
    this.apiKey = config.get<string>('EVOLUTION_API_KEY') ?? '';
    this.maximumBytes =
      config.get<number>('WHATSAPP_MAX_ATTACHMENT_BYTES') ?? 52_428_800;
    this.panelMaximumBytes =
      config.get<number>('WHATSAPP_PANEL_MAX_ATTACHMENT_BYTES') ??
      MAXIMUM_PANEL_ATTACHMENT_BYTES;
    this.requestTimeoutMs =
      config.get<number>('EVOLUTION_MEDIA_CONTENT_TIMEOUT_MS') ?? 30_000;
    this.allowedMimeTypes = new Set([
      ...(config.get<string>('WHATSAPP_ALLOWED_MIME_TYPES') ?? '')
        .split(',')
        .map((item) => normalizeMimeType(item))
        .filter(Boolean),
      'text/vcard',
      'text/x-vcard',
      ...PANEL_ARCHIVE_MIME_TYPES,
    ]);
  }

  async getContent(
    companyId: string,
    conversationId: string,
    messageId: string,
  ): Promise<WhatsAppMediaContent> {
    const message = await this.findMessage(
      companyId,
      conversationId,
      messageId,
    );
    if (
      message.direction === MessageDirection.OUTBOUND &&
      message.proposalDocument
    ) {
      return this.proposalContent(message);
    }
    const stored = await this.readStoredContent(message);
    if (stored) return stored;
    if (message.direction !== MessageDirection.INBOUND) {
      throw unavailableMedia();
    }

    try {
      return (await this.ensureStored(message)).content;
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') {
        await this.markRetentionStatus(message, 'unavailable');
        throw unavailableMedia();
      }
      throw error;
    }
  }

  async retainInbound(
    companyId: string,
    conversationId: string,
    messageId: string,
  ): Promise<RetainWhatsAppMediaResult> {
    const message = await this.findMessage(
      companyId,
      conversationId,
      messageId,
    );
    if (message.direction !== MessageDirection.INBOUND) {
      throw validationError('Somente mídias recebidas podem ser armazenadas.');
    }

    return this.retainEvolutionMedia(message);
  }

  async retainWebhookMedia(
    companyId: string,
    conversationId: string,
    messageId: string,
  ): Promise<RetainWhatsAppMediaResult> {
    const message = await this.findMessage(
      companyId,
      conversationId,
      messageId,
    );
    return this.retainEvolutionMedia(message);
  }

  private async retainEvolutionMedia(
    message: MediaMessageRow,
  ): Promise<RetainWhatsAppMediaResult> {
    const messageId = message.id;

    try {
      const retained = await this.ensureStored(message);
      return {
        status: retained.alreadyStored ? 'already-stored' : 'stored',
        messageId,
        sizeBytes: retained.content.content.byteLength,
        mimeType: retained.content.mimeType,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') {
        await this.markRetentionStatus(message, 'unavailable');
        return { status: 'unavailable', messageId };
      }
      if (
        error instanceof AppError &&
        error.details?.retentionStatus === 'too-large'
      ) {
        await this.markRetentionStatus(message, 'too-large');
        return { status: 'too-large', messageId };
      }
      throw error;
    }
  }

  private async ensureStored(message: MediaMessageRow): Promise<{
    readonly content: WhatsAppMediaContent;
    readonly alreadyStored: boolean;
  }> {
    const stored = await this.readStoredContent(message);
    if (stored) {
      if (optionalObject(message.media)?.retentionStatus !== 'stored') {
        await this.markRetentionStatus(message, 'stored');
      }
      return { content: stored, alreadyStored: true };
    }

    if (optionalObject(message.media)?.retentionStatus === 'too-large') {
      throw new AppError(
        'VALIDATION_ERROR',
        'Este arquivo excede o limite permitido para armazenamento.',
        { retentionStatus: 'too-large' },
      );
    }

    const content = await this.fetchEvolutionContent(message);
    await this.persistContent(message, content);
    return { content, alreadyStored: false };
  }

  private async readStoredContent(
    message: MediaMessageRow,
  ): Promise<WhatsAppMediaContent | null> {
    if (
      !message.mediaStorageKey ||
      !message.mediaMimeType ||
      !message.mediaSizeBytes ||
      !message.mediaOriginalName ||
      !message.mediaSha256 ||
      !message.mediaStoredAt
    ) {
      return null;
    }

    let content: Buffer;
    try {
      content = await this.storage.read(message.mediaStorageKey);
    } catch {
      return null;
    }
    const digest = createHash('sha256').update(content).digest('hex');
    if (
      content.byteLength !== message.mediaSizeBytes ||
      content.byteLength < 1 ||
      content.byteLength >
        Math.max(this.maximumBytes, this.panelMaximumBytes) ||
      digest !== message.mediaSha256 ||
      !this.allowedMimeTypes.has(message.mediaMimeType) ||
      !isMimeCompatible(message.kind, message.mediaMimeType)
    ) {
      return null;
    }
    return {
      content,
      fileName: message.mediaOriginalName,
      mimeType: message.mediaMimeType,
      kind: canonicalKind(message.kind),
    };
  }

  private async fetchEvolutionContent(
    message: MediaMessageRow,
  ): Promise<WhatsAppMediaContent> {
    if (!message.providerMessageId) {
      throw unavailableMedia();
    }
    if (!this.baseUrl || !this.instanceName || !this.apiKey) {
      throw externalServiceUnavailable(
        'A mídia não está disponível para recuperação neste momento.',
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(this.instanceName)}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            apikey: this.apiKey,
          },
          body: JSON.stringify({
            message: { key: { id: message.providerMessageId } },
            ...(message.kind === MessageKind.AUDIO
              ? { convertToMp4: true }
              : {}),
          }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        },
      );
    } catch {
      throw externalServiceUnavailable(
        'Não foi possível recuperar a mídia neste momento.',
      );
    }

    if (response.status === 400 || response.status === 404) {
      throw unavailableMedia();
    }
    if (!response.ok) {
      throw externalServiceUnavailable(
        'Não foi possível disponibilizar a mídia neste momento.',
        { providerStatus: response.status },
      );
    }

    let providerPayload: JsonObject;
    try {
      const value: unknown = await response.json();
      const object = optionalObject(value);
      if (!object) throw new Error('invalid payload');
      providerPayload = object;
    } catch {
      throw externalServiceUnavailable(
        'Não foi possível validar a mídia recebida neste momento.',
      );
    }

    const persistedMedia = optionalObject(message.media);
    const mimeType = normalizeMimeType(
      providerPayload.mimetype ?? persistedMedia?.mimeType,
    );
    if (
      !mimeType ||
      !this.allowedMimeTypes.has(mimeType) ||
      !isMimeCompatible(message.kind, mimeType)
    ) {
      throw validationError('O formato desta mídia não é permitido.');
    }

    const content = decodeBase64(providerPayload.base64, this.maximumBytes);
    return {
      content,
      fileName: normalizedFileName(
        providerPayload.fileName ?? persistedMedia?.fileName,
        message.kind,
        mimeType,
        message.id,
      ),
      mimeType,
      kind: canonicalKind(message.kind),
    };
  }

  private async persistContent(
    message: MediaMessageRow,
    media: WhatsAppMediaContent,
  ): Promise<void> {
    const sha256 = createHash('sha256').update(media.content).digest('hex');
    const storageKey = [
      'v1',
      message.companyId,
      message.conversationId,
      message.id,
      sha256,
    ].join('/');
    await this.storage.write({ storageKey, content: media.content });

    const updated = await this.prisma.whatsAppMessage.updateMany({
      where: {
        id: message.id,
        companyId: message.companyId,
        conversationId: message.conversationId,
        direction: message.direction,
      },
      data: {
        media: {
          ...(optionalObject(message.media) ?? {}),
          mimeType: media.mimeType,
          size: media.content.byteLength,
          fileName: media.fileName,
          retentionStatus: 'stored',
        },
        mediaStorageKey: storageKey,
        mediaMimeType: media.mimeType,
        mediaSizeBytes: media.content.byteLength,
        mediaOriginalName: media.fileName,
        mediaSha256: sha256,
        mediaStoredAt: new Date(),
      },
    });
    if (updated.count !== 1) throw notFound('Mensagem de mídia');
  }

  private async markRetentionStatus(
    message: MediaMessageRow,
    retentionStatus: 'stored' | 'unavailable' | 'too-large',
  ): Promise<void> {
    await this.prisma.whatsAppMessage.updateMany({
      where: {
        id: message.id,
        companyId: message.companyId,
        conversationId: message.conversationId,
        direction: message.direction,
      },
      data: {
        media: {
          ...(optionalObject(message.media) ?? {}),
          retentionStatus,
        },
      },
    });
  }

  private proposalContent(message: MediaMessageRow): WhatsAppMediaContent {
    const document = message.proposalDocument;
    if (!document) throw unavailableMedia();
    const content = Buffer.from(document.content);
    if (
      content.byteLength < 1 ||
      content.byteLength > this.maximumBytes ||
      content.byteLength !== document.sizeBytes
    ) {
      throw validationError('O documento salvo possui tamanho inválido.');
    }
    return {
      content,
      fileName: normalizedFileName(
        document.fileName,
        message.kind,
        document.mimeType,
        message.id,
      ),
      mimeType: document.mimeType,
      kind: canonicalKind(message.kind),
    };
  }

  private async findMessage(
    companyId: string,
    conversationId: string,
    messageId: string,
  ): Promise<MediaMessageRow> {
    const message = await this.prisma.whatsAppMessage.findUnique({
      where: {
        id_companyId_conversationId: {
          id: messageId,
          companyId,
          conversationId,
        },
      },
      include: {
        proposalDocument: {
          select: {
            content: true,
            fileName: true,
            mimeType: true,
            sizeBytes: true,
          },
        },
      },
    });
    if (!message || !MEDIA_KINDS.has(message.kind)) {
      throw notFound('Conteúdo da mídia');
    }
    return message;
  }
}

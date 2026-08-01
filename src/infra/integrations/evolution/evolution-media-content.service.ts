import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  conversionNotSupported,
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
  readonly kind: 'image' | 'document' | 'audio' | 'video' | 'sticker';
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
    default:
      return false;
  }
}

function decodeBase64(value: unknown, maximumBytes: number): Buffer {
  if (typeof value !== 'string' || !value.trim()) {
    throw conversionNotSupported(
      'A Evolution API não retornou o conteúdo descriptografado da mídia.',
    );
  }

  const dataUrl = /^data:[^;]+;base64,(.*)$/s.exec(value.trim());
  const compact = (dataUrl?.[1] ?? value).replace(/\s+/g, '');
  if (
    !compact ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw conversionNotSupported(
      'A Evolution API retornou uma mídia com codificação inválida.',
    );
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
    throw conversionNotSupported(
      'A Evolution API retornou uma mídia com codificação inválida.',
    );
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
  const withoutControlCharacters = replaceUnsafeFileNameCharacters(raw).slice(
    0,
    180,
  );
  const removedEncryptedSuffix = withoutControlCharacters.replace(
    /\.enc$/i,
    '',
  );
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

@Injectable()
export class EvolutionMediaContentService {
  private readonly baseUrl: string;
  private readonly instanceName: string;
  private readonly apiKey: string;
  private readonly maximumBytes: number;
  private readonly allowedMimeTypes: ReadonlySet<string>;
  private readonly requestTimeoutMs = 30_000;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.baseUrl = (config.get<string>('EVOLUTION_BASE_URL') ?? '').replace(
      /\/+$/,
      '',
    );
    this.instanceName = config.get<string>('EVOLUTION_INSTANCE_NAME') ?? '';
    this.apiKey = config.get<string>('EVOLUTION_API_KEY') ?? '';
    this.maximumBytes =
      config.get<number>('WHATSAPP_MAX_ATTACHMENT_BYTES') ?? 10_485_760;
    this.allowedMimeTypes = new Set(
      (config.get<string>('WHATSAPP_ALLOWED_MIME_TYPES') ?? '')
        .split(',')
        .map((item) => normalizeMimeType(item))
        .filter(Boolean),
    );
  }

  async getContent(
    companyId: string,
    conversationId: string,
    messageId: string,
  ): Promise<WhatsAppMediaContent> {
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

    if (
      message.direction === MessageDirection.OUTBOUND &&
      message.proposalDocument
    ) {
      const content = Buffer.from(message.proposalDocument.content);
      if (
        content.byteLength < 1 ||
        content.byteLength > this.maximumBytes ||
        content.byteLength !== message.proposalDocument.sizeBytes
      ) {
        throw validationError(
          'O documento persistido possui tamanho inválido.',
        );
      }
      return {
        content,
        fileName: normalizedFileName(
          message.proposalDocument.fileName,
          message.kind,
          message.proposalDocument.mimeType,
          message.id,
        ),
        mimeType: message.proposalDocument.mimeType,
        kind: canonicalKind(message.kind),
      };
    }

    if (!message.providerMessageId) {
      throw notFound('Conteúdo da mídia');
    }
    if (!this.baseUrl || !this.instanceName || !this.apiKey) {
      throw conversionNotSupported(
        'A Evolution API não está configurada para recuperar mídias.',
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
      throw conversionNotSupported(
        'Não foi possível recuperar a mídia na Evolution API.',
      );
    }

    if (response.status === 400 || response.status === 404) {
      throw notFound('Conteúdo da mídia');
    }
    if (!response.ok) {
      throw conversionNotSupported(
        'A Evolution API não conseguiu disponibilizar a mídia.',
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
      throw conversionNotSupported(
        'A Evolution API retornou uma resposta de mídia inválida.',
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
      throw validationError(
        'O tipo MIME retornado para a mídia não é permitido.',
      );
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
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WhatsAppRepository } from '../../../application/contracts/whatsapp.repository';
import {
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import type { MessageKind } from '../../../domain/whatsapp/whatsapp.constants';
import { normalizeWhatsAppPhone } from '../../../shared/utils/normalization';
import { EvolutionMediaContentService } from './evolution-media-content.service';

type Headers = Readonly<Record<string, string | string[] | undefined>>;
type JsonObject = Record<string, unknown>;

function asObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(`${field} deve ser um objeto.`);
  }
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function protobufInteger(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);

  const serialized = optionalObject(value);
  if (!serialized) return Number.NaN;

  const low = serialized.low;
  const high = serialized.high;
  if (
    typeof low !== 'number' ||
    !Number.isInteger(low) ||
    typeof high !== 'number' ||
    !Number.isInteger(high) ||
    (serialized.unsigned !== undefined &&
      typeof serialized.unsigned !== 'boolean')
  ) {
    return Number.NaN;
  }
  if (serialized.unsigned !== true && high < 0) return Number.NaN;

  const result = (high >>> 0) * 4_294_967_296 + (low >>> 0);
  return Number.isSafeInteger(result) ? result : Number.NaN;
}

function unwrapMessage(message: JsonObject): JsonObject {
  const wrappers = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
  ] as const;
  let current = message;

  for (let depth = 0; depth < 8; depth += 1) {
    let nested: JsonObject | null = null;
    for (const field of wrappers) {
      const wrapper = optionalObject(current[field]);
      nested = wrapper ? optionalObject(wrapper.message) : null;
      if (nested) break;
    }
    if (!nested) {
      const protocol = optionalObject(current.protocolMessage);
      nested = protocol ? optionalObject(protocol.editedMessage) : null;
    }
    if (!nested) return current;
    current = nested;
  }

  return current;
}

function requiredString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximumLength
  ) {
    throw validationError(`${field} é inválido.`);
  }
  return value.trim();
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function constantTimeEqual(first: string, second: string): boolean {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return (
    firstBuffer.length === secondBuffer.length &&
    timingSafeEqual(firstBuffer, secondBuffer)
  );
}

function messageTimestamp(value: unknown): Date {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw validationError('data.messageTimestamp é inválido.');
  }
  const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.valueOf())) {
    throw validationError('data.messageTimestamp é inválido.');
  }
  return date;
}

@Injectable()
export class EvolutionWebhookService {
  private readonly webhookSecret: string;
  private readonly maximumSkewMs: number;
  private readonly maximumEventAgeMs: number;
  private readonly maximumPayloadBytes: number;
  private readonly maximumAttachmentBytes: number;
  private readonly allowedMimeTypes: ReadonlySet<string>;

  constructor(
    private readonly repository: WhatsAppRepository,
    private readonly mediaContent: EvolutionMediaContentService,
    config: ConfigService,
  ) {
    this.webhookSecret = config.get<string>('EVOLUTION_WEBHOOK_SECRET') ?? '';
    this.maximumSkewMs = config.get<number>('WEBHOOK_MAX_SKEW_MS') ?? 300_000;
    this.maximumEventAgeMs =
      config.get<number>('WEBHOOK_MAX_EVENT_AGE_MS') ?? 604_800_000;
    this.maximumPayloadBytes =
      config.get<number>('WHATSAPP_MAX_WEBHOOK_BYTES') ?? 262_144;
    this.maximumAttachmentBytes =
      config.get<number>('WHATSAPP_MAX_ATTACHMENT_BYTES') ?? 10_485_760;
    this.allowedMimeTypes = new Set(
      (
        config.get<string>('WHATSAPP_ALLOWED_MIME_TYPES') ??
        'image/jpeg,image/png,image/webp,image/gif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv,application/octet-stream,audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/wav,video/mp4,video/webm,video/quicktime'
      )
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  async handle(input: {
    channelId: string;
    headers: Headers;
    rawBody: Buffer;
    body: unknown;
    now?: Date;
  }): Promise<unknown> {
    const channel = await this.repository.findWebhookChannel(input.channelId);
    if (!channel?.enabled) throw notFound('Canal WhatsApp');
    if (!this.webhookSecret) {
      throw forbidden('Credencial do webhook Evolution não configurada.');
    }
    if (input.rawBody.byteLength > this.maximumPayloadBytes) {
      throw validationError('Payload do webhook excede o limite configurado.');
    }

    const body = asObject(input.body, 'payload');
    const event = requiredString(body.event, 'event', 80).toLowerCase();
    const instance = requiredString(body.instance, 'instance', 120);
    const now = input.now ?? new Date();
    const timestampHeader = header(
      input.headers,
      'x-evolution-timestamp',
    )?.trim();
    const authentication = this.authenticate(
      input.headers,
      input.rawBody,
      timestampHeader,
      channel.webhookSecretHash,
      now,
    );
    if (instance !== channel.instanceName) {
      throw forbidden('A instância Evolution não pertence a este canal.');
    }

    if (!['messages.upsert', 'messages-upsert'].includes(event)) {
      return { accepted: true, ignored: true, reason: 'unsupported-event' };
    }

    const data = asObject(body.data, 'data');
    const key = asObject(data.key, 'data.key');
    const providerMessageId = requiredString(key.id, 'data.key.id', 160);
    const remoteJid = requiredString(key.remoteJid, 'data.key.remoteJid', 200);
    const fromMe = key.fromMe;
    if (typeof fromMe !== 'boolean') {
      throw validationError('data.key.fromMe deve ser booleano.');
    }
    if (fromMe && channel.ignoreFromMe) {
      return { accepted: true, ignored: true, reason: 'from-me' };
    }
    if (remoteJid.endsWith('@g.us') && channel.ignoreGroups) {
      return { accepted: true, ignored: true, reason: 'group' };
    }
    if (
      !remoteJid.endsWith('@s.whatsapp.net') &&
      !remoteJid.endsWith('@c.us')
    ) {
      throw validationError('data.key.remoteJid não é um contato WhatsApp.');
    }

    let phoneNormalized: string;
    try {
      phoneNormalized = normalizeWhatsAppPhone(remoteJid);
    } catch {
      throw validationError('Telefone do webhook fora do padrão E.164.');
    }
    const occurredAt = messageTimestamp(data.messageTimestamp);
    if (occurredAt.valueOf() > now.valueOf() + this.maximumSkewMs) {
      throw forbidden('Timestamp da mensagem está no futuro.');
    }
    if (
      authentication === 'static-token' &&
      now.valueOf() - occurredAt.valueOf() > this.maximumEventAgeMs
    ) {
      throw forbidden('Mensagem fora da janela máxima de ingestão.');
    }

    const content = this.extractContent(asObject(data.message, 'data.message'));
    const payloadHash = createHash('sha256')
      .update(input.rawBody)
      .digest('hex');
    const correlationId = `evolution:${createHash('sha256')
      .update(`${channel.id}:${providerMessageId}`)
      .digest('hex')}`;

    const persisted = await this.repository.persistInbound({
      channel,
      externalEventId: providerMessageId,
      providerMessageId,
      correlationId,
      payloadHash,
      phoneNormalized,
      displayName:
        typeof data.pushName === 'string'
          ? data.pushName.trim().slice(0, 160)
          : undefined,
      occurredAt,
      kind: content.kind,
      text: content.text,
      media: content.media,
    });
    if (
      ['image', 'document', 'audio', 'video', 'sticker'].includes(
        content.kind,
      ) &&
      persisted.messageId &&
      persisted.conversationId
    ) {
      const retention = await this.mediaContent.retainInbound(
        channel.companyId,
        persisted.conversationId,
        persisted.messageId,
      );
      return { ...persisted, mediaRetention: retention.status };
    }
    return persisted;
  }

  private authenticate(
    headers: Headers,
    rawBody: Buffer,
    timestamp: string | undefined,
    expectedSecretHash: string,
    now: Date,
  ): 'static-token' | 'hmac' {
    const configuredHash = createHash('sha256')
      .update(this.webhookSecret)
      .digest('hex');
    if (!constantTimeEqual(configuredHash, expectedSecretHash)) {
      throw forbidden('Credencial do canal não corresponde ao ambiente.');
    }

    const providedToken = header(headers, 'x-evolution-webhook-token');
    const tokenValid = providedToken
      ? constantTimeEqual(
          createHash('sha256').update(providedToken).digest('hex'),
          expectedSecretHash,
        )
      : false;
    if (tokenValid) return 'static-token';

    const requiredTimestamp = requiredString(
      timestamp,
      'x-evolution-timestamp',
      40,
    );
    const signedAt = messageTimestamp(requiredTimestamp);
    if (Math.abs(now.valueOf() - signedAt.valueOf()) > this.maximumSkewMs) {
      throw forbidden('Timestamp do webhook fora da janela permitida.');
    }

    const rawSignature = header(headers, 'x-evolution-signature');
    const signature = rawSignature?.replace(/^sha256=/i, '').toLowerCase();
    const expectedSignature = createHmac('sha256', this.webhookSecret)
      .update(requiredTimestamp)
      .update('.')
      .update(rawBody)
      .digest('hex');
    const signatureValid = signature
      ? constantTimeEqual(signature, expectedSignature)
      : false;

    if (!signatureValid) {
      throw forbidden('Assinatura do webhook Evolution inválida.');
    }
    return 'hmac';
  }

  private extractContent(message: JsonObject): {
    kind: MessageKind;
    text?: string;
    media?: Readonly<Record<string, unknown>>;
  } {
    message = unwrapMessage(message);
    if (typeof message.conversation === 'string') {
      return {
        kind: 'text',
        text: this.validateText(message.conversation),
      };
    }

    const extended = optionalObject(message.extendedTextMessage);
    if (extended && typeof extended.text === 'string') {
      return { kind: 'text', text: this.validateText(extended.text) };
    }

    const candidates: Array<[string, MessageKind]> = [
      ['imageMessage', 'image'],
      ['documentMessage', 'document'],
      ['audioMessage', 'audio'],
      ['videoMessage', 'video'],
      ['stickerMessage', 'sticker'],
    ];
    for (const [field, kind] of candidates) {
      const media = optionalObject(message[field]);
      if (media) return this.validateMedia(kind, media);
    }

    if (optionalObject(message.locationMessage)) {
      return { kind: 'location', media: message.locationMessage as JsonObject };
    }
    if (
      optionalObject(message.contactMessage) ||
      optionalObject(message.contactsArrayMessage)
    ) {
      return {
        kind: 'contact',
        media: (message.contactMessage ??
          message.contactsArrayMessage) as JsonObject,
      };
    }
    return { kind: 'unknown' };
  }

  private validateText(value: string): string {
    const text = value.trim();
    if (!text || text.length > 10_000) {
      throw validationError(
        'Texto da mensagem é vazio ou excede 10.000 caracteres.',
      );
    }
    return text;
  }

  private validateMedia(
    kind: MessageKind,
    media: JsonObject,
  ): {
    kind: MessageKind;
    text?: string;
    media: Readonly<Record<string, unknown>>;
  } {
    const mimeType =
      typeof media.mimetype === 'string'
        ? media.mimetype.toLowerCase().split(';')[0]
        : '';
    if (!mimeType || !this.allowedMimeTypes.has(mimeType)) {
      throw validationError('Tipo MIME do anexo não permitido.');
    }
    const size = protobufInteger(media.fileLength ?? media.fileSize);
    if (
      !Number.isFinite(size) ||
      size < 0 ||
      size > this.maximumAttachmentBytes
    ) {
      throw validationError('Tamanho do anexo inválido ou acima do limite.');
    }
    const url =
      typeof media.url === 'string'
        ? media.url
        : typeof media.mediaUrl === 'string'
          ? media.mediaUrl
          : undefined;
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw validationError('URL do anexo é inválida.');
      }
      if (parsed.protocol !== 'https:') {
        throw validationError('URL do anexo deve usar HTTPS.');
      }
    }
    const caption =
      typeof media.caption === 'string'
        ? this.validateText(media.caption)
        : undefined;
    return {
      kind,
      text: caption,
      media: {
        mimeType,
        size,
        ...(typeof media.fileName === 'string'
          ? { fileName: media.fileName.slice(0, 255) }
          : {}),
      },
    };
  }
}

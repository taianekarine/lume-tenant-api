import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { validationError } from '../../core/errors/app-error';
import { normalizeWhatsAppPhone } from '../../shared/utils/normalization';
import type {
  ParsedWhatsAppExport,
  WhatsAppExportAttachment,
  WhatsAppExportMessage,
  WhatsAppExportMessageKind,
} from './whatsapp-export-parser';
import type { WhatsAppHistoryConversationMapping } from './whatsapp-export-workbook';

export const WHATSAPP_ANDROID_BACKUP_SOURCE_SYSTEM = 'whatsapp-android-backup';
export const ANDROID_BACKUP_COMPANY_SENDER = 'Empresa (este aparelho)';

const DIRECT_CHAT_PHONE_SQL =
  "CASE WHEN chat_jid.server = 'lid' THEN phone_jid.user ELSE chat_jid.user END";

const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  chat: ['_id', 'jid_row_id'],
  jid: ['_id', 'user', 'server'],
  jid_map: ['lid_row_id', 'jid_row_id'],
  message: [
    '_id',
    'chat_row_id',
    'from_me',
    'key_id',
    'status',
    'timestamp',
    'message_type',
    'text_data',
  ],
  message_media: [
    'message_row_id',
    'file_path',
    'file_size',
    'mime_type',
    'media_name',
    'media_caption',
  ],
};

export interface WhatsAppAndroidBackupSummary {
  schemaVersion: '1.0';
  directConversations: number;
  directMessages: number;
  mediaReferences: number;
  groupConversationsExcluded: number;
  groupMessagesExcluded: number;
  otherConversationsExcluded: number;
  otherMessagesExcluded: number;
  unmappedDirectConversations: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ReadWhatsAppAndroidBackupOptions {
  cutoffAt?: Date;
  departmentCode: string;
  state: WhatsAppHistoryConversationMapping['state'];
  ownerUsername?: string | null;
}

interface AggregateRow {
  directConversations: number;
  directMessages: number;
  mediaReferences: number;
  groupConversationsExcluded: number;
  groupMessagesExcluded: number;
  otherConversationsExcluded: number;
  otherMessagesExcluded: number;
  unmappedDirectConversations: number;
  startedAt: number | null;
  endedAt: number | null;
}

interface AndroidMessageRow {
  phone: string;
  messageId: number;
  chatId: number;
  fromMe: number;
  keyId: string | null;
  status: number | null;
  timestamp: number;
  messageType: number | null;
  textData: string | null;
  filePath: string | null;
  fileSize: number | null;
  mimeType: string | null;
  mediaName: string | null;
  mediaCaption: string | null;
  fileHash: string | null;
  uiElementContent: string | null;
}

function database(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

function numeric(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = numeric(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  throw validationError('O banco do WhatsApp contém um texto inválido.');
}

function assertSchema(db: DatabaseSync): void {
  const quickCheck = db.prepare('PRAGMA quick_check').get() as
    Record<string, unknown> | undefined;
  if (!quickCheck || !Object.values(quickCheck).includes('ok')) {
    throw validationError(
      'O banco de mensagens do WhatsApp está corrompido ou incompleto.',
    );
  }
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(
      (
        db.prepare(`PRAGMA table_info('${table}')`).all() as Record<
          string,
          unknown
        >[]
      ).map((column) => String(column.name)),
    );
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw validationError(
        `A versão do backup não é compatível: ${table}.${missing[0]} não foi encontrado.`,
      );
    }
  }
}

function tableHasColumns(
  db: DatabaseSync,
  table: string,
  required: readonly string[],
): boolean {
  const columns = new Set(
    (
      db.prepare(`PRAGMA table_info('${table}')`).all() as Record<
        string,
        unknown
      >[]
    ).map((column) => String(column.name)),
  );
  return required.every((column) => columns.has(column));
}

function isoFromTimestamp(value: number | null): string | null {
  if (!value || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function inspectWhatsAppAndroidBackup(
  databasePath: string,
): WhatsAppAndroidBackupSummary {
  const db = database(databasePath);
  try {
    assertSchema(db);
    const row = db
      .prepare(
        `WITH direct_chats AS (
           SELECT chat._id AS chat_id, ${DIRECT_CHAT_PHONE_SQL} AS phone
           FROM chat
           JOIN jid chat_jid ON chat_jid._id = chat.jid_row_id
           LEFT JOIN jid_map ON jid_map.lid_row_id = chat_jid._id
           LEFT JOIN jid phone_jid ON phone_jid._id = jid_map.jid_row_id
           WHERE chat_jid.server IN ('s.whatsapp.net', 'lid')
         ), direct_phones AS (
           SELECT DISTINCT phone
           FROM direct_chats
           WHERE phone GLOB '[0-9]*' AND length(phone) BETWEEN 10 AND 15
         )
         SELECT
           (SELECT count(*) FROM direct_phones) AS directConversations,
           (SELECT count(*) FROM message m JOIN direct_chats d ON d.chat_id = m.chat_row_id
             WHERE d.phone GLOB '[0-9]*' AND length(d.phone) BETWEEN 10 AND 15) AS directMessages,
           (SELECT count(*) FROM message_media mm JOIN direct_chats d ON d.chat_id = mm.chat_row_id
             WHERE d.phone GLOB '[0-9]*' AND length(d.phone) BETWEEN 10 AND 15) AS mediaReferences,
           (SELECT count(*) FROM chat c JOIN jid j ON j._id = c.jid_row_id WHERE j.server = 'g.us') AS groupConversationsExcluded,
           (SELECT count(*) FROM message m JOIN chat c ON c._id = m.chat_row_id JOIN jid j ON j._id = c.jid_row_id WHERE j.server = 'g.us') AS groupMessagesExcluded,
           (SELECT count(*) FROM chat c JOIN jid j ON j._id = c.jid_row_id WHERE j.server NOT IN ('s.whatsapp.net', 'lid', 'g.us')) AS otherConversationsExcluded,
           (SELECT count(*) FROM message m JOIN chat c ON c._id = m.chat_row_id JOIN jid j ON j._id = c.jid_row_id WHERE j.server NOT IN ('s.whatsapp.net', 'lid', 'g.us')) AS otherMessagesExcluded,
           (SELECT count(*) FROM direct_chats WHERE phone IS NULL OR phone NOT GLOB '[0-9]*' OR length(phone) NOT BETWEEN 10 AND 15) AS unmappedDirectConversations,
           (SELECT min(m.timestamp) FROM message m JOIN direct_chats d ON d.chat_id = m.chat_row_id WHERE d.phone GLOB '[0-9]*' AND length(d.phone) BETWEEN 10 AND 15 AND m.timestamp > 0) AS startedAt,
           (SELECT max(m.timestamp) FROM message m JOIN direct_chats d ON d.chat_id = m.chat_row_id WHERE d.phone GLOB '[0-9]*' AND length(d.phone) BETWEEN 10 AND 15 AND m.timestamp > 0) AS endedAt`,
      )
      .get() as Record<string, unknown>;
    const aggregate: AggregateRow = {
      directConversations: numeric(row.directConversations),
      directMessages: numeric(row.directMessages),
      mediaReferences: numeric(row.mediaReferences),
      groupConversationsExcluded: numeric(row.groupConversationsExcluded),
      groupMessagesExcluded: numeric(row.groupMessagesExcluded),
      otherConversationsExcluded: numeric(row.otherConversationsExcluded),
      otherMessagesExcluded: numeric(row.otherMessagesExcluded),
      unmappedDirectConversations: numeric(row.unmappedDirectConversations),
      startedAt: nullableNumber(row.startedAt),
      endedAt: nullableNumber(row.endedAt),
    };
    return {
      schemaVersion: '1.0',
      directConversations: aggregate.directConversations,
      directMessages: aggregate.directMessages,
      mediaReferences: aggregate.mediaReferences,
      groupConversationsExcluded: aggregate.groupConversationsExcluded,
      groupMessagesExcluded: aggregate.groupMessagesExcluded,
      otherConversationsExcluded: aggregate.otherConversationsExcluded,
      otherMessagesExcluded: aggregate.otherMessagesExcluded,
      unmappedDirectConversations: aggregate.unmappedDirectConversations,
      startedAt: isoFromTimestamp(aggregate.startedAt),
      endedAt: isoFromTimestamp(aggregate.endedAt),
    };
  } finally {
    db.close();
  }
}

function safeFileName(value: string): string {
  const candidate = basename(value.replace(/\\/g, '/')).trim();
  const printable = [...candidate]
    .map((character) => (character.charCodeAt(0) < 32 ? '_' : character))
    .join('');
  return (
    printable.replace(/[<>:"/\\|?*]/g, '_').slice(0, 255) || 'midia-whatsapp'
  );
}

function contentSha256(value: string | null): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (/^[0-9a-f]{64}$/i.test(normalized)) return normalized.toLowerCase();
  try {
    const decoded = Buffer.from(normalized, 'base64');
    return decoded.byteLength === 32 ? decoded.toString('hex') : null;
  } catch {
    return null;
  }
}

function messageKind(
  messageType: number | null,
  mimeType: string | null,
): WhatsAppExportMessageKind {
  const mime = mimeType?.toLowerCase() ?? '';
  if (messageType === 20) return 'sticker';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime) return 'document';
  if (messageType === 0) return 'text';
  if (messageType === 4) return 'contact';
  if (messageType === 5) return 'location';
  return 'unknown';
}

function uiElementText(value: string | null): string | null {
  const normalized = value?.trim();
  if (!normalized) return null;

  try {
    const parsed: unknown = JSON.parse(normalized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const element = parsed as Record<string, unknown>;
    const parts: string[] = [];
    for (const field of ['content', 'footer'] as const) {
      const text = element[field];
      if (typeof text === 'string' && text.trim()) parts.push(text.trim());
    }

    if (Array.isArray(element.buttons)) {
      const buttons = element.buttons
        .map((button) => {
          if (!button || typeof button !== 'object' || Array.isArray(button)) {
            return null;
          }
          const displayText = (button as Record<string, unknown>).displayText;
          return typeof displayText === 'string' && displayText.trim()
            ? displayText.trim()
            : null;
        })
        .filter((button): button is string => Boolean(button));
      if (buttons.length > 0) parts.push(`Opções: ${buttons.join(' · ')}`);
    }

    return [...new Set(parts)].join('\n') || null;
  } catch {
    return null;
  }
}

function attachment(row: AndroidMessageRow): WhatsAppExportAttachment | null {
  const kind = messageKind(row.messageType, row.mimeType);
  if (
    !row.filePath &&
    !row.mediaName &&
    !row.mimeType &&
    !['image', 'audio', 'video', 'document', 'sticker'].includes(kind)
  ) {
    return null;
  }
  const sourceName = row.filePath ?? row.mediaName ?? `midia-${row.messageId}`;
  const normalizedContentSha256 = contentSha256(row.fileHash);
  const hashFragment = normalizedContentSha256
    ? `#sha256=${normalizedContentSha256}`
    : '';
  return {
    entryName: null,
    fileName: safeFileName(sourceName),
    kind: kind === 'text' ? 'unknown' : kind,
    mimeType: row.mimeType?.trim() || 'application/octet-stream',
    sizeBytes: row.fileSize !== null && row.fileSize >= 0 ? row.fileSize : null,
    reference: `whatsapp-android-media://${encodeURIComponent(
      row.filePath ?? sourceName,
    )}${hashFragment}`,
  };
}

function wallClockInSaoPaulo(timestamp: number): Date {
  const date = new Date(timestamp);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number.parseInt(part.value, 10)]),
  ) as Record<string, number>;
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
}

function externalConversationId(phone: string): string {
  return `android-chat-${createHash('sha256')
    .update(phone)
    .digest('hex')
    .slice(0, 40)}`;
}

function toMessage(
  row: AndroidMessageRow,
  index: number,
): WhatsAppExportMessage {
  const media = attachment(row);
  const kind = media?.kind ?? messageKind(row.messageType, row.mimeType);
  const text =
    row.textData?.trim() ||
    row.mediaCaption?.trim() ||
    uiElementText(row.uiElementContent);
  const fallback =
    text || media
      ? null
      : row.messageType === 7
        ? '[Evento do sistema do WhatsApp]'
        : kind === 'text'
          ? '[Mensagem de texto sem conteúdo disponível no backup]'
          : kind === 'unknown'
            ? `[Mensagem do WhatsApp sem conteúdo textual — tipo ${row.messageType ?? 'desconhecido'}]`
            : null;
  const wallClockAt = wallClockInSaoPaulo(row.timestamp);
  return {
    index,
    externalMessageId: `android-message-${createHash('sha256')
      .update(String(row.chatId))
      .update('\0')
      .update(row.keyId ?? String(row.messageId))
      .digest('hex')
      .slice(0, 40)}`,
    outbound: row.fromMe === 1,
    senderName: row.fromMe === 1 ? ANDROID_BACKUP_COMPANY_SENDER : row.phone,
    occurredAt: new Date(row.timestamp),
    wallClockAt,
    text: text ?? fallback,
    kind,
    attachment: media,
    system: row.messageType === 7,
  };
}

function exportFor(
  phone: string,
  rows: AndroidMessageRow[],
): ParsedWhatsAppExport {
  const normalizedPhone = normalizeWhatsAppPhone(phone);
  const messages = rows.map(toMessage);
  const archiveId = createHash('sha256')
    .update(normalizedPhone)
    .digest('hex')
    .slice(0, 32);
  return {
    archiveId,
    sourceSystem: WHATSAPP_ANDROID_BACKUP_SOURCE_SYSTEM,
    externalConversationId: externalConversationId(normalizedPhone),
    archiveName: `Backup Android · ${normalizedPhone}`,
    archiveSha256: archiveId.padEnd(64, '0'),
    chatFileName: 'msgstore.db',
    suggestedContactName: normalizedPhone,
    suggestedPhoneE164: normalizedPhone,
    senders: [
      {
        name: ANDROID_BACKUP_COMPANY_SENDER,
        messageCount: messages.filter((message) => message.outbound).length,
      },
      {
        name: normalizedPhone,
        messageCount: messages.filter((message) => !message.outbound).length,
      },
    ],
    messages,
    messageCount: messages.length,
    attachmentCount: messages.filter((message) => message.attachment).length,
    missingAttachmentCount: messages.filter((message) => message.attachment)
      .length,
    startedAt: messages[0]?.occurredAt ?? null,
    endedAt: messages.at(-1)?.occurredAt ?? null,
  };
}

function mappingFor(
  parsed: ParsedWhatsAppExport,
  options: ReadWhatsAppAndroidBackupOptions,
): WhatsAppHistoryConversationMapping {
  return {
    archiveId: parsed.archiveId,
    phoneE164: parsed.suggestedPhoneE164!,
    contactName: parsed.suggestedContactName!,
    companySenderName: ANDROID_BACKUP_COMPANY_SENDER,
    state: options.state,
    departmentCode: options.departmentCode,
    ownerUsername: options.ownerUsername ?? null,
  };
}

export function* readWhatsAppAndroidBackup(
  databasePath: string,
  options: ReadWhatsAppAndroidBackupOptions,
): Generator<{
  parsed: ParsedWhatsAppExport;
  mapping: WhatsAppHistoryConversationMapping;
}> {
  const db = database(databasePath);
  try {
    assertSchema(db);
    const hasUiElements = tableHasColumns(db, 'message_ui_elements', [
      'message_row_id',
      'element_content',
    ]);
    const uiElementContentProjection = hasUiElements
      ? `(SELECT ui.element_content
          FROM message_ui_elements ui
          WHERE ui.message_row_id = message._id
          LIMIT 1)`
      : 'NULL';
    const fileHashProjection = tableHasColumns(db, 'message_media', [
      'file_hash',
    ])
      ? `CASE
           WHEN typeof(message_media.file_hash) = 'blob'
             THEN lower(hex(message_media.file_hash))
           ELSE CAST(message_media.file_hash AS TEXT)
         END`
      : 'NULL';
    const cutoffTimestamp =
      options.cutoffAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const statement = db.prepare(
      `SELECT
         ${DIRECT_CHAT_PHONE_SQL} AS phone,
         message._id AS messageId,
         message.chat_row_id AS chatId,
         message.from_me AS fromMe,
         message.key_id AS keyId,
         message.status AS status,
         message.timestamp AS timestamp,
         message.message_type AS messageType,
         message.text_data AS textData,
         message_media.file_path AS filePath,
         message_media.file_size AS fileSize,
         message_media.mime_type AS mimeType,
         message_media.media_name AS mediaName,
         message_media.media_caption AS mediaCaption,
         ${fileHashProjection} AS fileHash,
         ${uiElementContentProjection} AS uiElementContent
       FROM message
       JOIN chat ON chat._id = message.chat_row_id
       JOIN jid chat_jid ON chat_jid._id = chat.jid_row_id
       LEFT JOIN jid_map ON jid_map.lid_row_id = chat_jid._id
       LEFT JOIN jid phone_jid ON phone_jid._id = jid_map.jid_row_id
       LEFT JOIN message_media ON message_media.message_row_id = message._id
       WHERE chat_jid.server IN ('s.whatsapp.net', 'lid')
         AND ${DIRECT_CHAT_PHONE_SQL} GLOB '[0-9]*'
         AND length(${DIRECT_CHAT_PHONE_SQL}) BETWEEN 10 AND 15
         AND message.timestamp > 0
         AND message.timestamp <= ?
       ORDER BY phone, message.timestamp, message._id`,
    );
    let currentPhone: string | null = null;
    let rows: AndroidMessageRow[] = [];
    for (const raw of statement.iterate(cutoffTimestamp) as Iterable<
      Record<string, unknown>
    >) {
      const row: AndroidMessageRow = {
        phone: nullableText(raw.phone) ?? '',
        messageId: numeric(raw.messageId),
        chatId: numeric(raw.chatId),
        fromMe: numeric(raw.fromMe),
        keyId: nullableText(raw.keyId),
        status: nullableNumber(raw.status),
        timestamp: numeric(raw.timestamp),
        messageType: nullableNumber(raw.messageType),
        textData: nullableText(raw.textData),
        filePath: nullableText(raw.filePath),
        fileSize: nullableNumber(raw.fileSize),
        mimeType: nullableText(raw.mimeType),
        mediaName: nullableText(raw.mediaName),
        mediaCaption: nullableText(raw.mediaCaption),
        fileHash: nullableText(raw.fileHash),
        uiElementContent: nullableText(raw.uiElementContent),
      };
      if (currentPhone !== null && row.phone !== currentPhone) {
        const parsed = exportFor(currentPhone, rows);
        yield { parsed, mapping: mappingFor(parsed, options) };
        rows = [];
      }
      currentPhone = row.phone;
      rows.push(row);
    }
    if (currentPhone !== null && rows.length > 0) {
      const parsed = exportFor(currentPhone, rows);
      yield { parsed, mapping: mappingFor(parsed, options) };
    }
  } finally {
    db.close();
  }
}

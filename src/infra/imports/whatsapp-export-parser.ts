import { createHash } from 'node:crypto';

import JSZip from 'jszip';

import { validationError } from '../../core/errors/app-error';

const INVISIBLE_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const DRIVE_PREFIX = /^[a-z]:/i;
const PHONE_PATTERN = /\+?\d[\d\s().-]{8,20}\d/;
const HIDDEN_MEDIA =
  /<\s*(?:m[ií]dia oculta|media omitted|arquivo omitido)\s*>/i;
const ATTACHED_MEDIA_AFTER = /(?:arquivo anexado|attached):?\s*([^\r\n]+)/i;
const ATTACHED_MEDIA_SUFFIX = /^(.+?)\s+\((?:arquivo anexado|attached)\)\s*$/im;
const DELETED_MESSAGE = /^(?:mensagem apagada|this message was deleted)$/i;

export const WHATSAPP_EXPORT_SOURCE_SYSTEM = 'whatsapp-chat-export';

export type WhatsAppExportMessageKind =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'sticker'
  | 'contact'
  | 'unknown';

export interface WhatsAppExportAttachment {
  entryName: string | null;
  fileName: string;
  kind: Exclude<WhatsAppExportMessageKind, 'text'>;
  mimeType: string;
  sizeBytes: number | null;
}

export interface WhatsAppExportMessage {
  index: number;
  senderName: string | null;
  occurredAt: Date;
  wallClockAt: Date;
  text: string | null;
  kind: WhatsAppExportMessageKind;
  attachment: WhatsAppExportAttachment | null;
  system: boolean;
}

export interface ParsedWhatsAppExport {
  archiveId: string;
  archiveName: string;
  archiveSha256: string;
  chatFileName: string;
  suggestedContactName: string | null;
  suggestedPhoneE164: string | null;
  senders: readonly { name: string; messageCount: number }[];
  messages: readonly WhatsAppExportMessage[];
  messageCount: number;
  attachmentCount: number;
  missingAttachmentCount: number;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface WhatsAppExportParserLimits {
  maximumArchiveBytes: number;
  maximumEntries: number;
  maximumUncompressedBytes: number;
  maximumTextBytes: number;
}

export const DEFAULT_WHATSAPP_EXPORT_LIMITS: WhatsAppExportParserLimits = {
  maximumArchiveBytes: 512 * 1024 * 1024,
  maximumEntries: 5_000,
  maximumUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maximumTextBytes: 128 * 1024 * 1024,
};

interface ZipEntryData {
  uncompressedSize?: number;
}

interface ParsedHeader {
  wallClockAt: Date;
  remainder: string;
}

function normalizedLine(value: string): string {
  return value.replace(INVISIBLE_MARKS, '').replace(/\u00a0/g, ' ');
}

function normalizedArchivePath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    !normalized ||
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    DRIVE_PREFIX.test(normalized) ||
    segments.some((segment) => segment === '..' || segment === '')
  ) {
    throw validationError(
      'O backup possui um caminho de arquivo inseguro e não pode ser processado.',
    );
  }
  return normalized;
}

function safeFileName(value: string): string {
  const candidate = value.replace(/\\/g, '/').split('/').at(-1)?.trim() ?? '';
  const cleaned = Array.from(candidate)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127 && !'<>:"/\\|?*'.includes(character);
    })
    .join('')
    .slice(0, 255);
  return cleaned || 'arquivo-sem-nome';
}

function mimeAndKind(fileName: string): {
  mimeType: string;
  kind: WhatsAppExportAttachment['kind'];
} {
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  const values: Record<
    string,
    { mimeType: string; kind: WhatsAppExportAttachment['kind'] }
  > = {
    jpg: { mimeType: 'image/jpeg', kind: 'image' },
    jpeg: { mimeType: 'image/jpeg', kind: 'image' },
    png: { mimeType: 'image/png', kind: 'image' },
    gif: { mimeType: 'image/gif', kind: 'image' },
    webp: { mimeType: 'image/webp', kind: 'sticker' },
    opus: { mimeType: 'audio/ogg', kind: 'audio' },
    ogg: { mimeType: 'audio/ogg', kind: 'audio' },
    mp3: { mimeType: 'audio/mpeg', kind: 'audio' },
    m4a: { mimeType: 'audio/mp4', kind: 'audio' },
    wav: { mimeType: 'audio/wav', kind: 'audio' },
    mp4: { mimeType: 'video/mp4', kind: 'video' },
    mov: { mimeType: 'video/quicktime', kind: 'video' },
    pdf: { mimeType: 'application/pdf', kind: 'document' },
    vcf: { mimeType: 'text/vcard', kind: 'contact' },
    doc: { mimeType: 'application/msword', kind: 'document' },
    docx: {
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      kind: 'document',
    },
    xls: { mimeType: 'application/vnd.ms-excel', kind: 'document' },
    xlsx: {
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      kind: 'document',
    },
    csv: { mimeType: 'text/csv', kind: 'document' },
    txt: { mimeType: 'text/plain', kind: 'document' },
  };
  return (
    values[extension] ?? {
      mimeType: 'application/octet-stream',
      kind: 'document',
    }
  );
}

function parseYear(value: string): number {
  const year = Number.parseInt(value, 10);
  return value.length === 2 ? 2_000 + year : year;
}

function parseTime(
  hourText: string,
  minuteText: string,
  secondText?: string,
  meridiem?: string,
): { hour: number; minute: number; second: number } | null {
  let hour = Number.parseInt(hourText, 10);
  const minute = Number.parseInt(minuteText, 10);
  const second = Number.parseInt(secondText ?? '0', 10);
  if (meridiem) {
    const normalized = meridiem.toLowerCase();
    if (hour < 1 || hour > 12) return null;
    if (normalized === 'pm' && hour !== 12) hour += 12;
    if (normalized === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

function validWallClock(
  day: number,
  month: number,
  year: number,
  hour: number,
  minute: number,
  second: number,
): Date | null {
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

function parseHeader(line: string): ParsedHeader | null {
  const normalized = normalizedLine(line);
  const android =
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap]m))?\s+-\s+(.*)$/i.exec(
      normalized,
    );
  const ios =
    /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap]m))?\]\s+(.*)$/i.exec(
      normalized,
    );
  const match = android ?? ios;
  if (!match) return null;
  const time = parseTime(match[4], match[5], match[6], match[7]);
  if (!time) return null;
  const wallClockAt = validWallClock(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    parseYear(match[3]),
    time.hour,
    time.minute,
    time.second,
  );
  return wallClockAt ? { wallClockAt, remainder: match[8] } : null;
}

function wallClockToUtc(value: Date): Date {
  const desiredUtc = value.getTime();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  let candidate = desiredUtc;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(new Date(candidate))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number.parseInt(part.value, 10)]),
    ) as Record<string, number>;
    const displayed = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    candidate += desiredUtc - displayed;
  }
  return new Date(candidate);
}

function splitSender(remainder: string): {
  senderName: string | null;
  text: string;
} {
  const separator = remainder.indexOf(': ');
  if (separator < 1 || separator > 160) {
    return { senderName: null, text: remainder };
  }
  const senderName = remainder.slice(0, separator).trim();
  return {
    senderName: senderName || null,
    text: remainder.slice(separator + 2),
  };
}

function suggestedContactName(archiveName: string): string | null {
  const fileName = archiveName.replace(/\.zip$/i, '');
  const match =
    /(?:conversa (?:do )?whatsapp com|whatsapp chat with)\s+(.+)/i.exec(
      fileName,
    );
  return (match?.[1] ?? fileName).trim().slice(0, 160) || null;
}

export function normalizeBrazilianPhone(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function phoneFromSenders(senders: readonly string[]): string | null {
  const candidates = senders
    .map((sender) => PHONE_PATTERN.exec(sender)?.[0] ?? '')
    .map(normalizeBrazilianPhone)
    .filter((phone): phone is string => Boolean(phone));
  return new Set(candidates).size === 1 ? candidates[0] : null;
}

function archiveEntrySize(entry: JSZip.JSZipObject): number | null {
  const size = (entry as unknown as { _data?: ZipEntryData })._data
    ?.uncompressedSize;
  return Number.isSafeInteger(size) && (size ?? -1) >= 0
    ? (size ?? null)
    : null;
}

function assertNotSymlink(entry: JSZip.JSZipObject): void {
  const permissions = entry.unixPermissions;
  if (
    typeof permissions === 'number' &&
    (permissions & 0o170000) === 0o120000
  ) {
    throw validationError('O backup contém um link simbólico não permitido.');
  }
}

function attachmentFor(
  text: string,
  entriesByBaseName: ReadonlyMap<string, JSZip.JSZipObject>,
): WhatsAppExportAttachment | null {
  const attached =
    ATTACHED_MEDIA_SUFFIX.exec(text)?.[1]?.trim() ??
    ATTACHED_MEDIA_AFTER.exec(text)?.[1]?.trim();
  const textLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const existingName = textLines.find((line) =>
    entriesByBaseName.has(line.toLocaleLowerCase('pt-BR')),
  );
  const candidate = existingName ?? attached;
  if (!candidate && !HIDDEN_MEDIA.test(text)) return null;
  const fileName = safeFileName(candidate ?? 'mídia não identificada');
  const entry = entriesByBaseName.get(fileName.toLocaleLowerCase('pt-BR'));
  const classified = mimeAndKind(fileName);
  return {
    entryName: entry?.name ?? null,
    fileName,
    kind: classified.kind,
    mimeType: classified.mimeType,
    sizeBytes: entry ? archiveEntrySize(entry) : null,
  };
}

export async function parseWhatsAppExportArchive(
  archiveName: string,
  content: Buffer,
  limits: WhatsAppExportParserLimits = DEFAULT_WHATSAPP_EXPORT_LIMITS,
): Promise<ParsedWhatsAppExport> {
  if (
    !archiveName.toLowerCase().endsWith('.zip') ||
    content.byteLength < 4 ||
    content.byteLength > limits.maximumArchiveBytes ||
    content.subarray(0, 2).toString('hex') !== '504b'
  ) {
    throw validationError('Selecione um backup ZIP válido do WhatsApp.');
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(content, { checkCRC32: true });
  } catch {
    throw validationError('O backup ZIP está corrompido ou incompleto.');
  }
  const entries = Object.values(zip.files);
  if (entries.length < 1 || entries.length > limits.maximumEntries) {
    throw validationError(
      `O backup deve possuir entre 1 e ${limits.maximumEntries} entradas.`,
    );
  }
  let declaredBytes = 0;
  const files: JSZip.JSZipObject[] = [];
  for (const entry of entries) {
    const unsafeOriginalName = (
      entry as JSZip.JSZipObject & { unsafeOriginalName?: string }
    ).unsafeOriginalName;
    if (unsafeOriginalName)
      normalizedArchivePath(unsafeOriginalName.replace(/\/$/, ''));
    normalizedArchivePath(entry.name.replace(/\/$/, ''));
    assertNotSymlink(entry);
    if (entry.dir) continue;
    files.push(entry);
    const size = archiveEntrySize(entry);
    if (size !== null) declaredBytes += size;
    if (declaredBytes > limits.maximumUncompressedBytes) {
      throw validationError(
        'O conteúdo descompactado do backup excede o limite de segurança.',
      );
    }
  }
  const textEntries = files.filter((entry) =>
    entry.name.toLowerCase().endsWith('.txt'),
  );
  if (textEntries.length !== 1) {
    throw validationError(
      'O backup deve conter exatamente um arquivo de conversa em formato TXT.',
    );
  }
  const textEntry = textEntries[0];
  const textSize = archiveEntrySize(textEntry);
  if (textSize !== null && textSize > limits.maximumTextBytes) {
    throw validationError('O histórico de texto excede o limite de segurança.');
  }
  const textBuffer = await textEntry.async('nodebuffer');
  if (
    textBuffer.byteLength > limits.maximumTextBytes ||
    textBuffer.includes(0)
  ) {
    throw validationError('O histórico TXT possui conteúdo inválido.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(textBuffer);
  } catch {
    throw validationError('O histórico TXT deve usar codificação UTF-8.');
  }

  const entriesByBaseName = new Map<string, JSZip.JSZipObject>();
  for (const entry of files) {
    if (entry === textEntry) continue;
    const baseName = entry.name.replace(/\\/g, '/').split('/').at(-1)?.trim();
    if (baseName)
      entriesByBaseName.set(baseName.toLocaleLowerCase('pt-BR'), entry);
  }

  const rawMessages: Array<{
    wallClockAt: Date;
    senderName: string | null;
    textLines: string[];
  }> = [];
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const header = parseHeader(rawLine);
    if (header) {
      const split = splitSender(header.remainder);
      rawMessages.push({
        wallClockAt: header.wallClockAt,
        senderName: split.senderName,
        textLines: [split.text],
      });
    } else if (rawMessages.length > 0) {
      rawMessages.at(-1)?.textLines.push(rawLine);
    }
  }
  if (rawMessages.length === 0) {
    throw validationError(
      'Nenhuma mensagem reconhecível foi encontrada no histórico.',
    );
  }

  const messages: WhatsAppExportMessage[] = rawMessages
    .map<WhatsAppExportMessage>((message, index) => {
      const rawText = message.textLines.join('\n').trim();
      const attachment = attachmentFor(rawText, entriesByBaseName);
      const cleanedText = rawText
        .replace(HIDDEN_MEDIA, '')
        .replace(ATTACHED_MEDIA_SUFFIX, '')
        .split(/\r?\n/)
        .filter(
          (line) =>
            line.trim() &&
            line.trim().toLocaleLowerCase('pt-BR') !==
              attachment?.fileName.toLocaleLowerCase('pt-BR'),
        )
        .join('\n')
        .trim();
      const deleted = DELETED_MESSAGE.test(cleanedText);
      return {
        index,
        senderName: message.senderName,
        occurredAt: wallClockToUtc(message.wallClockAt),
        wallClockAt: message.wallClockAt,
        text: cleanedText || (deleted ? rawText : null),
        kind: deleted ? 'unknown' : (attachment?.kind ?? 'text'),
        attachment,
        system: message.senderName === null,
      };
    })
    .sort(
      (left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime() ||
        left.index - right.index,
    );
  const senderCounts = new Map<string, number>();
  for (const message of messages) {
    if (message.senderName) {
      senderCounts.set(
        message.senderName,
        (senderCounts.get(message.senderName) ?? 0) + 1,
      );
    }
  }
  const senders = [...senderCounts.entries()]
    .map(([name, messageCount]) => ({ name, messageCount }))
    .sort((left, right) => right.messageCount - left.messageCount);
  const archiveSha256 = createHash('sha256').update(content).digest('hex');
  return {
    archiveId: archiveSha256.slice(0, 32),
    archiveName: safeFileName(archiveName),
    archiveSha256,
    chatFileName: safeFileName(textEntry.name),
    suggestedContactName: suggestedContactName(archiveName),
    suggestedPhoneE164: phoneFromSenders(senders.map((sender) => sender.name)),
    senders,
    messages,
    messageCount: messages.length,
    attachmentCount: messages.filter((message) => message.attachment).length,
    missingAttachmentCount: messages.filter(
      (message) => message.attachment && !message.attachment.entryName,
    ).length,
    startedAt: messages[0]?.occurredAt ?? null,
    endedAt: messages.at(-1)?.occurredAt ?? null,
  };
}

export function deterministicWhatsAppExportId(...parts: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 40);
}

import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import {
  basename,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import { inflateRawSync } from 'node:zlib';

import ExcelJS, { type CellValue, type Worksheet } from 'exceljs';
import JSZip from 'jszip';

import {
  CONVERSATION_HEADERS,
  DOCUMENT_HEADERS,
  type ConversationImportRow,
  type DocumentImportRow,
  type ImportIssue,
  MESSAGE_HEADERS,
  type MessageImportRow,
  type ParsedWhatsAppImportPackage,
  WHATSAPP_IMPORT_TABLES,
} from './whatsapp-import.types';

const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_PDF_BYTES = 100 * 1024 * 1024;
const MAX_UNCOMPRESSED_XLSX_BYTES = 64 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 2_000;
const MAX_CONVERSATIONS = 500;
const MAX_MESSAGES = 1_000;
const MAX_DOCUMENTS = 500;
const IGNORED_VALIDATION_HEADERS = new Set([
  'validation_status',
  'validation_message',
]);

interface TableContract {
  name: string;
  sheetName: string;
  headers: readonly string[];
  maxRows: number;
}

const TABLE_CONTRACTS: TableContract[] = [
  {
    name: WHATSAPP_IMPORT_TABLES.conversations,
    sheetName: 'Atendimentos',
    headers: CONVERSATION_HEADERS,
    maxRows: MAX_CONVERSATIONS,
  },
  {
    name: WHATSAPP_IMPORT_TABLES.messages,
    sheetName: 'Mensagens',
    headers: MESSAGE_HEADERS,
    maxRows: MAX_MESSAGES,
  },
  {
    name: WHATSAPP_IMPORT_TABLES.documents,
    sheetName: 'Documentos',
    headers: DOCUMENT_HEADERS,
    maxRows: MAX_DOCUMENTS,
  },
];

export class WhatsAppImportPackageError extends Error {
  constructor(readonly issues: ImportIssue[]) {
    super('O pacote de importação possui erros estruturais.');
  }
}

interface ResolvePackageOptions {
  importsRoot: string;
  packagePath: string;
  workbookPath?: string;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === '' ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== '..' &&
      !isAbsolute(pathFromParent))
  );
}

function archiveError(code: string, message: string): never {
  throw new WhatsAppImportPackageError([
    {
      severity: 'error',
      table: 'package',
      code,
      message,
    },
  ]);
}

export function preflightXlsxArchive(workbookBuffer: Buffer): void {
  const endOfCentralDirectorySignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const localHeaderSignature = 0x04034b50;
  const minimumEndRecordBytes = 22;
  const earliestEndRecord = Math.max(
    0,
    workbookBuffer.length - minimumEndRecordBytes - 65_535,
  );
  let endRecordOffset = -1;
  for (
    let offset = workbookBuffer.length - minimumEndRecordBytes;
    offset >= earliestEndRecord;
    offset -= 1
  ) {
    if (
      workbookBuffer.readUInt32LE(offset) === endOfCentralDirectorySignature
    ) {
      const commentLength = workbookBuffer.readUInt16LE(offset + 20);
      if (
        offset + minimumEndRecordBytes + commentLength ===
        workbookBuffer.length
      ) {
        endRecordOffset = offset;
        break;
      }
    }
  }
  if (endRecordOffset < 0) {
    archiveError(
      'INVALID_XLSX_ARCHIVE',
      'O XLSX não possui um diretório ZIP final válido.',
    );
  }
  const diskNumber = workbookBuffer.readUInt16LE(endRecordOffset + 4);
  const centralDisk = workbookBuffer.readUInt16LE(endRecordOffset + 6);
  const diskEntries = workbookBuffer.readUInt16LE(endRecordOffset + 8);
  const totalEntries = workbookBuffer.readUInt16LE(endRecordOffset + 10);
  const centralDirectoryBytes = workbookBuffer.readUInt32LE(
    endRecordOffset + 12,
  );
  const centralDirectoryOffset = workbookBuffer.readUInt32LE(
    endRecordOffset + 16,
  );
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== totalEntries ||
    totalEntries === 0xffff ||
    centralDirectoryBytes === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    archiveError(
      'UNSUPPORTED_XLSX_ARCHIVE',
      'XLSX multi-disco ou ZIP64 não é aceito pelo importador.',
    );
  }
  if (totalEntries > MAX_XLSX_ENTRIES) {
    archiveError(
      'XLSX_ENTRY_LIMIT_EXCEEDED',
      `A planilha excede o limite de ${MAX_XLSX_ENTRIES} entradas ZIP.`,
    );
  }
  if (
    centralDirectoryOffset + centralDirectoryBytes > endRecordOffset ||
    centralDirectoryOffset < 0
  ) {
    archiveError(
      'INVALID_XLSX_ARCHIVE',
      'O diretório central do XLSX está fora dos limites do arquivo.',
    );
  }

  let cursor = centralDirectoryOffset;
  let totalExpandedBytes = 0;
  const entryNames = new Set<string>();
  for (let index = 0; index < totalEntries; index += 1) {
    if (
      cursor + 46 > endRecordOffset ||
      workbookBuffer.readUInt32LE(cursor) !== centralDirectorySignature
    ) {
      archiveError(
        'INVALID_XLSX_ARCHIVE',
        'O diretório central do XLSX está truncado.',
      );
    }
    const flags = workbookBuffer.readUInt16LE(cursor + 8);
    const compressionMethod = workbookBuffer.readUInt16LE(cursor + 10);
    const compressedSize = workbookBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = workbookBuffer.readUInt32LE(cursor + 24);
    const fileNameLength = workbookBuffer.readUInt16LE(cursor + 28);
    const extraLength = workbookBuffer.readUInt16LE(cursor + 30);
    const commentLength = workbookBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = workbookBuffer.readUInt32LE(cursor + 42);
    const nextCursor =
      cursor + 46 + fileNameLength + extraLength + commentLength;
    if (
      nextCursor > endRecordOffset ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      archiveError(
        'UNSUPPORTED_XLSX_ARCHIVE',
        'Entradas ZIP64 ou truncadas não são aceitas.',
      );
    }
    const entryName = workbookBuffer
      .subarray(cursor + 46, cursor + 46 + fileNameLength)
      .toString('utf8');
    if (
      !entryName ||
      entryNames.has(entryName) ||
      isAbsolute(entryName) ||
      entryName.split(/[\\/]/).includes('..') ||
      entryName.includes('\0')
    ) {
      archiveError(
        'UNSAFE_XLSX_ENTRY',
        'A planilha contém uma entrada ZIP duplicada ou insegura.',
      );
    }
    entryNames.add(entryName);
    if (/(^|\/)(vbaProject\.bin|externalLinks)(\/|$)/i.test(entryName)) {
      archiveError(
        'ACTIVE_CONTENT_NOT_ALLOWED',
        'Macros e vínculos externos não são permitidos no pacote.',
      );
    }
    if ((flags & 0x0001) !== 0 || ![0, 8].includes(compressionMethod)) {
      archiveError(
        'UNSUPPORTED_XLSX_ARCHIVE',
        'Entradas criptografadas ou com compressão não suportada foram rejeitadas.',
      );
    }
    if (totalExpandedBytes + uncompressedSize > MAX_UNCOMPRESSED_XLSX_BYTES) {
      archiveError(
        'XLSX_EXPANSION_LIMIT_EXCEEDED',
        'O conteúdo descompactado da planilha excede 64 MiB.',
      );
    }
    if (
      localHeaderOffset + 30 > centralDirectoryOffset ||
      workbookBuffer.readUInt32LE(localHeaderOffset) !== localHeaderSignature
    ) {
      archiveError(
        'INVALID_XLSX_ARCHIVE',
        'Uma entrada do XLSX possui cabeçalho local inválido.',
      );
    }
    const localCompressionMethod = workbookBuffer.readUInt16LE(
      localHeaderOffset + 8,
    );
    const localFileNameLength = workbookBuffer.readUInt16LE(
      localHeaderOffset + 26,
    );
    const localExtraLength = workbookBuffer.readUInt16LE(
      localHeaderOffset + 28,
    );
    const dataOffset =
      localHeaderOffset + 30 + localFileNameLength + localExtraLength;
    if (
      localCompressionMethod !== compressionMethod ||
      dataOffset + compressedSize > centralDirectoryOffset
    ) {
      archiveError(
        'INVALID_XLSX_ARCHIVE',
        'Uma entrada do XLSX aponta para bytes fora do arquivo.',
      );
    }
    const compressed = workbookBuffer.subarray(
      dataOffset,
      dataOffset + compressedSize,
    );
    let actualExpandedBytes: number;
    if (compressionMethod === 0) {
      actualExpandedBytes = compressed.length;
    } else {
      try {
        actualExpandedBytes = inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, uncompressedSize + 1),
        }).length;
      } catch {
        archiveError(
          'XLSX_EXPANSION_LIMIT_EXCEEDED',
          'Uma entrada compactada excede o tamanho declarado ou é inválida.',
        );
      }
    }
    if (actualExpandedBytes !== uncompressedSize) {
      archiveError(
        'INVALID_XLSX_ARCHIVE',
        'O tamanho descompactado de uma entrada não corresponde ao diretório ZIP.',
      );
    }
    totalExpandedBytes += actualExpandedBytes;
    cursor = nextCursor;
  }
  if (cursor !== centralDirectoryOffset + centralDirectoryBytes) {
    archiveError(
      'INVALID_XLSX_ARCHIVE',
      'O tamanho do diretório central do XLSX é inconsistente.',
    );
  }
}

function stringValue(value: CellValue): string | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim() || undefined;
  }
  if (value instanceof Date) {
    return undefined;
  }
  if ('text' in value && typeof value.text === 'string') {
    return value.text.trim() || undefined;
  }
  if ('result' in value) {
    return stringValue(value.result);
  }
  return undefined;
}

function integerValue(value: CellValue): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(stringValue(value) ?? '', 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function booleanValue(value: CellValue): boolean | undefined {
  const normalized = stringValue(value)?.toLowerCase();
  if (normalized === 'sim' || normalized === 'true' || normalized === '1') {
    return true;
  }
  if (
    normalized === 'nao' ||
    normalized === 'não' ||
    normalized === 'false' ||
    normalized === '0'
  ) {
    return false;
  }
  return undefined;
}

function zonedWallClockToUtc(value: Date): Date {
  const desiredParts = {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
    hour: value.getUTCHours(),
    minute: value.getUTCMinutes(),
    second: value.getUTCSeconds(),
  };
  const desiredUtc = Date.UTC(
    desiredParts.year,
    desiredParts.month - 1,
    desiredParts.day,
    desiredParts.hour,
    desiredParts.minute,
    desiredParts.second,
    value.getUTCMilliseconds(),
  );
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
    const displayedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      value.getUTCMilliseconds(),
    );
    candidate += desiredUtc - displayedAsUtc;
  }
  return new Date(candidate);
}

function dateValue(value: CellValue): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return zonedWallClockToUtc(value);
  }
  return new Date(Number.NaN);
}

function addCount(
  counts: Record<string, number>,
  key: string | undefined,
): void {
  if (key) {
    counts[key] = (counts[key] ?? 0) + 1;
  }
}

function tableXmlAttributes(xml: string): {
  name?: string;
  ref?: string;
  columns: string[];
} {
  const tableTag = xml.match(/<(?:[A-Za-z0-9_-]+:)?table\b[^>]*>/)?.[0];
  const name = tableTag?.match(/\bname="([^"]+)"/)?.[1];
  const ref = tableTag?.match(/\bref="([^"]+)"/)?.[1];
  const columns = Array.from(
    xml.matchAll(
      /<(?:[A-Za-z0-9_-]+:)?tableColumn\b[^>]*\bname="([^"]+)"[^>]*\/?>/g,
    ),
    (match) => match[1],
  );
  return { name, ref, columns };
}

function xmlAttribute(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
}

function normalizeZipTarget(target: string, baseDirectory: string): string {
  const unixTarget = target.replaceAll('\\', '/');
  return unixTarget.startsWith('/')
    ? unixTarget.replace(/^\/+/, '')
    : posix.normalize(posix.join(baseDirectory, unixTarget));
}

function relationshipMap(
  xml: string,
  baseDirectory: string,
): Map<string, string> {
  return new Map(
    Array.from(
      xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?Relationship\b[^>]*\/?>/g),
      (match) => {
        const id = xmlAttribute(match[0], 'Id') ?? '';
        const rawTarget = xmlAttribute(match[0], 'Target') ?? '';
        const target = rawTarget
          ? normalizeZipTarget(rawTarget, baseDirectory)
          : '';
        return [id, target] as const;
      },
    ).filter(([id, target]) => id && target),
  );
}

function tableLastRow(ref: string | undefined): number | undefined {
  const match = ref?.match(/^A1:[A-Z]+(\d+)$/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function columnName(columnNumber: number): string {
  let current = columnNumber;
  let result = '';
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

async function mapImportTablesToSheets(
  zip: JSZip,
  issues: ImportIssue[],
): Promise<Map<string, { sheetName: string; ref: string }>> {
  const workbookXml = await zip.file('xl/workbook.xml')?.async('string');
  const workbookRelationshipsXml = await zip
    .file('xl/_rels/workbook.xml.rels')
    ?.async('string');
  if (!workbookXml || !workbookRelationshipsXml) {
    issueForPackage(
      issues,
      'INVALID_WORKBOOK_RELATIONSHIPS',
      'A planilha não possui relações internas válidas.',
    );
    return new Map();
  }
  const workbookRelationships = relationshipMap(workbookRelationshipsXml, 'xl');
  const sheetTargets = new Map<string, string>();
  for (const match of workbookXml.matchAll(
    /<(?:[A-Za-z0-9_-]+:)?sheet\b[^>]*\/?>/g,
  )) {
    const sheetName = xmlAttribute(match[0], 'name');
    const relationshipId =
      xmlAttribute(match[0], 'r:id') ?? xmlAttribute(match[0], 'id');
    const target = relationshipId
      ? workbookRelationships.get(relationshipId)
      : undefined;
    if (sheetName && target) {
      sheetTargets.set(sheetName, target);
    }
  }
  const result = new Map<string, { sheetName: string; ref: string }>();
  for (const contract of TABLE_CONTRACTS) {
    const worksheetTarget = sheetTargets.get(contract.sheetName);
    if (!worksheetTarget) {
      issueForPackage(
        issues,
        'MISSING_IMPORT_SHEET_RELATIONSHIP',
        `A aba ${contract.sheetName} não está relacionada no XLSX.`,
      );
      continue;
    }
    const worksheetXml = await zip.file(worksheetTarget)?.async('string');
    const worksheetFileName = worksheetTarget.split('/').at(-1);
    const relationshipPath = worksheetFileName
      ? `xl/worksheets/_rels/${worksheetFileName}.rels`
      : '';
    const worksheetRelationshipsXml = relationshipPath
      ? await zip.file(relationshipPath)?.async('string')
      : undefined;
    if (!worksheetXml || !worksheetRelationshipsXml) {
      issueForPackage(
        issues,
        'INVALID_IMPORT_SHEET_RELATIONSHIP',
        `A aba ${contract.sheetName} não possui relação com sua tabela.`,
      );
      continue;
    }
    const worksheetRelationships = relationshipMap(
      worksheetRelationshipsXml,
      'xl/worksheets',
    );
    const tableRelationshipIds = Array.from(
      worksheetXml.matchAll(/<(?:[A-Za-z0-9_-]+:)?tablePart\b[^>]*\/?>/g),
      (match) => xmlAttribute(match[0], 'r:id') ?? xmlAttribute(match[0], 'id'),
    ).filter((value): value is string => Boolean(value));
    let matched = false;
    for (const relationshipId of tableRelationshipIds) {
      const tableTarget = worksheetRelationships.get(relationshipId);
      if (!tableTarget) {
        continue;
      }
      const tableXml = await zip.file(tableTarget)?.async('string');
      if (!tableXml) {
        continue;
      }
      const attributes = tableXmlAttributes(tableXml);
      if (attributes.name === contract.name && attributes.ref) {
        result.set(contract.name, {
          sheetName: contract.sheetName,
          ref: attributes.ref,
        });
        matched = true;
      }
    }
    if (!matched) {
      issueForPackage(
        issues,
        'TABLE_ON_WRONG_SHEET',
        `${contract.name} deve estar exclusivamente na aba ${contract.sheetName}.`,
      );
    }
  }
  return result;
}

function issueForPackage(
  issues: ImportIssue[],
  code: string,
  message: string,
): void {
  issues.push({
    severity: 'error',
    table: 'package',
    code,
    message,
  });
}

function hasFormula(value: CellValue): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    'formula' in value
  );
}

function meaningfulRow(
  worksheet: Worksheet,
  rowNumber: number,
  headers: readonly string[],
): boolean {
  return headers.some((header, columnIndex) => {
    if (IGNORED_VALIDATION_HEADERS.has(header)) {
      return false;
    }
    const value = worksheet.getRow(rowNumber).getCell(columnIndex + 1).value;
    return value !== null && value !== undefined && value !== '';
  });
}

function collectFormulaIssues(
  worksheet: Worksheet,
  rowNumber: number,
  headers: readonly string[],
  table: ImportIssue['table'],
  issues: ImportIssue[],
): void {
  headers.forEach((header, columnIndex) => {
    if (IGNORED_VALIDATION_HEADERS.has(header)) {
      return;
    }
    const value = worksheet.getRow(rowNumber).getCell(columnIndex + 1).value;
    if (hasFormula(value)) {
      issues.push({
        severity: 'error',
        table,
        rowNumber,
        code: 'FORMULA_NOT_ALLOWED',
        message: `A coluna ${header} não aceita fórmulas.`,
      });
    }
  });
}

function cell(
  worksheet: Worksheet,
  rowNumber: number,
  columnIndex: number,
): CellValue {
  return worksheet.getRow(rowNumber).getCell(columnIndex + 1).value;
}

function appendTransferDetails(
  notes: string | undefined,
  transferDetails: string | undefined,
): string | undefined {
  if (!transferDetails) {
    return notes;
  }
  if (
    notes
      ?.toLocaleLowerCase('pt-BR')
      .includes(transferDetails.toLocaleLowerCase('pt-BR'))
  ) {
    return notes;
  }
  return [notes, `Traslado: ${transferDetails}`].filter(Boolean).join('\n');
}

function readConversationRows(
  worksheet: Worksheet,
  lastTableRow: number,
  issues: ImportIssue[],
): ConversationImportRow[] {
  const rows: ConversationImportRow[] = [];
  for (let rowNumber = 2; rowNumber <= lastTableRow; rowNumber += 1) {
    if (!meaningfulRow(worksheet, rowNumber, CONVERSATION_HEADERS)) {
      continue;
    }
    collectFormulaIssues(
      worksheet,
      rowNumber,
      CONVERSATION_HEADERS,
      'Atendimentos',
      issues,
    );
    const transferDetails = stringValue(cell(worksheet, rowNumber, 27));
    rows.push({
      rowNumber,
      externalConversationId: stringValue(cell(worksheet, rowNumber, 0)) ?? '',
      sourceSystem: stringValue(cell(worksheet, rowNumber, 1)) ?? '',
      phoneE164: stringValue(cell(worksheet, rowNumber, 2)) ?? '',
      contactName: stringValue(cell(worksheet, rowNumber, 3)),
      channelPhoneE164: stringValue(cell(worksheet, rowNumber, 4)) ?? '',
      departmentCode: stringValue(cell(worksheet, rowNumber, 5)) ?? '',
      ownerUsername: stringValue(cell(worksheet, rowNumber, 6)),
      conversationState: stringValue(cell(worksheet, rowNumber, 7)) ?? '',
      flowStep: stringValue(cell(worksheet, rowNumber, 8)) ?? '',
      requestStatus: stringValue(cell(worksheet, rowNumber, 9)) ?? '',
      lastInteractionAt: dateValue(cell(worksheet, rowNumber, 10)),
      lastMessagePreview: stringValue(cell(worksheet, rowNumber, 11)),
      unreadCount: integerValue(cell(worksheet, rowNumber, 12)) ?? 0,
      quoteSequence: integerValue(cell(worksheet, rowNumber, 13)),
      quoteContactName: stringValue(cell(worksheet, rowNumber, 14)),
      quoteDocument: stringValue(cell(worksheet, rowNumber, 15)),
      quoteEmail: stringValue(cell(worksheet, rowNumber, 16)),
      serviceType: stringValue(cell(worksheet, rowNumber, 17)),
      tripType: stringValue(cell(worksheet, rowNumber, 18)),
      origin: stringValue(cell(worksheet, rowNumber, 19)),
      destination: stringValue(cell(worksheet, rowNumber, 20)),
      departureAt: (() => {
        const value = cell(worksheet, rowNumber, 21);
        return value === null || value === undefined || value === ''
          ? undefined
          : dateValue(value);
      })(),
      returnAt: (() => {
        const value = cell(worksheet, rowNumber, 22);
        return value === null || value === undefined || value === ''
          ? undefined
          : dateValue(value);
      })(),
      passengerCount: integerValue(cell(worksheet, rowNumber, 23)),
      vehicleType: stringValue(cell(worksheet, rowNumber, 24)),
      vehicleAtDisposal: booleanValue(cell(worksheet, rowNumber, 25)),
      localTransfers: booleanValue(cell(worksheet, rowNumber, 26)),
      transferDetails,
      notes: appendTransferDetails(
        stringValue(cell(worksheet, rowNumber, 28)),
        transferDetails,
      ),
      confirmedAt: (() => {
        const value = cell(worksheet, rowNumber, 29);
        return value === null || value === undefined || value === ''
          ? undefined
          : dateValue(value);
      })(),
      decisionReason: stringValue(cell(worksheet, rowNumber, 30)),
      decidedAt: (() => {
        const value = cell(worksheet, rowNumber, 31);
        return value === null || value === undefined || value === ''
          ? undefined
          : dateValue(value);
      })(),
      migrationAction: stringValue(cell(worksheet, rowNumber, 32)) ?? '',
    });
  }
  return rows;
}

function readMessageRows(
  worksheet: Worksheet,
  lastTableRow: number,
  issues: ImportIssue[],
): MessageImportRow[] {
  const rows: MessageImportRow[] = [];
  for (let rowNumber = 2; rowNumber <= lastTableRow; rowNumber += 1) {
    if (!meaningfulRow(worksheet, rowNumber, MESSAGE_HEADERS)) {
      continue;
    }
    collectFormulaIssues(
      worksheet,
      rowNumber,
      MESSAGE_HEADERS,
      'Mensagens',
      issues,
    );
    rows.push({
      rowNumber,
      externalConversationId: stringValue(cell(worksheet, rowNumber, 0)) ?? '',
      externalMessageId: stringValue(cell(worksheet, rowNumber, 1)) ?? '',
      direction: stringValue(cell(worksheet, rowNumber, 2)) ?? '',
      kind: stringValue(cell(worksheet, rowNumber, 3)) ?? '',
      occurredAt: dateValue(cell(worksheet, rowNumber, 4)),
      deliveryStatus: stringValue(cell(worksheet, rowNumber, 5)) ?? '',
      text: stringValue(cell(worksheet, rowNumber, 6)),
      mediaReference: stringValue(cell(worksheet, rowNumber, 7)),
      actorUsername: stringValue(cell(worksheet, rowNumber, 8)),
      providerMessageId: stringValue(cell(worksheet, rowNumber, 9)),
      correlationId: stringValue(cell(worksheet, rowNumber, 10)),
    });
  }
  return rows;
}

async function readDocumentRows(
  worksheet: Worksheet,
  lastTableRow: number,
  packageRealPath: string,
  issues: ImportIssue[],
): Promise<DocumentImportRow[]> {
  const rows: DocumentImportRow[] = [];
  let totalPdfBytes = 0;
  const filesDirectory = join(packageRealPath, 'files');
  const filesDirectoryStat = await lstat(filesDirectory).catch(() => undefined);
  const resolvedFilesRoot =
    filesDirectoryStat?.isDirectory() && !filesDirectoryStat.isSymbolicLink()
      ? await realpath(filesDirectory).catch(() => undefined)
      : undefined;
  const filesRoot =
    resolvedFilesRoot && isInside(packageRealPath, resolvedFilesRoot)
      ? resolvedFilesRoot
      : undefined;
  for (let rowNumber = 2; rowNumber <= lastTableRow; rowNumber += 1) {
    if (!meaningfulRow(worksheet, rowNumber, DOCUMENT_HEADERS)) {
      continue;
    }
    collectFormulaIssues(
      worksheet,
      rowNumber,
      DOCUMENT_HEADERS,
      'Documentos',
      issues,
    );
    const relativeFilePath = stringValue(cell(worksheet, rowNumber, 4)) ?? '';
    let absoluteFilePath = '';
    let sizeBytes = 0;
    let calculatedSha256 = '';
    const normalizedRelative = relativeFilePath.replaceAll('\\', '/');
    if (
      !filesRoot ||
      !normalizedRelative.startsWith('files/') ||
      isAbsolute(relativeFilePath) ||
      normalizedRelative.split('/').includes('..')
    ) {
      issues.push({
        severity: 'error',
        table: 'Documentos',
        rowNumber,
        code: 'INVALID_DOCUMENT_PATH',
        message:
          'relative_file_path deve apontar para um arquivo dentro de files/.',
      });
    } else {
      const candidate = resolve(packageRealPath, relativeFilePath);
      const candidateLstat = await lstat(candidate).catch(() => undefined);
      const candidateRealPath = await realpath(candidate).catch(
        () => undefined,
      );
      const candidateStat = candidateRealPath
        ? await lstat(candidateRealPath).catch(() => undefined)
        : undefined;
      if (
        candidateLstat?.isSymbolicLink() ||
        !candidateRealPath ||
        !candidateStat?.isFile() ||
        !isInside(filesRoot, candidateRealPath)
      ) {
        issues.push({
          severity: 'error',
          table: 'Documentos',
          rowNumber,
          code: 'DOCUMENT_NOT_FOUND_OR_UNSAFE',
          message: `O arquivo ${relativeFilePath || '(vazio)'} não existe ou não é seguro.`,
        });
      } else if (candidateStat.size > MAX_PDF_BYTES) {
        issues.push({
          severity: 'error',
          table: 'Documentos',
          rowNumber,
          code: 'DOCUMENT_TOO_LARGE',
          message: 'Cada PDF deve possuir no máximo 10 MiB.',
        });
      } else if (totalPdfBytes + candidateStat.size > MAX_TOTAL_PDF_BYTES) {
        issues.push({
          severity: 'error',
          table: 'Documentos',
          rowNumber,
          code: 'DOCUMENT_TOTAL_SIZE_EXCEEDED',
          message: 'O conjunto de PDFs do lote deve possuir no máximo 100 MiB.',
        });
      } else {
        totalPdfBytes += candidateStat.size;
        const content = await readFile(candidateRealPath);
        if (!content.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
          issues.push({
            severity: 'error',
            table: 'Documentos',
            rowNumber,
            code: 'INVALID_PDF_MAGIC',
            message: `${relativeFilePath} não possui assinatura PDF válida.`,
          });
        }
        absoluteFilePath = candidateRealPath;
        sizeBytes = content.length;
        calculatedSha256 = sha256(content);
      }
    }
    rows.push({
      rowNumber,
      externalConversationId: stringValue(cell(worksheet, rowNumber, 0)) ?? '',
      quoteSequence: integerValue(cell(worksheet, rowNumber, 1)) ?? 0,
      externalDocumentId: stringValue(cell(worksheet, rowNumber, 2)) ?? '',
      fileName:
        stringValue(cell(worksheet, rowNumber, 3)) ??
        basename(relativeFilePath),
      relativeFilePath,
      mimeType: stringValue(cell(worksheet, rowNumber, 5)) ?? '',
      documentStatus: stringValue(cell(worksheet, rowNumber, 6)) ?? '',
      sentAt: (() => {
        const value = cell(worksheet, rowNumber, 7);
        return value === null || value === undefined || value === ''
          ? undefined
          : dateValue(value);
      })(),
      providerMessageId: stringValue(cell(worksheet, rowNumber, 8)),
      expectedSha256: stringValue(cell(worksheet, rowNumber, 9))?.toLowerCase(),
      absoluteFilePath,
      sizeBytes,
      sha256: calculatedSha256,
    });
  }
  return rows;
}

async function resolvePackage(options: ResolvePackageOptions): Promise<{
  packageRealPath: string;
  workbookRealPath: string;
}> {
  const importsRootRealPath = await realpath(options.importsRoot).catch(
    () => undefined,
  );
  if (!importsRootRealPath) {
    throw new WhatsAppImportPackageError([
      {
        severity: 'error',
        table: 'package',
        code: 'IMPORTS_ROOT_NOT_FOUND',
        message: `O diretório privado de importações não existe: ${options.importsRoot}`,
      },
    ]);
  }
  const packageInputStat = await lstat(options.packagePath).catch(
    () => undefined,
  );
  const packageRealPath = await realpath(options.packagePath).catch(
    () => undefined,
  );
  if (
    !packageInputStat ||
    packageInputStat.isSymbolicLink() ||
    !packageRealPath ||
    !isInside(importsRootRealPath, packageRealPath)
  ) {
    throw new WhatsAppImportPackageError([
      {
        severity: 'error',
        table: 'package',
        code: 'PACKAGE_OUTSIDE_IMPORT_ROOT',
        message: 'O pacote deve estar dentro de var/imports/whatsapp.',
      },
    ]);
  }
  const packageStat = await stat(packageRealPath);
  const workbookCandidate = options.workbookPath
    ? resolve(packageRealPath, options.workbookPath)
    : packageStat.isFile()
      ? packageRealPath
      : join(packageRealPath, 'modelo-importacao-atendimentos-whatsapp.xlsx');
  const resolvedPackageDirectory = packageStat.isFile()
    ? resolve(packageRealPath, '..')
    : packageRealPath;
  const workbookCandidateStat = await lstat(workbookCandidate).catch(
    () => undefined,
  );
  const workbookRealPath = await realpath(workbookCandidate).catch(
    () => undefined,
  );
  if (
    !workbookCandidateStat ||
    workbookCandidateStat.isSymbolicLink() ||
    !workbookRealPath ||
    !isInside(resolvedPackageDirectory, workbookRealPath) ||
    extname(workbookRealPath).toLowerCase() !== '.xlsx'
  ) {
    throw new WhatsAppImportPackageError([
      {
        severity: 'error',
        table: 'package',
        code: 'INVALID_WORKBOOK_PATH',
        message: 'A planilha XLSX deve estar dentro do diretório do lote.',
      },
    ]);
  }
  const workbookStat = await lstat(workbookRealPath);
  if (
    !workbookStat.isFile() ||
    workbookStat.isSymbolicLink() ||
    workbookStat.size > MAX_WORKBOOK_BYTES
  ) {
    throw new WhatsAppImportPackageError([
      {
        severity: 'error',
        table: 'package',
        code: 'INVALID_WORKBOOK_FILE',
        message: 'A planilha deve ser um arquivo regular de até 10 MiB.',
      },
    ]);
  }
  return {
    packageRealPath: resolvedPackageDirectory,
    workbookRealPath,
  };
}

async function loadWorkbook(
  workbookBuffer: Buffer,
  issues: ImportIssue[],
): Promise<{
  workbook: ExcelJS.Workbook;
  tableLastRows: Map<string, number>;
}> {
  preflightXlsxArchive(workbookBuffer);
  const zip = await JSZip.loadAsync(workbookBuffer, {
    checkCRC32: true,
    createFolders: false,
  }).catch(() => undefined);
  if (!zip) {
    throw new WhatsAppImportPackageError([
      {
        severity: 'error',
        table: 'package',
        code: 'INVALID_XLSX_ARCHIVE',
        message: 'O arquivo não é um contêiner XLSX válido.',
      },
    ]);
  }
  const entryNames = Object.keys(zip.files);
  if (entryNames.length > MAX_XLSX_ENTRIES) {
    issues.push({
      severity: 'error',
      table: 'package',
      code: 'XLSX_ENTRY_LIMIT_EXCEEDED',
      message: `A planilha excede o limite de ${MAX_XLSX_ENTRIES} entradas ZIP.`,
    });
  }
  if (
    entryNames.some((name) =>
      /(^|\/)(vbaProject\.bin|externalLinks)(\/|$)/i.test(name),
    )
  ) {
    issues.push({
      severity: 'error',
      table: 'package',
      code: 'ACTIVE_CONTENT_NOT_ALLOWED',
      message: 'Macros e vínculos externos não são permitidos no pacote.',
    });
  }
  let declaredUncompressedBytes = 0;
  for (const entry of Object.values(zip.files)) {
    const unsafeName = (entry as typeof entry & { unsafeOriginalName?: string })
      .unsafeOriginalName;
    if (
      unsafeName &&
      (isAbsolute(unsafeName) || unsafeName.split(/[\\/]/).includes('..'))
    ) {
      issues.push({
        severity: 'error',
        table: 'package',
        code: 'UNSAFE_XLSX_ENTRY',
        message: 'A planilha contém uma entrada ZIP insegura.',
      });
    }
    const uncompressedSize = (
      entry as typeof entry & {
        _data?: { uncompressedSize?: number };
      }
    )._data?.uncompressedSize;
    declaredUncompressedBytes += uncompressedSize ?? 0;
  }
  if (declaredUncompressedBytes > MAX_UNCOMPRESSED_XLSX_BYTES) {
    issues.push({
      severity: 'error',
      table: 'package',
      code: 'XLSX_EXPANSION_LIMIT_EXCEEDED',
      message: 'O conteúdo descompactado da planilha excede 64 MiB.',
    });
  }

  const foundTables = new Map<string, { ref?: string; columns: string[] }>();
  for (const entryName of entryNames.filter((name) =>
    /^xl\/tables\/[^/]+\.xml$/i.test(name),
  )) {
    const entry = zip.file(entryName);
    if (!entry) {
      continue;
    }
    const attributes = tableXmlAttributes(await entry.async('string'));
    if (attributes.name) {
      if (foundTables.has(attributes.name)) {
        issues.push({
          severity: 'error',
          table: 'package',
          code: 'DUPLICATE_TABLE_NAME',
          message: `A tabela ${attributes.name} aparece mais de uma vez.`,
        });
      }
      foundTables.set(attributes.name, {
        ref: attributes.ref,
        columns: attributes.columns,
      });
    }
  }
  for (const contract of TABLE_CONTRACTS) {
    const table = foundTables.get(contract.name);
    if (!table) {
      issues.push({
        severity: 'error',
        table: 'package',
        code: 'MISSING_IMPORT_TABLE',
        message: `A tabela ${contract.name} não foi encontrada.`,
      });
      continue;
    }
    if (
      table.columns.length !== contract.headers.length ||
      table.columns.some((header, index) => header !== contract.headers[index])
    ) {
      issues.push({
        severity: 'error',
        table: 'package',
        code: 'INVALID_TABLE_HEADERS',
        message: `Os cabeçalhos de ${contract.name} foram alterados.`,
      });
    }
    const lastRow = tableLastRow(table.ref) ?? 0;
    const expectedEndColumn = columnName(contract.headers.length);
    if (
      !table.ref ||
      !new RegExp(`^A1:${expectedEndColumn}\\d+$`).test(table.ref)
    ) {
      issues.push({
        severity: 'error',
        table: 'package',
        code: 'INVALID_TABLE_RANGE',
        message: `${contract.name} deve começar em A1.`,
      });
    }
    if (lastRow - 1 > contract.maxRows) {
      issues.push({
        severity: 'error',
        table: 'package',
        code: 'TABLE_ROW_LIMIT_EXCEEDED',
        message: `${contract.name} excede o limite de ${contract.maxRows} linhas.`,
      });
    }
  }
  const tableSheetMappings = await mapImportTablesToSheets(zip, issues);

  for (const entryName of entryNames.filter((name) => name.endsWith('.xml'))) {
    const entry = zip.file(entryName);
    if (!entry) {
      continue;
    }
    let xml = await entry.async('string');
    xml = xml
      .replace(/<x:tableParts[\s\S]*?<\/x:tableParts>/g, '')
      .replace(/<tableParts[\s\S]*?<\/tableParts>/g, '')
      .replace(/<\/?x:/g, (match) => (match.startsWith('</') ? '</' : '<'))
      .replace(/xmlns:x=/g, 'xmlns=');
    zip.file(entryName, xml);
  }
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new WhatsAppImportPackageError(issues);
  }
  const normalizedBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 1 },
  });
  const workbook = new ExcelJS.Workbook();
  const normalizedArrayBuffer = normalizedBuffer.buffer.slice(
    normalizedBuffer.byteOffset,
    normalizedBuffer.byteOffset + normalizedBuffer.byteLength,
  ) as ArrayBuffer;
  await workbook.xlsx.load(normalizedArrayBuffer, {
    ignoreNodes: ['tableParts'],
  });
  return {
    workbook,
    tableLastRows: new Map(
      TABLE_CONTRACTS.map((contract) => [
        contract.name,
        tableLastRow(tableSheetMappings.get(contract.name)?.ref) ?? 1,
      ]),
    ),
  };
}

export async function parseWhatsAppImportPackage(
  options: ResolvePackageOptions,
): Promise<ParsedWhatsAppImportPackage> {
  const issues: ImportIssue[] = [];
  const { packageRealPath, workbookRealPath } = await resolvePackage(options);
  const workbookBuffer = await readFile(workbookRealPath);
  const { workbook, tableLastRows } = await loadWorkbook(
    workbookBuffer,
    issues,
  );
  const sheets = new Map(
    workbook.worksheets.map((worksheet) => [worksheet.name, worksheet]),
  );
  for (const contract of TABLE_CONTRACTS) {
    const worksheet = sheets.get(contract.sheetName);
    if (!worksheet) {
      issues.push({
        severity: 'error',
        table: 'package',
        code: 'MISSING_IMPORT_SHEET',
        message: `A aba ${contract.sheetName} não foi encontrada.`,
      });
      continue;
    }
    const actualHeaders = contract.headers.map((_, index) =>
      stringValue(worksheet.getRow(1).getCell(index + 1).value),
    );
    if (
      actualHeaders.some((header, index) => header !== contract.headers[index])
    ) {
      issues.push({
        severity: 'error',
        table: 'package',
        code: 'INVALID_SHEET_HEADERS',
        message: `Os cabeçalhos visíveis de ${contract.sheetName} foram alterados.`,
      });
    }
  }
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new WhatsAppImportPackageError(issues);
  }
  const conversations = readConversationRows(
    sheets.get('Atendimentos')!,
    tableLastRows.get(WHATSAPP_IMPORT_TABLES.conversations) ?? 1,
    issues,
  );
  const messages = readMessageRows(
    sheets.get('Mensagens')!,
    tableLastRows.get(WHATSAPP_IMPORT_TABLES.messages) ?? 1,
    issues,
  );
  const documents = await readDocumentRows(
    sheets.get('Documentos')!,
    tableLastRows.get(WHATSAPP_IMPORT_TABLES.documents) ?? 1,
    packageRealPath,
    issues,
  );
  if (conversations.length > MAX_CONVERSATIONS) {
    issues.push({
      severity: 'error',
      table: 'Atendimentos',
      code: 'CONVERSATION_ROW_LIMIT_EXCEEDED',
      message: `O lote contém mais de ${MAX_CONVERSATIONS} atendimentos.`,
    });
  }
  if (messages.length > MAX_MESSAGES) {
    issues.push({
      severity: 'error',
      table: 'Mensagens',
      code: 'MESSAGE_ROW_LIMIT_EXCEEDED',
      message: `O lote contém mais de ${MAX_MESSAGES} mensagens.`,
    });
  }
  if (documents.length > MAX_DOCUMENTS) {
    issues.push({
      severity: 'error',
      table: 'Documentos',
      code: 'DOCUMENT_ROW_LIMIT_EXCEEDED',
      message: `O lote contém mais de ${MAX_DOCUMENTS} documentos.`,
    });
  }
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new WhatsAppImportPackageError(issues);
  }
  const workbookSha256 = sha256(workbookBuffer);
  const packageSha256 = sha256(
    JSON.stringify({
      workbookSha256,
      documents: documents
        .map((document) => ({
          externalConversationId: document.externalConversationId,
          externalDocumentId: document.externalDocumentId,
          relativeFilePath: document.relativeFilePath.replaceAll('\\', '/'),
          sizeBytes: document.sizeBytes,
          sha256: document.sha256,
        }))
        .sort((left, right) =>
          [
            left.externalConversationId,
            left.externalDocumentId,
            left.relativeFilePath,
          ]
            .join('\0')
            .localeCompare(
              [
                right.externalConversationId,
                right.externalDocumentId,
                right.relativeFilePath,
              ].join('\0'),
            ),
        ),
    }),
  );
  return {
    packagePath: packageRealPath,
    workbookPath: workbookRealPath,
    workbookSha256,
    packageSha256,
    conversations,
    messages,
    documents,
  };
}

export function importPayloadHash(value: unknown): string {
  return sha256(JSON.stringify(value));
}

export function incrementImportCount(
  counts: Record<string, number>,
  key: string | undefined,
): void {
  addCount(counts, key);
}

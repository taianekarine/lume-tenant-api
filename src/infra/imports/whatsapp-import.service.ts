import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { formatWhatsAppPhone } from '../../shared/utils/normalization';

import {
  ConversationState,
  DeliveryStatus,
  DepartmentCode,
  FlowStep,
  MessageDirection,
  MessageKind,
  Prisma,
  QuoteProposalDocumentStatus,
  RequestStatus,
  UserAccountStatus,
  WhatsAppImportBatchStatus,
  WhatsAppImportRecordStatus,
  type WhatsAppImportBatch,
  type WhatsAppImportRecord,
} from '../database/prisma/generated/client';
import { PrismaService } from '../database/prisma/prisma.service';
import {
  importPayloadHash,
  incrementImportCount,
  parseWhatsAppImportPackage,
  WhatsAppImportPackageError,
} from './whatsapp-import-package';
import {
  dateOnlyFromDateTime,
  presentDateOnly,
} from '../../domain/whatsapp/quote-schedule';
import {
  emptyImportCounts,
  IMPORT_DEPARTMENT_CODES,
  type ConversationImportRow,
  type DocumentImportRow,
  type ImportIssue,
  type MessageImportRow,
  type ParsedWhatsAppImportPackage,
  type WhatsAppImportApplyInput,
  type WhatsAppImportCounts,
  type WhatsAppImportInput,
  type WhatsAppImportRollbackInput,
  type WhatsAppImportValidationReport,
} from './whatsapp-import.types';

const OPEN_STATES = new Set([
  'bot-active',
  'waiting-for-customer',
  'sent-to-human',
  'human-active',
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPORT_BATCH_LEASE_MS = 5 * 60 * 1_000;
const IMPORT_TRANSACTION_MAX_WAIT_MS = 10_000;
const IMPORT_TRANSACTION_TIMEOUT_MS = 120_000;
const IMPORT_TRANSACTION_MAX_ATTEMPTS = 8;
const IMPORT_TRANSACTION_RETRY_BASE_DELAY_MS = 50;
const IMPORT_CREATE_MANY_CHUNK_SIZE = 1_000;
const IMPORT_LOOKUP_CHUNK_SIZE = 1_000;

const DEPARTMENT_TO_PRISMA: Record<string, DepartmentCode> = {
  commercial: DepartmentCode.COMMERCIAL,
  purchasing: DepartmentCode.PURCHASING,
  controlling: DepartmentCode.CONTROLLING,
  'personnel-department': DepartmentCode.PERSONNEL_DEPARTMENT,
  financial: DepartmentCode.FINANCIAL,
  management: DepartmentCode.MANAGEMENT,
  maintenance: DepartmentCode.MAINTENANCE,
  monitoring: DepartmentCode.MONITORING,
  operations: DepartmentCode.OPERATIONS,
};

const STATE_TO_PRISMA: Record<string, ConversationState> = {
  'bot-active': ConversationState.BOT_ACTIVE,
  'waiting-for-customer': ConversationState.WAITING_FOR_CUSTOMER,
  'sent-to-human': ConversationState.SENT_TO_HUMAN,
  'human-active': ConversationState.HUMAN_ACTIVE,
  closed: ConversationState.CLOSED,
};

const FLOW_TO_PRISMA: Record<string, FlowStep> = {
  'main-menu': FlowStep.MAIN_MENU,
  'commercial-menu': FlowStep.COMMERCIAL_MENU,
  'quote-data-collection': FlowStep.QUOTE_DATA_COLLECTION,
  'quote-summary-confirmation': FlowStep.QUOTE_SUMMARY_CONFIRMATION,
  'quote-send-pending': FlowStep.QUOTE_SEND_PENDING,
  'commercial-follow-up-menu': FlowStep.COMMERCIAL_FOLLOW_UP_MENU,
  'human-service': FlowStep.HUMAN_SERVICE,
  closed: FlowStep.CLOSED,
};

const REQUEST_TO_PRISMA: Record<string, RequestStatus> = {
  'not-started': RequestStatus.NOT_STARTED,
  'collecting-information': RequestStatus.COLLECTING_INFORMATION,
  'waiting-for-customer': RequestStatus.WAITING_FOR_CUSTOMER,
  'under-review': RequestStatus.UNDER_REVIEW,
  approved: RequestStatus.APPROVED,
  rejected: RequestStatus.REJECTED,
  cancelled: RequestStatus.CANCELLED,
};

const DIRECTION_TO_PRISMA: Record<string, MessageDirection> = {
  inbound: MessageDirection.INBOUND,
  outbound: MessageDirection.OUTBOUND,
};

const DELIVERY_TO_PRISMA: Record<string, DeliveryStatus> = {
  received: DeliveryStatus.RECEIVED,
  pending: DeliveryStatus.PENDING,
  sent: DeliveryStatus.SENT,
  delivered: DeliveryStatus.DELIVERED,
  read: DeliveryStatus.READ,
  failed: DeliveryStatus.FAILED,
};

const KIND_TO_PRISMA: Record<string, MessageKind> = {
  text: MessageKind.TEXT,
  image: MessageKind.IMAGE,
  document: MessageKind.DOCUMENT,
  audio: MessageKind.AUDIO,
  video: MessageKind.VIDEO,
  sticker: MessageKind.STICKER,
  location: MessageKind.LOCATION,
  contact: MessageKind.CONTACT,
  unknown: MessageKind.UNKNOWN,
};

const DOCUMENT_STATUS_TO_PRISMA: Record<string, QuoteProposalDocumentStatus> = {
  uploaded: QuoteProposalDocumentStatus.UPLOADED,
  sent: QuoteProposalDocumentStatus.SENT,
  failed: QuoteProposalDocumentStatus.FAILED,
};

const VALID_STATE_COMBINATIONS = new Set([
  'human-active|human-service|not-started',
  'human-active|human-service|collecting-information',
  'human-active|human-service|waiting-for-customer',
  'human-active|human-service|under-review',
  'human-active|human-service|approved',
  'human-active|human-service|rejected',
  'human-active|human-service|cancelled',
  'sent-to-human|human-service|not-started',
  'sent-to-human|human-service|collecting-information',
  'sent-to-human|human-service|waiting-for-customer',
  'sent-to-human|human-service|under-review',
  'sent-to-human|human-service|rejected',
  'sent-to-human|human-service|cancelled',
  'bot-active|quote-data-collection|collecting-information',
  'waiting-for-customer|quote-summary-confirmation|waiting-for-customer',
  'bot-active|commercial-follow-up-menu|under-review',
  'waiting-for-customer|quote-send-pending|waiting-for-customer',
  'bot-active|commercial-follow-up-menu|approved',
  'closed|closed|rejected',
  'closed|closed|cancelled',
  'closed|closed|not-started',
  'bot-active|main-menu|not-started',
  'bot-active|commercial-menu|not-started',
]);

type Transaction = Prisma.TransactionClient;

interface PreparedImport {
  package: ParsedWhatsAppImportPackage;
  report: WhatsAppImportValidationReport;
}

interface Snapshot {
  contact: Record<string, unknown> | null;
  conversation: Record<string, unknown> | null;
  quoteRequest: Record<string, unknown> | null;
}

interface CreatedResourceIds {
  contactId?: string;
  conversationId?: string;
  quoteRequestId?: string;
  messageIds: string[];
  documentIds: string[];
  externalRefIds: string[];
}

interface AppliedConversationResult {
  created: boolean;
  contactCreated: boolean;
  contactUpdated: boolean;
  quoteCreated: boolean;
  quoteUpdated: boolean;
  conversationId: string;
  contactId: string;
  messageCount: number;
  documentCount: number;
}

function groupByConversation<T extends { externalConversationId: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const current = grouped.get(row.externalConversationId);
    if (current) current.push(row);
    else grouped.set(row.externalConversationId, [row]);
  }
  return grouped;
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    result.push(rows.slice(offset, offset + size));
  }
  return result;
}

async function collectChunked<T, R>(
  rows: readonly T[],
  size: number,
  handler: (chunk: readonly T[]) => Promise<readonly R[]>,
): Promise<R[]> {
  const result: R[] = [];
  for (const chunk of chunks(rows, size)) {
    result.push(...(await handler(chunk)));
  }
  return result;
}

async function mapWithConcurrency<T, R>(
  rows: readonly T[],
  concurrency: number,
  handler: (row: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(rows.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(concurrency, Math.max(1, rows.length)) },
    async () => {
      while (firstError === undefined) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= rows.length) return;
        try {
          results[index] = await handler(rows[index], index);
        } catch (error) {
          firstError ??= error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstError !== undefined) {
    throw firstError instanceof Error
      ? firstError
      : new Error('Falha desconhecida ao aplicar uma conversa.');
  }
  return results;
}

export function isTransactionWriteConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (
    ('code' in error &&
      ['P2034', '40001', '40P01'].includes(String(error.code))) ||
    ('kind' in error && error.kind === 'TransactionWriteConflict')
  ) {
    return true;
  }
  if (
    'message' in error &&
    typeof error.message === 'string' &&
    /write conflict|deadlock|serialization failure|transactionwriteconflict/i.test(
      error.message,
    )
  ) {
    return true;
  }
  return 'cause' in error && isTransactionWriteConflict(error.cause);
}

async function retryTransactionWriteConflict<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        !isTransactionWriteConflict(error) ||
        attempt >= IMPORT_TRANSACTION_MAX_ATTEMPTS
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(
            1_000,
            IMPORT_TRANSACTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          ) +
            Math.floor(Math.random() * IMPORT_TRANSACTION_RETRY_BASE_DELAY_MS),
        ),
      );
    }
  }
}

function normalizeUsername(value: string): string {
  return value.trim().toLocaleLowerCase('pt-BR');
}

function deterministicCorrelation(
  sourceSystem: string,
  externalMessageId: string,
): string {
  return `legacy-import:${createHash('sha256')
    .update(sourceSystem)
    .update('\0')
    .update(externalMessageId)
    .digest('hex')}`;
}

function externalKey(sourceSystem: string, externalId: string): string {
  return `${sourceSystem}\0${externalId}`;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function importedMediaMetadata(
  mediaReference: string | null | undefined,
  correlationId: string | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (!mediaReference && !correlationId) return undefined;

  let fileName: string | undefined;
  const isRetainedImportReference =
    mediaReference?.startsWith('whatsapp-export://') ||
    mediaReference?.startsWith('whatsapp-android-media://') ||
    false;
  if (isRetainedImportReference && mediaReference) {
    const encodedFileName = mediaReference.split('/').at(-1);
    if (encodedFileName) {
      try {
        fileName = decodeURIComponent(encodedFileName);
      } catch {
        fileName = encodedFileName;
      }
    }
  }

  return asJson({
    ...(mediaReference ? { legacyReference: mediaReference } : {}),
    ...(correlationId ? { legacyCorrelationId: correlationId } : {}),
    ...(fileName ? { fileName } : {}),
    ...(isRetainedImportReference ? { retentionStatus: 'unavailable' } : {}),
  });
}

function issue(
  issues: ImportIssue[],
  table: ImportIssue['table'],
  code: string,
  message: string,
  rowNumber?: number,
  severity: ImportIssue['severity'] = 'error',
): void {
  issues.push({ severity, table, rowNumber, code, message });
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function assertUuid(name: string, value: string): void {
  if (!isUuid(value)) {
    throw new Error(`${name} deve ser um UUID válido.`);
  }
}

function addMaxLengthIssue(
  issues: ImportIssue[],
  table: ImportIssue['table'],
  rowNumber: number | undefined,
  field: string,
  value: string | undefined,
  maxLength: number,
): void {
  if (value && value.length > maxLength) {
    issue(
      issues,
      table,
      'FIELD_TOO_LONG',
      `${field} deve possuir no máximo ${maxLength} caracteres.`,
      rowNumber,
    );
  }
}

function isValidDate(value: Date | undefined): boolean {
  return value === undefined || !Number.isNaN(value.getTime());
}

function phoneIsValid(value: string): boolean {
  return /^\d{10,15}$/.test(value);
}

function quoteRequired(row: ConversationImportRow): boolean {
  return row.requestStatus !== 'not-started';
}

function selectedConversationSnapshot(
  row: {
    id: string;
    department: DepartmentCode;
    conversationState: ConversationState;
    flowStep: FlowStep;
    requestStatus: RequestStatus;
    resumeState: ConversationState | null;
    resumeFlowStep: FlowStep | null;
    assignedToUserId: string | null;
    unreadCount: number;
    version: number;
    mainMenuPresentedAt: Date | null;
    followUpMenuPresentedAt: Date | null;
    contextualFollowUpAt: Date | null;
    departmentContactOption: string | null;
    lastInboundAt: Date | null;
    lastOutboundAt: Date | null;
    lastMessagePreview: string | null;
    closedAt: Date | null;
  } | null,
): Record<string, unknown> | null {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    department: row.department,
    conversationState: row.conversationState,
    flowStep: row.flowStep,
    requestStatus: row.requestStatus,
    resumeState: row.resumeState,
    resumeFlowStep: row.resumeFlowStep,
    assignedToUserId: row.assignedToUserId,
    unreadCount: row.unreadCount,
    version: row.version,
    mainMenuPresentedAt: row.mainMenuPresentedAt?.toISOString() ?? null,
    followUpMenuPresentedAt: row.followUpMenuPresentedAt?.toISOString() ?? null,
    contextualFollowUpAt: row.contextualFollowUpAt?.toISOString() ?? null,
    departmentContactOption: row.departmentContactOption,
    lastInboundAt: row.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: row.lastOutboundAt?.toISOString() ?? null,
    lastMessagePreview: row.lastMessagePreview,
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}

function selectedContactSnapshot(
  row: { id: string; displayName: string | null } | null,
): Record<string, unknown> | null {
  return row ? { id: row.id, displayName: row.displayName } : null;
}

function selectedQuoteSnapshot(
  row: {
    id: string;
    sequence: number;
    status: RequestStatus;
    contactName: string | null;
    document: string | null;
    email: string | null;
    serviceType: string | null;
    origin: string | null;
    destination: string | null;
    departureDate: Date | null;
    departureAt: Date | null;
    returnDate: Date | null;
    returnAt: Date | null;
    passengerCount: number | null;
    vehicleType: string | null;
    vehicleAtDisposal: boolean | null;
    localTransfers: boolean | null;
    notes: string | null;
    structuredData: unknown;
    confirmedAt: Date | null;
    confirmedSummary: unknown;
    confirmedVersion: number | null;
    requestedByUserId: string | null;
    decisionReason: string | null;
    decidedAt: Date | null;
    decidedByUserId: string | null;
    version: number;
  } | null,
): Record<string, unknown> | null {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    sequence: row.sequence,
    status: row.status,
    contactName: row.contactName,
    document: row.document,
    email: row.email,
    serviceType: row.serviceType,
    origin: row.origin,
    destination: row.destination,
    departureDate: presentDateOnly(row.departureDate),
    departureAt: row.departureAt?.toISOString() ?? null,
    returnDate: presentDateOnly(row.returnDate),
    returnAt: row.returnAt?.toISOString() ?? null,
    passengerCount: row.passengerCount,
    vehicleType: row.vehicleType,
    vehicleAtDisposal: row.vehicleAtDisposal,
    localTransfers: row.localTransfers,
    notes: row.notes,
    structuredData: row.structuredData,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    confirmedSummary: row.confirmedSummary,
    confirmedVersion: row.confirmedVersion,
    requestedByUserId: row.requestedByUserId,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByUserId: row.decidedByUserId,
    version: row.version,
  };
}

function restoreDate(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}

function snapshotEquals(
  actual: Record<string, unknown> | null,
  expected: unknown,
): boolean {
  const canonicalize = (value: unknown): unknown => {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map(canonicalize);
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    }
    return value;
  };
  return (
    JSON.stringify(canonicalize(actual)) ===
    JSON.stringify(canonicalize(expected))
  );
}

function canonicalValue<T extends string>(
  mapping: Record<string, T>,
  value: T,
): string {
  return (
    Object.entries(mapping).find(([, mapped]) => mapped === value)?.[0] ?? value
  );
}

function sameDistribution(
  actual: Record<string, number>,
  expected: Record<string, number>,
): boolean {
  const normalize = (value: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(value)
        .filter(([, count]) => count !== 0)
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  return (
    JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected))
  );
}

export class WhatsAppImportService {
  private readonly applyConcurrency = Math.min(
    8,
    Math.max(
      1,
      Number.parseInt(
        process.env.WHATSAPP_IMPORT_APPLY_CONCURRENCY ?? '4',
        10,
      ) || 4,
    ),
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly importsRoot = resolve(
      process.cwd(),
      'var',
      'imports',
      'whatsapp',
    ),
  ) {}

  async validate(
    input: WhatsAppImportInput,
  ): Promise<WhatsAppImportValidationReport> {
    return (await this.prepare(input)).report;
  }

  private async prepare(input: WhatsAppImportInput): Promise<PreparedImport> {
    const counts = emptyImportCounts();
    const issues: ImportIssue[] = [];
    let inputEnvelopeValid = true;
    if (!isUuid(input.companyId)) {
      inputEnvelopeValid = false;
      issue(
        issues,
        'database',
        'INVALID_COMPANY_ID',
        'companyId deve ser um UUID válido.',
      );
    }
    if (!isUuid(input.channelId)) {
      inputEnvelopeValid = false;
      issue(
        issues,
        'database',
        'INVALID_CHANNEL_ID',
        'channelId deve ser um UUID válido.',
      );
    }
    if (
      input.batchName.trim() !== input.batchName ||
      input.batchName.length < 1 ||
      input.batchName.length > 120
    ) {
      inputEnvelopeValid = false;
      issue(
        issues,
        'package',
        'INVALID_BATCH_NAME',
        'batchName deve possuir de 1 a 120 caracteres, sem espaços nas extremidades.',
      );
    }
    if (
      input.actorUsername.trim() !== input.actorUsername ||
      input.actorUsername.length < 1 ||
      input.actorUsername.length > 40
    ) {
      inputEnvelopeValid = false;
      issue(
        issues,
        'database',
        'INVALID_ACTOR_USERNAME',
        'actorUsername deve possuir de 1 a 40 caracteres, sem espaços nas extremidades.',
      );
    }
    if (input.packagePath.length < 1 || input.packagePath.length > 1_000) {
      inputEnvelopeValid = false;
      issue(
        issues,
        'package',
        'INVALID_PACKAGE_PATH_LENGTH',
        'packagePath deve possuir de 1 a 1000 caracteres.',
      );
    }
    if (
      input.cutoffAt &&
      (!(input.cutoffAt instanceof Date) ||
        Number.isNaN(input.cutoffAt.getTime()))
    ) {
      inputEnvelopeValid = false;
      issue(
        issues,
        'package',
        'INVALID_CUTOFF_AT',
        'cutoffAt deve ser um instante válido.',
      );
    }
    let parsedPackage: ParsedWhatsAppImportPackage | undefined;
    try {
      parsedPackage = await parseWhatsAppImportPackage({
        importsRoot: this.importsRoot,
        packagePath: input.packagePath,
        workbookPath: input.workbookPath,
      });
    } catch (error) {
      if (error instanceof WhatsAppImportPackageError) {
        issues.push(...error.issues);
      } else {
        issue(
          issues,
          'package',
          'WORKBOOK_READ_FAILED',
          error instanceof Error
            ? error.message
            : 'Falha desconhecida ao ler a planilha.',
        );
      }
    }

    const reportBase = {
      schemaVersion: '1.0' as const,
      mode: 'validate' as const,
      zeroWrites: true as const,
      companyId: input.companyId,
      channelId: input.channelId,
      batchName: input.batchName,
      actorUsername: input.actorUsername,
      packagePath: input.packagePath,
      counts,
      generatedAt: new Date().toISOString(),
    };
    if (!parsedPackage) {
      const report: WhatsAppImportValidationReport = {
        ...reportBase,
        valid: false,
        issues,
      };
      return {
        package: {
          packagePath: input.packagePath,
          workbookPath: '',
          workbookSha256: '',
          packageSha256: '',
          conversations: [],
          messages: [],
          documents: [],
        },
        report,
      };
    }
    if (
      parsedPackage.packagePath.length > 1_000 ||
      parsedPackage.workbookPath.length > 1_000
    ) {
      inputEnvelopeValid = false;
      issue(
        issues,
        'package',
        'RESOLVED_PATH_TOO_LONG',
        'Os caminhos resolvidos do pacote e da planilha devem possuir no máximo 1000 caracteres.',
      );
    }
    if (!inputEnvelopeValid) {
      return {
        package: parsedPackage,
        report: {
          ...reportBase,
          valid: false,
          packagePath: parsedPackage.packagePath,
          workbookPath: parsedPackage.workbookPath,
          workbookSha256: parsedPackage.workbookSha256,
          packageSha256: parsedPackage.packageSha256,
          issues,
        },
      };
    }

    const company = await this.prisma.company.findUnique({
      where: { id: input.companyId },
      select: { id: true, status: true },
    });
    if (!company || company.status !== 'ACTIVE') {
      issue(
        issues,
        'database',
        'TENANT_NOT_ACTIVE',
        'O tenant informado não existe ou não está ativo.',
      );
    }
    const channel = await this.prisma.whatsAppChannel.findUnique({
      where: {
        id_companyId: {
          id: input.channelId,
          companyId: input.companyId,
        },
      },
      select: { id: true, phoneNumber: true, enabled: true },
    });
    if (!channel?.enabled) {
      issue(
        issues,
        'database',
        'CHANNEL_NOT_ACTIVE',
        'O canal informado não existe, não pertence ao tenant ou está desativado.',
      );
    }
    const actor = await this.prisma.user.findFirst({
      where: {
        companyId: input.companyId,
        usernameNormalized: normalizeUsername(input.actorUsername),
      },
      select: { id: true, status: true, isActive: true },
    });
    if (
      !actor ||
      !actor.isActive ||
      actor.status !== UserAccountStatus.ACTIVE
    ) {
      issue(
        issues,
        'database',
        'ACTOR_NOT_ACTIVE',
        'O ator da migração deve ser um usuário ativo do mesmo tenant.',
      );
    }

    const departments = new Set(
      (
        await this.prisma.tenantDepartment.findMany({
          where: { companyId: input.companyId },
          select: { code: true },
        })
      ).map((department) => department.code),
    );
    const ownerNames = Array.from(
      new Set(
        parsedPackage.conversations
          .map((row) => row.ownerUsername)
          .concat(parsedPackage.messages.map((row) => row.actorUsername))
          .filter((value): value is string => Boolean(value))
          .map(normalizeUsername),
      ),
    );
    const users = await collectChunked(
      ownerNames,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (usernameChunk) =>
        this.prisma.user.findMany({
          where: {
            companyId: input.companyId,
            usernameNormalized: { in: [...usernameChunk] },
          },
          select: {
            id: true,
            usernameNormalized: true,
            departments: true,
            status: true,
            isActive: true,
          },
        }),
    );
    const userByUsername = new Map(
      users.map((user) => [user.usernameNormalized, user]),
    );
    const phones = Array.from(
      new Set(parsedPackage.conversations.map((row) => row.phoneE164)),
    );
    const contacts = await collectChunked(
      phones,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (phoneChunk) =>
        this.prisma.whatsAppContact.findMany({
          where: {
            companyId: input.companyId,
            phoneNormalized: { in: [...phoneChunk] },
          },
          select: {
            id: true,
            phoneNormalized: true,
            displayName: true,
            updatedAt: true,
          },
        }),
    );
    const contactByPhone = new Map(
      contacts.map((contact) => [contact.phoneNormalized, contact]),
    );

    const sourceConversationPairs = parsedPackage.conversations.map((row) => ({
      sourceSystem: row.sourceSystem,
      externalId: row.externalConversationId,
    }));
    const conversationRefs = await collectChunked(
      sourceConversationPairs,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (pairChunk) =>
        this.prisma.whatsAppImportExternalRef.findMany({
          where: {
            companyId: input.companyId,
            entityType: 'conversation',
            OR: [...pairChunk],
          },
        }),
    );
    const conversationRefByKey = new Map(
      conversationRefs.map((reference) => [
        externalKey(reference.sourceSystem, reference.externalId),
        reference,
      ]),
    );
    const referencedConversationIds = conversationRefs.map(
      (reference) => reference.internalId,
    );
    const referencedConversations = await collectChunked(
      referencedConversationIds,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (idChunk) =>
        this.prisma.whatsAppConversation.findMany({
          where: {
            companyId: input.companyId,
            id: { in: [...idChunk] },
          },
          select: {
            id: true,
            channelId: true,
            contactId: true,
            closedAt: true,
            updatedAt: true,
            contact: { select: { phoneNormalized: true } },
          },
        }),
    );
    const referencedConversationById = new Map(
      referencedConversations.map((conversation) => [
        conversation.id,
        conversation,
      ]),
    );
    const canonicalConversations = await collectChunked(
      contacts.map((contact) => contact.id),
      IMPORT_LOOKUP_CHUNK_SIZE,
      (contactIdChunk) =>
        this.prisma.whatsAppConversation.findMany({
          where: {
            companyId: input.companyId,
            channelId: input.channelId,
            contactId: { in: [...contactIdChunk] },
          },
          select: { id: true, contactId: true, closedAt: true },
        }),
    );
    const canonicalByContactId = new Map(
      canonicalConversations.map((conversation) => [
        conversation.contactId,
        conversation,
      ]),
    );

    const workbookConversationIds = new Set<string>();
    const projectedNewContacts = new Set<string>();
    const projectedCanonicalPhones = new Set(
      contacts
        .filter((contact) => canonicalByContactId.has(contact.id))
        .map((contact) => contact.phoneNormalized),
    );
    for (const row of parsedPackage.conversations) {
      this.validateConversationRow(
        row,
        issues,
        channel?.phoneNumber,
        departments,
        userByUsername,
        input.cutoffAt,
      );
      if (workbookConversationIds.has(row.externalConversationId)) {
        issue(
          issues,
          'Atendimentos',
          'DUPLICATE_EXTERNAL_CONVERSATION_ID',
          'external_conversation_id está duplicado no lote.',
          row.rowNumber,
        );
      }
      workbookConversationIds.add(row.externalConversationId);
      if (row.migrationAction !== 'upsert') {
        continue;
      }
      counts.conversations += 1;
      incrementImportCount(counts.byDepartment, row.departmentCode);
      incrementImportCount(counts.byConversationState, row.conversationState);
      incrementImportCount(counts.byRequestStatus, row.requestStatus);
      const reference = conversationRefByKey.get(
        externalKey(row.sourceSystem, row.externalConversationId),
      );
      const contact = contactByPhone.get(row.phoneE164);
      const canonical = contact
        ? canonicalByContactId.get(contact.id)
        : undefined;
      if (contact) {
        if (
          reference &&
          row.contactName &&
          row.contactName !== contact.displayName
        ) {
          counts.contactsToUpdate += 1;
        }
      } else if (!projectedNewContacts.has(row.phoneE164)) {
        projectedNewContacts.add(row.phoneE164);
        counts.contactsToCreate += 1;
      }
      if (reference) {
        const referenced = referencedConversationById.get(reference.internalId);
        if (!referenced) {
          issue(
            issues,
            'database',
            'ORPHAN_CONVERSATION_REFERENCE',
            'A referência externa aponta para uma conversa inexistente.',
            row.rowNumber,
          );
        } else {
          counts.conversationsToUpdate += 1;
          projectedCanonicalPhones.add(row.phoneE164);
          if (referenced.contact.phoneNormalized !== row.phoneE164) {
            issue(
              issues,
              'database',
              'CONVERSATION_CONTACT_MISMATCH',
              'A referência externa já pertence a outro telefone.',
              row.rowNumber,
            );
          }
          if (referenced.channelId !== input.channelId) {
            issue(
              issues,
              'database',
              'CONVERSATION_CHANNEL_MISMATCH',
              'A referência externa já pertence a outro canal.',
              row.rowNumber,
            );
          }
          if (canonical && canonical.id !== referenced.id) {
            issue(
              issues,
              'database',
              'SECOND_OPEN_CONVERSATION',
              'A referência externa aponta para outra conversa e não pode criar uma segunda conversa para o contato no canal.',
              row.rowNumber,
            );
          }
          try {
            await this.assertNoDriftSinceLastImport(
              this.prisma,
              input,
              row,
              reference,
              contact ?? null,
            );
          } catch (error) {
            issue(
              issues,
              'database',
              'DRIFT_SINCE_LAST_IMPORT',
              error instanceof Error
                ? error.message
                : 'A conversa diverge da última importação.',
              row.rowNumber,
            );
          }
        }
      } else {
        if (canonical || projectedCanonicalPhones.has(row.phoneE164)) {
          counts.conversationsToUpdate += 1;
        } else {
          counts.conversationsToCreate += 1;
          projectedCanonicalPhones.add(row.phoneE164);
        }
      }
    }

    const messageExternalKeys = new Set<string>();
    const documentExternalKeys = new Set<string>();
    const conversationByExternalId = new Map(
      parsedPackage.conversations.map((row) => [
        row.externalConversationId,
        row,
      ]),
    );
    const messageRefPairs = parsedPackage.messages.flatMap((message) => {
      const conversation = conversationByExternalId.get(
        message.externalConversationId,
      );
      return conversation
        ? [
            {
              sourceSystem: conversation.sourceSystem,
              externalId: message.externalMessageId,
            },
          ]
        : [];
    });
    const messageRefs = await collectChunked(
      messageRefPairs,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (pairChunk) =>
        this.prisma.whatsAppImportExternalRef.findMany({
          where: {
            companyId: input.companyId,
            entityType: 'message',
            OR: [...pairChunk],
          },
        }),
    );
    const messageRefByKey = new Map(
      messageRefs.map((reference) => [
        externalKey(reference.sourceSystem, reference.externalId),
        reference,
      ]),
    );
    const referencedMessages = await collectChunked(
      messageRefs.map((reference) => reference.internalId),
      IMPORT_LOOKUP_CHUNK_SIZE,
      (idChunk) =>
        this.prisma.whatsAppMessage.findMany({
          where: {
            companyId: input.companyId,
            id: { in: [...idChunk] },
          },
          select: { id: true, conversationId: true },
        }),
    );
    const referencedMessageById = new Map(
      referencedMessages.map((message) => [message.id, message]),
    );
    const providerMessageIds = Array.from(
      new Set(
        parsedPackage.messages
          .map((message) => message.providerMessageId)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const existingProviderMessages = await collectChunked(
      providerMessageIds,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (providerIdChunk) =>
        this.prisma.whatsAppMessage.findMany({
          where: {
            companyId: input.companyId,
            channelId: input.channelId,
            providerMessageId: { in: [...providerIdChunk] },
          },
          select: { id: true, providerMessageId: true },
        }),
    );
    const messageByProviderId = new Map(
      existingProviderMessages.map((message) => [
        message.providerMessageId!,
        message.id,
      ]),
    );
    const deterministicCorrelations = parsedPackage.messages.flatMap(
      (message) => {
        const conversation = conversationByExternalId.get(
          message.externalConversationId,
        );
        return conversation
          ? [
              deterministicCorrelation(
                conversation.sourceSystem,
                message.externalMessageId,
              ),
            ]
          : [];
      },
    );
    const existingCorrelatedMessages = await collectChunked(
      deterministicCorrelations,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (correlationChunk) =>
        this.prisma.whatsAppMessage.findMany({
          where: {
            companyId: input.companyId,
            correlationId: { in: [...correlationChunk] },
          },
          select: { id: true, correlationId: true },
        }),
    );
    const messageByCorrelation = new Map(
      existingCorrelatedMessages.map((message) => [
        message.correlationId,
        message.id,
      ]),
    );
    const workbookProviderMessageIds = new Set<string>();
    for (const row of parsedPackage.messages) {
      const conversation = conversationByExternalId.get(
        row.externalConversationId,
      );
      this.validateMessageRow(
        row,
        conversation,
        issues,
        userByUsername,
        input.cutoffAt,
      );
      if (!conversation) {
        continue;
      }
      const key = externalKey(conversation.sourceSystem, row.externalMessageId);
      if (messageExternalKeys.has(key)) {
        issue(
          issues,
          'Mensagens',
          'DUPLICATE_EXTERNAL_MESSAGE_ID',
          'A mesma mensagem aparece mais de uma vez neste lote.',
          row.rowNumber,
        );
      }
      messageExternalKeys.add(key);
      const reference = messageRefByKey.get(key);
      if (row.providerMessageId) {
        if (workbookProviderMessageIds.has(row.providerMessageId)) {
          issue(
            issues,
            'Mensagens',
            'DUPLICATE_PROVIDER_MESSAGE_ID',
            'provider_message_id está duplicado no lote.',
            row.rowNumber,
          );
        }
        workbookProviderMessageIds.add(row.providerMessageId);
        const providerConflict = messageByProviderId.get(row.providerMessageId);
        if (
          providerConflict &&
          (!reference || reference.internalId !== providerConflict)
        ) {
          issue(
            issues,
            'Mensagens',
            'PROVIDER_MESSAGE_ID_CONFLICT',
            'provider_message_id já pertence a outra mensagem.',
            row.rowNumber,
          );
        }
      }
      const correlationConflict = messageByCorrelation.get(
        deterministicCorrelation(
          conversation.sourceSystem,
          row.externalMessageId,
        ),
      );
      if (
        correlationConflict &&
        (!reference || reference.internalId !== correlationConflict)
      ) {
        issue(
          issues,
          'Mensagens',
          'CORRELATION_ID_CONFLICT',
          'A correlação determinística já pertence a outra mensagem.',
          row.rowNumber,
        );
      }
      const canHashMessage = isValidDate(row.occurredAt);
      const expectedHash = canHashMessage
        ? this.messagePayloadHash(row)
        : undefined;
      if (reference) {
        counts.messagesDuplicate += 1;
        const persistedMessage = referencedMessageById.get(
          reference.internalId,
        );
        const expectedConversationReference = conversationRefByKey.get(
          externalKey(
            conversation.sourceSystem,
            conversation.externalConversationId,
          ),
        );
        if (!persistedMessage) {
          issue(
            issues,
            'Mensagens',
            'ORPHAN_MESSAGE_REFERENCE',
            'A referência externa aponta para uma mensagem inexistente.',
            row.rowNumber,
          );
        } else if (
          !expectedConversationReference ||
          persistedMessage.conversationId !==
            expectedConversationReference.internalId
        ) {
          issue(
            issues,
            'Mensagens',
            'MESSAGE_REFERENCE_CONVERSATION_MISMATCH',
            'A mensagem já importada pertence a outra conversa.',
            row.rowNumber,
          );
        }
        if (expectedHash && reference.payloadHash !== expectedHash) {
          issue(
            issues,
            'Mensagens',
            'MESSAGE_REFERENCE_PAYLOAD_MISMATCH',
            'A mensagem já foi importada com conteúdo diferente.',
            row.rowNumber,
          );
        }
      } else {
        counts.messagesToCreate += 1;
      }
    }

    const documentRefPairs = parsedPackage.documents.flatMap((document) => {
      const conversation = conversationByExternalId.get(
        document.externalConversationId,
      );
      return conversation
        ? [
            {
              sourceSystem: conversation.sourceSystem,
              externalId: document.externalDocumentId,
            },
          ]
        : [];
    });
    const documentRefs = await collectChunked(
      documentRefPairs,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (pairChunk) =>
        this.prisma.whatsAppImportExternalRef.findMany({
          where: {
            companyId: input.companyId,
            entityType: 'document',
            OR: [...pairChunk],
          },
        }),
    );
    const documentRefByKey = new Map(
      documentRefs.map((reference) => [
        externalKey(reference.sourceSystem, reference.externalId),
        reference,
      ]),
    );
    const referencedDocuments = await collectChunked(
      documentRefs.map((reference) => reference.internalId),
      IMPORT_LOOKUP_CHUNK_SIZE,
      (idChunk) =>
        this.prisma.quoteProposalDocument.findMany({
          where: {
            companyId: input.companyId,
            id: { in: [...idChunk] },
          },
          select: {
            id: true,
            conversationId: true,
            quoteRequest: { select: { sequence: true } },
          },
        }),
    );
    const referencedDocumentById = new Map(
      referencedDocuments.map((document) => [document.id, document]),
    );
    const documentProviderIds = Array.from(
      new Set(
        parsedPackage.documents
          .map((document) => document.providerMessageId)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const existingProviderDocuments = await collectChunked(
      documentProviderIds,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (providerIdChunk) =>
        this.prisma.quoteProposalDocument.findMany({
          where: {
            companyId: input.companyId,
            providerMessageId: { in: [...providerIdChunk] },
          },
          select: { id: true, providerMessageId: true },
        }),
    );
    const documentByProviderId = new Map(
      existingProviderDocuments.map((document) => [
        document.providerMessageId!,
        document.id,
      ]),
    );
    const workbookDocumentProviderIds = new Set<string>();
    const documentCountByConversation = new Map<string, number>();
    for (const row of parsedPackage.documents) {
      const documentCount =
        (documentCountByConversation.get(row.externalConversationId) ?? 0) + 1;
      documentCountByConversation.set(
        row.externalConversationId,
        documentCount,
      );
      if (documentCount === 21) {
        issue(
          issues,
          'Documentos',
          'DOCUMENTS_PER_CONVERSATION_LIMIT_EXCEEDED',
          'Cada conversa pode importar no máximo 20 PDFs por lote.',
          row.rowNumber,
        );
      }
      const conversation = conversationByExternalId.get(
        row.externalConversationId,
      );
      this.validateDocumentRow(row, conversation, issues, input.cutoffAt);
      if (!conversation) {
        continue;
      }
      const key = externalKey(
        conversation.sourceSystem,
        row.externalDocumentId,
      );
      if (documentExternalKeys.has(key)) {
        issue(
          issues,
          'Documentos',
          'DUPLICATE_EXTERNAL_DOCUMENT_ID',
          'external_document_id está duplicado no lote.',
          row.rowNumber,
        );
      }
      documentExternalKeys.add(key);
      const reference = documentRefByKey.get(key);
      if (row.providerMessageId) {
        if (workbookDocumentProviderIds.has(row.providerMessageId)) {
          issue(
            issues,
            'Documentos',
            'DUPLICATE_PROVIDER_MESSAGE_ID',
            'provider_message_id está duplicado entre documentos do lote.',
            row.rowNumber,
          );
        }
        workbookDocumentProviderIds.add(row.providerMessageId);
        const providerConflict = documentByProviderId.get(
          row.providerMessageId,
        );
        if (
          providerConflict &&
          (!reference || reference.internalId !== providerConflict)
        ) {
          issue(
            issues,
            'Documentos',
            'PROVIDER_MESSAGE_ID_CONFLICT',
            'provider_message_id já pertence a outro documento.',
            row.rowNumber,
          );
        }
      }
      const canHashDocument = isValidDate(row.sentAt);
      const expectedHash = canHashDocument
        ? this.documentPayloadHash(row)
        : undefined;
      if (reference) {
        counts.documentsDuplicate += 1;
        const persistedDocument = referencedDocumentById.get(
          reference.internalId,
        );
        const expectedConversationReference = conversationRefByKey.get(
          externalKey(
            conversation.sourceSystem,
            conversation.externalConversationId,
          ),
        );
        if (!persistedDocument) {
          issue(
            issues,
            'Documentos',
            'ORPHAN_DOCUMENT_REFERENCE',
            'A referência externa aponta para um documento inexistente.',
            row.rowNumber,
          );
        } else if (
          !expectedConversationReference ||
          persistedDocument.conversationId !==
            expectedConversationReference.internalId ||
          persistedDocument.quoteRequest.sequence !== row.quoteSequence
        ) {
          issue(
            issues,
            'Documentos',
            'DOCUMENT_REFERENCE_CONVERSATION_MISMATCH',
            'O documento já importado pertence a outra conversa ou sequência de orçamento.',
            row.rowNumber,
          );
        }
        if (expectedHash && reference.payloadHash !== expectedHash) {
          issue(
            issues,
            'Documentos',
            'DOCUMENT_REFERENCE_PAYLOAD_MISMATCH',
            'O documento já foi importado com metadados diferentes.',
            row.rowNumber,
          );
        }
      } else {
        counts.documentsToCreate += 1;
      }
    }

    const existingQuoteConversationIds = referencedConversations.map(
      (conversation) => conversation.id,
    );
    const existingQuotes =
      existingQuoteConversationIds.length === 0
        ? []
        : await this.prisma.quoteRequest.findMany({
            where: {
              companyId: input.companyId,
              conversationId: { in: existingQuoteConversationIds },
            },
            select: {
              conversationId: true,
              sequence: true,
              updatedAt: true,
            },
          });
    const existingQuoteByKey = new Map(
      existingQuotes.map(
        (quote) =>
          [`${quote.conversationId}\0${quote.sequence}`, quote] as const,
      ),
    );
    for (const row of parsedPackage.conversations) {
      if (!row.quoteSequence || row.migrationAction !== 'upsert') {
        continue;
      }
      const reference = conversationRefByKey.get(
        externalKey(row.sourceSystem, row.externalConversationId),
      );
      const existingQuote = reference
        ? existingQuoteByKey.get(
            `${reference.internalId}\0${row.quoteSequence}`,
          )
        : undefined;
      if (existingQuote) {
        counts.quoteRequestsToUpdate += 1;
      } else {
        counts.quoteRequestsToCreate += 1;
      }
    }

    return {
      package: parsedPackage,
      report: {
        ...reportBase,
        valid: !issues.some((entry) => entry.severity === 'error'),
        packagePath: parsedPackage.packagePath,
        workbookPath: parsedPackage.workbookPath,
        workbookSha256: parsedPackage.workbookSha256,
        packageSha256: parsedPackage.packageSha256,
        counts,
        issues,
      },
    };
  }

  private validateConversationRow(
    row: ConversationImportRow,
    issues: ImportIssue[],
    channelPhone: string | undefined,
    departments: Set<DepartmentCode>,
    users: Map<
      string,
      {
        id: string;
        departments: string[];
        status: UserAccountStatus;
        isActive: boolean;
      }
    >,
    cutoffAt: Date | undefined,
  ): void {
    const required: Array<[string, string]> = [
      ['external_conversation_id', row.externalConversationId],
      ['source_system', row.sourceSystem],
      ['phone_e164', row.phoneE164],
      ['channel_phone_e164', row.channelPhoneE164],
      ['department_code', row.departmentCode],
      ['conversation_state', row.conversationState],
      ['flow_step', row.flowStep],
      ['request_status', row.requestStatus],
      ['migration_action', row.migrationAction],
    ];
    for (const [field, value] of required) {
      if (!value) {
        issue(
          issues,
          'Atendimentos',
          'REQUIRED_FIELD',
          `${field} é obrigatório.`,
          row.rowNumber,
        );
      }
    }
    for (const [field, value, maxLength] of [
      ['external_conversation_id', row.externalConversationId, 160],
      ['source_system', row.sourceSystem, 80],
      ['phone_e164', row.phoneE164, 16],
      ['contact_name', row.contactName, 160],
      ['channel_phone_e164', row.channelPhoneE164, 16],
      ['owner_username', row.ownerUsername, 40],
      ['last_message_preview', row.lastMessagePreview, 240],
      ['quote_contact_name', row.quoteContactName, 160],
      ['quote_document', row.quoteDocument, 20],
      ['quote_email', row.quoteEmail, 254],
      ['service_type', row.serviceType, 120],
      ['origin', row.origin, 300],
      ['destination', row.destination, 300],
      ['vehicle_type', row.vehicleType, 120],
      ['decision_reason', row.decisionReason, 500],
    ] as const) {
      addMaxLengthIssue(
        issues,
        'Atendimentos',
        row.rowNumber,
        field,
        value,
        maxLength,
      );
    }
    if (!phoneIsValid(row.phoneE164)) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_PHONE',
        'phone_e164 deve conter de 10 a 15 dígitos.',
        row.rowNumber,
      );
    }
    if (
      !phoneIsValid(row.channelPhoneE164) ||
      (channelPhone && row.channelPhoneE164 !== channelPhone)
    ) {
      issue(
        issues,
        'Atendimentos',
        'CHANNEL_PHONE_MISMATCH',
        'channel_phone_e164 não corresponde ao canal informado.',
        row.rowNumber,
      );
    }
    if (
      !IMPORT_DEPARTMENT_CODES.includes(
        row.departmentCode as (typeof IMPORT_DEPARTMENT_CODES)[number],
      ) ||
      !departments.has(DEPARTMENT_TO_PRISMA[row.departmentCode])
    ) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_DEPARTMENT',
        'department_code não é um dos nove departamentos publicados no tenant.',
        row.rowNumber,
      );
    }
    if (!STATE_TO_PRISMA[row.conversationState]) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_CONVERSATION_STATE',
        'conversation_state é inválido.',
        row.rowNumber,
      );
    }
    if (!FLOW_TO_PRISMA[row.flowStep]) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_FLOW_STEP',
        'flow_step é inválido.',
        row.rowNumber,
      );
    }
    if (!REQUEST_TO_PRISMA[row.requestStatus]) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_REQUEST_STATUS',
        'request_status é inválido.',
        row.rowNumber,
      );
    }
    if (
      !VALID_STATE_COMBINATIONS.has(
        `${row.conversationState}|${row.flowStep}|${row.requestStatus}`,
      )
    ) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_STATE_COMBINATION',
        'A combinação de estado, etapa e status comercial não é canônica.',
        row.rowNumber,
      );
    }
    if (!isValidDate(row.lastInteractionAt)) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_LAST_INTERACTION_DATE',
        'last_interaction_at deve ser uma célula de data/hora do Excel.',
        row.rowNumber,
      );
    }
    for (const [field, date] of [
      ['departure_at', row.departureAt],
      ['return_at', row.returnAt],
      ['confirmed_at', row.confirmedAt],
      ['decided_at', row.decidedAt],
    ] as const) {
      if (!isValidDate(date)) {
        issue(
          issues,
          'Atendimentos',
          'INVALID_EXCEL_DATE',
          `${field} deve ser uma célula de data/hora do Excel.`,
          row.rowNumber,
        );
      }
    }
    // O corte representa o fim da extração do sistema anterior, não o fim da
    // agenda operacional. Uma conversa histórica pode conter uma viagem
    // legitimamente marcada para depois da migração.
    for (const [field, date] of [
      ['confirmed_at', row.confirmedAt],
      ['decided_at', row.decidedAt],
    ] as const) {
      if (date && cutoffAt && date > cutoffAt) {
        issue(
          issues,
          'Atendimentos',
          'DATE_AFTER_CUTOFF',
          `${field} é posterior ao horário de corte.`,
          row.rowNumber,
        );
      }
    }
    if (cutoffAt && row.lastInteractionAt > cutoffAt) {
      issue(
        issues,
        'Atendimentos',
        'DATE_AFTER_CUTOFF',
        'last_interaction_at é posterior ao horário de corte.',
        row.rowNumber,
      );
    }
    if (
      !Number.isInteger(row.unreadCount) ||
      row.unreadCount < 0 ||
      row.unreadCount > 1_000_000
    ) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_UNREAD_COUNT',
        'unread_count deve ser um inteiro não negativo.',
        row.rowNumber,
      );
    }
    if (row.ownerUsername) {
      const owner = users.get(normalizeUsername(row.ownerUsername));
      if (
        !owner ||
        !owner.isActive ||
        owner.status !== UserAccountStatus.ACTIVE
      ) {
        issue(
          issues,
          'Atendimentos',
          'OWNER_NOT_ACTIVE',
          'owner_username não corresponde a um usuário ativo do tenant.',
          row.rowNumber,
        );
      } else if (!owner.departments.includes(row.departmentCode)) {
        issue(
          issues,
          'Atendimentos',
          'OWNER_OUTSIDE_DEPARTMENT',
          'O responsável não está vinculado ao departamento da conversa.',
          row.rowNumber,
        );
      }
    }
    if (row.conversationState === 'human-active' && !row.ownerUsername) {
      issue(
        issues,
        'Atendimentos',
        'HUMAN_ACTIVE_REQUIRES_OWNER',
        'human-active exige owner_username.',
        row.rowNumber,
      );
    }
    if (
      row.ownerUsername &&
      !['human-active', 'sent-to-human'].includes(row.conversationState)
    ) {
      issue(
        issues,
        'Atendimentos',
        'OWNER_NOT_ALLOWED_FOR_BOT_STATE',
        'Estados conduzidos pelo bot ou encerrados não podem ter responsável.',
        row.rowNumber,
      );
    }
    if (!['upsert', 'review-only'].includes(row.migrationAction)) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_MIGRATION_ACTION',
        'migration_action deve ser upsert ou review-only.',
        row.rowNumber,
      );
    } else if (row.migrationAction === 'review-only') {
      issue(
        issues,
        'Atendimentos',
        'REVIEW_ONLY_SKIPPED',
        'A linha será apenas revisada e não será aplicada.',
        row.rowNumber,
        'warning',
      );
    }
    if (quoteRequired(row) && (!row.quoteSequence || row.quoteSequence < 1)) {
      issue(
        issues,
        'Atendimentos',
        'QUOTE_SEQUENCE_REQUIRED',
        'quote_sequence é obrigatório para status comerciais iniciados.',
        row.rowNumber,
      );
    }
    if (
      row.quoteSequence !== undefined &&
      (!Number.isInteger(row.quoteSequence) || row.quoteSequence < 1)
    ) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_QUOTE_SEQUENCE',
        'quote_sequence deve ser um inteiro positivo.',
        row.rowNumber,
      );
    }
    if (
      row.tripType &&
      !['one-way', 'round-trip', 'unknown'].includes(row.tripType)
    ) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_TRIP_TYPE',
        'trip_type deve ser one-way, round-trip ou unknown.',
        row.rowNumber,
      );
    }
    if (
      row.passengerCount !== undefined &&
      (!Number.isInteger(row.passengerCount) || row.passengerCount < 1)
    ) {
      issue(
        issues,
        'Atendimentos',
        'INVALID_PASSENGER_COUNT',
        'passenger_count deve ser um inteiro positivo.',
        row.rowNumber,
      );
    }
    if (
      ['rejected', 'cancelled'].includes(row.requestStatus) &&
      !row.decisionReason
    ) {
      issue(
        issues,
        'Atendimentos',
        'DECISION_REASON_REQUIRED',
        'Propostas rejeitadas ou canceladas exigem decision_reason.',
        row.rowNumber,
      );
    }
  }

  private validateMessageRow(
    row: MessageImportRow,
    conversation: ConversationImportRow | undefined,
    issues: ImportIssue[],
    users: Map<
      string,
      {
        id: string;
        departments: string[];
        status: UserAccountStatus;
        isActive: boolean;
      }
    >,
    cutoffAt: Date | undefined,
  ): void {
    for (const [field, value, maxLength] of [
      ['external_conversation_id', row.externalConversationId, 160],
      ['external_message_id', row.externalMessageId, 160],
      ['actor_username', row.actorUsername, 40],
      ['provider_message_id', row.providerMessageId, 160],
    ] as const) {
      addMaxLengthIssue(
        issues,
        'Mensagens',
        row.rowNumber,
        field,
        value,
        maxLength,
      );
    }
    if (!conversation) {
      issue(
        issues,
        'Mensagens',
        'CONVERSATION_NOT_IN_BATCH',
        'A mensagem referencia um atendimento inexistente no lote.',
        row.rowNumber,
      );
    }
    if (!row.externalMessageId) {
      issue(
        issues,
        'Mensagens',
        'EXTERNAL_MESSAGE_ID_REQUIRED',
        'external_message_id é obrigatório.',
        row.rowNumber,
      );
    }
    if (!DIRECTION_TO_PRISMA[row.direction]) {
      issue(
        issues,
        'Mensagens',
        'INVALID_DIRECTION',
        'direction é inválido.',
        row.rowNumber,
      );
    }
    if (!KIND_TO_PRISMA[row.kind]) {
      issue(
        issues,
        'Mensagens',
        'INVALID_MESSAGE_KIND',
        'kind é inválido.',
        row.rowNumber,
      );
    }
    if (!DELIVERY_TO_PRISMA[row.deliveryStatus]) {
      issue(
        issues,
        'Mensagens',
        'INVALID_DELIVERY_STATUS',
        'delivery_status é inválido.',
        row.rowNumber,
      );
    }
    if (row.direction === 'inbound' && row.deliveryStatus !== 'received') {
      issue(
        issues,
        'Mensagens',
        'INVALID_INBOUND_DELIVERY_STATUS',
        'Mensagens inbound devem possuir delivery_status=received.',
        row.rowNumber,
      );
    }
    if (
      row.direction === 'outbound' &&
      !['sent', 'delivered', 'read', 'failed'].includes(row.deliveryStatus)
    ) {
      issue(
        issues,
        'Mensagens',
        'UNREACHABLE_OUTBOUND_STATUS',
        'Mensagens outbound históricas devem estar em sent, delivered, read ou failed; pending não é importável sem outbox/attempt.',
        row.rowNumber,
      );
    }
    if (!isValidDate(row.occurredAt)) {
      issue(
        issues,
        'Mensagens',
        'INVALID_OCCURRED_AT',
        'occurred_at deve ser uma célula de data/hora do Excel.',
        row.rowNumber,
      );
    } else if (cutoffAt && row.occurredAt > cutoffAt) {
      issue(
        issues,
        'Mensagens',
        'DATE_AFTER_CUTOFF',
        'occurred_at é posterior ao horário de corte.',
        row.rowNumber,
      );
    }
    if (row.kind === 'text' && !row.text) {
      issue(
        issues,
        'Mensagens',
        'TEXT_REQUIRED',
        'Mensagens de texto exigem o campo text.',
        row.rowNumber,
      );
    }
    if (row.actorUsername) {
      const actor = users.get(normalizeUsername(row.actorUsername));
      if (
        !actor ||
        !actor.isActive ||
        actor.status !== UserAccountStatus.ACTIVE
      ) {
        issue(
          issues,
          'Mensagens',
          'MESSAGE_ACTOR_NOT_ACTIVE',
          'actor_username não corresponde a um usuário ativo do tenant.',
          row.rowNumber,
        );
      }
    }
  }

  private validateDocumentRow(
    row: DocumentImportRow,
    conversation: ConversationImportRow | undefined,
    issues: ImportIssue[],
    cutoffAt: Date | undefined,
  ): void {
    for (const [field, value, maxLength] of [
      ['external_conversation_id', row.externalConversationId, 160],
      ['external_document_id', row.externalDocumentId, 160],
      ['file_name', row.fileName, 255],
      ['relative_file_path', row.relativeFilePath, 1_000],
      ['mime_type', row.mimeType, 80],
      ['provider_message_id', row.providerMessageId, 160],
    ] as const) {
      addMaxLengthIssue(
        issues,
        'Documentos',
        row.rowNumber,
        field,
        value,
        maxLength,
      );
    }
    if (!conversation) {
      issue(
        issues,
        'Documentos',
        'CONVERSATION_NOT_IN_BATCH',
        'O documento referencia um atendimento inexistente no lote.',
        row.rowNumber,
      );
    }
    if (!row.externalDocumentId) {
      issue(
        issues,
        'Documentos',
        'EXTERNAL_DOCUMENT_ID_REQUIRED',
        'external_document_id é obrigatório.',
        row.rowNumber,
      );
    }
    if (!Number.isInteger(row.quoteSequence) || row.quoteSequence < 1) {
      issue(
        issues,
        'Documentos',
        'INVALID_QUOTE_SEQUENCE',
        'quote_sequence deve ser um inteiro positivo.',
        row.rowNumber,
      );
    }
    if (row.mimeType !== 'application/pdf') {
      issue(
        issues,
        'Documentos',
        'INVALID_DOCUMENT_MIME',
        'O único MIME aceito é application/pdf.',
        row.rowNumber,
      );
    }
    if (!row.fileName.toLowerCase().endsWith('.pdf')) {
      issue(
        issues,
        'Documentos',
        'INVALID_DOCUMENT_EXTENSION',
        'file_name deve possuir extensão .pdf.',
        row.rowNumber,
      );
    }
    if (!DOCUMENT_STATUS_TO_PRISMA[row.documentStatus]) {
      issue(
        issues,
        'Documentos',
        'INVALID_DOCUMENT_STATUS',
        'document_status é inválido.',
        row.rowNumber,
      );
    }
    if (row.documentStatus === 'sent' && !row.sentAt) {
      issue(
        issues,
        'Documentos',
        'SENT_AT_REQUIRED',
        'document_status=sent exige sent_at.',
        row.rowNumber,
      );
    }
    if (!isValidDate(row.sentAt)) {
      issue(
        issues,
        'Documentos',
        'INVALID_SENT_AT',
        'sent_at deve ser uma célula de data/hora do Excel.',
        row.rowNumber,
      );
    } else if (row.sentAt && cutoffAt && row.sentAt > cutoffAt) {
      issue(
        issues,
        'Documentos',
        'DATE_AFTER_CUTOFF',
        'sent_at é posterior ao horário de corte.',
        row.rowNumber,
      );
    }
    if (row.expectedSha256 && !/^[a-f0-9]{64}$/.test(row.expectedSha256)) {
      issue(
        issues,
        'Documentos',
        'INVALID_SHA256',
        'sha256 deve possuir 64 caracteres hexadecimais.',
        row.rowNumber,
      );
    } else if (
      row.expectedSha256 &&
      row.sha256 &&
      row.expectedSha256 !== row.sha256
    ) {
      issue(
        issues,
        'Documentos',
        'SHA256_MISMATCH',
        'O hash calculado do PDF não corresponde ao informado.',
        row.rowNumber,
      );
    }
    if (
      conversation?.quoteSequence &&
      conversation.quoteSequence !== row.quoteSequence
    ) {
      issue(
        issues,
        'Documentos',
        'QUOTE_SEQUENCE_NOT_DECLARED',
        'O quote_sequence do documento não corresponde ao atendimento.',
        row.rowNumber,
      );
    }
  }

  private messagePayloadHash(row: MessageImportRow): string {
    return importPayloadHash({
      externalConversationId: row.externalConversationId,
      externalMessageId: row.externalMessageId,
      direction: row.direction,
      kind: row.kind,
      occurredAt: row.occurredAt.toISOString(),
      deliveryStatus: row.deliveryStatus,
      text: row.text ?? null,
      mediaReference: row.mediaReference ?? null,
      actorUsername: row.actorUsername ?? null,
      providerMessageId: row.providerMessageId ?? null,
      correlationId: row.correlationId ?? null,
    });
  }

  private documentPayloadHash(row: DocumentImportRow): string {
    return importPayloadHash({
      externalConversationId: row.externalConversationId,
      quoteSequence: row.quoteSequence,
      externalDocumentId: row.externalDocumentId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      documentStatus: row.documentStatus,
      sentAt: row.sentAt?.toISOString() ?? null,
      providerMessageId: row.providerMessageId ?? null,
      sha256: row.sha256,
    });
  }

  async apply(input: WhatsAppImportApplyInput): Promise<{
    schemaVersion: '1.0';
    mode: 'apply';
    batchId: string;
    status: string;
    idempotentReplay: boolean;
    counts: WhatsAppImportCounts;
    outboxCreatedByImporter: 0;
  }> {
    assertUuid('companyId', input.companyId);
    assertUuid('channelId', input.channelId);
    assertUuid('batchId', input.batchId);
    if (input.confirmation !== `APPLY:${input.batchId}`) {
      throw new Error(
        `Confirmação inválida. Use --confirm=APPLY:${input.batchId}.`,
      );
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.batchId,
      )
    ) {
      throw new Error('batchId deve ser um UUID válido.');
    }
    const prepared = await this.prepare(input);
    if (!prepared.report.valid) {
      const details = prepared.report.issues
        .filter((issue) => issue.severity === 'error')
        .slice(0, 3)
        .map((issue) => issue.message.trim())
        .filter(Boolean)
        .join(' ');
      const error = new Error(
        details ||
          'A validação encontrou dados inválidos; importação bloqueada.',
      );
      Object.assign(error, { report: prepared.report });
      throw error;
    }
    const upserts = prepared.package.conversations.filter(
      (row) => row.migrationAction === 'upsert',
    );
    if (upserts.length === 0) {
      throw new Error('O apply exige ao menos uma linha upsert.');
    }
    const actor = await this.prisma.user.findFirstOrThrow({
      where: {
        companyId: input.companyId,
        usernameNormalized: normalizeUsername(input.actorUsername),
        isActive: true,
        status: UserAccountStatus.ACTIVE,
      },
      select: { id: true },
    });
    const existingBatch = await this.prisma.whatsAppImportBatch.findUnique({
      where: { id: input.batchId },
    });
    if (existingBatch) {
      if (
        existingBatch.companyId !== input.companyId ||
        existingBatch.channelId !== input.channelId ||
        existingBatch.name !== input.batchName ||
        existingBatch.workbookSha256 !== prepared.package.workbookSha256 ||
        existingBatch.packageSha256 !== prepared.package.packageSha256 ||
        existingBatch.cutoffAt.getTime() !== input.cutoffAt.getTime()
      ) {
        throw new Error(
          'Esta tentativa foi retomada com conteúdo diferente do processamento anterior. Reinicie a importação para preservar a integridade dos dados.',
        );
      }
      if (existingBatch.status === WhatsAppImportBatchStatus.ROLLED_BACK) {
        throw new Error('Um lote revertido não pode ser reutilizado.');
      }
      if (
        existingBatch.status === WhatsAppImportBatchStatus.APPLIED &&
        existingBatch.claimId
      ) {
        throw new Error(
          'O lote possui rollback reivindicado; reconcilie ou retome o rollback antes de executar apply.',
        );
      }
      if (
        existingBatch.status === WhatsAppImportBatchStatus.APPLYING &&
        existingBatch.leaseUntil &&
        existingBatch.leaseUntil > new Date()
      ) {
        throw new Error(
          'O lote já está em aplicação; execução concorrente bloqueada.',
        );
      }
      if (existingBatch.status === WhatsAppImportBatchStatus.APPLIED) {
        return {
          schemaVersion: '1.0',
          mode: 'apply',
          batchId: input.batchId,
          status: 'applied',
          idempotentReplay: true,
          counts:
            existingBatch.appliedCounts as unknown as WhatsAppImportCounts,
          outboxCreatedByImporter: 0,
        };
      }
    }
    const claimId = randomUUID();
    const claimStartedAt = new Date();
    const leaseUntil = new Date(
      claimStartedAt.getTime() + IMPORT_BATCH_LEASE_MS,
    );
    const outboxCountBefore = await this.prisma.integrationOutbox.count({
      where: { companyId: input.companyId },
    });
    if (!existingBatch) {
      await this.prisma.whatsAppImportBatch.create({
        data: {
          id: input.batchId,
          companyId: input.companyId,
          channelId: input.channelId,
          actorUserId: actor.id,
          name: input.batchName,
          packagePath: prepared.package.packagePath,
          workbookSha256: prepared.package.workbookSha256,
          packageSha256: prepared.package.packageSha256,
          cutoffAt: input.cutoffAt,
          status: WhatsAppImportBatchStatus.APPLYING,
          expectedCounts: asJson(prepared.report.counts),
          outboxCountBefore,
          claimId,
          leaseUntil,
        },
      });
    } else {
      const claimed = await this.prisma.whatsAppImportBatch.updateMany({
        where: {
          id: input.batchId,
          OR: [
            { status: WhatsAppImportBatchStatus.FAILED },
            {
              status: WhatsAppImportBatchStatus.APPLYING,
              OR: [
                { leaseUntil: null },
                { leaseUntil: { lte: claimStartedAt } },
              ],
            },
          ],
        },
        data: {
          status: WhatsAppImportBatchStatus.APPLYING,
          errorMessage: null,
          claimId,
          leaseUntil,
          appliedAt: null,
        },
      });
      if (claimed.count !== 1) {
        throw new Error(
          'O lote foi reivindicado por outra execução; tente novamente após o lease atual.',
        );
      }
    }

    let appliedCounts: WhatsAppImportCounts = {
      ...emptyImportCounts(),
      conversations: upserts.length,
      byDepartment: {},
      byConversationState: {},
      byRequestStatus: {},
    };
    for (const row of upserts) {
      incrementImportCount(appliedCounts.byDepartment, row.departmentCode);
      incrementImportCount(
        appliedCounts.byConversationState,
        row.conversationState,
      );
      incrementImportCount(appliedCounts.byRequestStatus, row.requestStatus);
    }
    const messagesByConversation = groupByConversation(
      prepared.package.messages,
    );
    for (const messages of messagesByConversation.values()) {
      messages.sort(
        (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
      );
    }
    const documentsByConversation = groupByConversation(
      prepared.package.documents,
    );
    try {
      let leaseRenewedAt = Date.now();
      let renewalPromise: Promise<void> | null = null;
      const renewLeaseIfNeeded = async () => {
        if (Date.now() - leaseRenewedAt < 60_000) return;
        if (!renewalPromise) {
          renewalPromise = (async () => {
            const renewed = await this.prisma.whatsAppImportBatch.updateMany({
              where: {
                id: input.batchId,
                status: WhatsAppImportBatchStatus.APPLYING,
                claimId,
              },
              data: {
                leaseUntil: new Date(Date.now() + IMPORT_BATCH_LEASE_MS),
              },
            });
            if (renewed.count !== 1) {
              throw new Error(
                'O lease do lote foi perdido para outra execução.',
              );
            }
            leaseRenewedAt = Date.now();
          })().finally(() => {
            renewalPromise = null;
          });
        }
        await renewalPromise;
      };
      const conversationsByPhone = new Map<string, ConversationImportRow[]>();
      for (const row of upserts) {
        conversationsByPhone.set(row.phoneE164, [
          ...(conversationsByPhone.get(row.phoneE164) ?? []),
          row,
        ]);
      }
      const groupedResults = await mapWithConcurrency(
        [...conversationsByPhone.values()],
        this.applyConcurrency,
        async (rows): Promise<(AppliedConversationResult | null)[]> => {
          const phoneResults: (AppliedConversationResult | null)[] = [];
          // Referências diferentes (JID, LID ou aliases legados) do mesmo
          // telefone resolvem para uma única conversa. Processá-las em série
          // evita que duas transações disputem essa conversa canônica.
          for (const row of rows) {
            await renewLeaseIfNeeded();
            const existingRecord =
              await this.prisma.whatsAppImportRecord.findUnique({
                where: {
                  batchId_sourceSystem_externalConversationId: {
                    batchId: input.batchId,
                    sourceSystem: row.sourceSystem,
                    externalConversationId: row.externalConversationId,
                  },
                },
              });
            if (existingRecord?.status === WhatsAppImportRecordStatus.APPLIED) {
              phoneResults.push(null);
              continue;
            }
            const messages =
              messagesByConversation.get(row.externalConversationId) ?? [];
            const documents =
              documentsByConversation.get(row.externalConversationId) ?? [];
            phoneResults.push(
              await retryTransactionWriteConflict(() =>
                this.prisma.$transaction(
                  (transaction) =>
                    this.applyConversation(
                      transaction,
                      input,
                      actor.id,
                      row,
                      messages,
                      documents,
                    ),
                  {
                    // The batch lease guarantees one importer for this child batch.
                    // READ COMMITTED avoids PostgreSQL serialization failures while
                    // independent conversations are persisted in parallel; unique
                    // constraints remain the final idempotency guard.
                    isolationLevel:
                      Prisma.TransactionIsolationLevel.ReadCommitted,
                    maxWait: IMPORT_TRANSACTION_MAX_WAIT_MS,
                    timeout: IMPORT_TRANSACTION_TIMEOUT_MS,
                  },
                ),
              ),
            );
          }
          return phoneResults;
        },
      );
      const results = groupedResults.flat();
      for (const result of results) {
        if (!result) continue;
        if (result.created) {
          appliedCounts.conversationsToCreate += 1;
        } else {
          appliedCounts.conversationsToUpdate += 1;
        }
        if (result.contactCreated) {
          appliedCounts.contactsToCreate += 1;
        }
        if (result.contactUpdated) {
          appliedCounts.contactsToUpdate += 1;
        }
        if (result.quoteCreated) {
          appliedCounts.quoteRequestsToCreate += 1;
        }
        if (result.quoteUpdated) {
          appliedCounts.quoteRequestsToUpdate += 1;
        }
        appliedCounts.messagesToCreate += result.messageCount;
        appliedCounts.documentsToCreate += result.documentCount;
      }
      appliedCounts = await this.computeAppliedCounts(
        input.companyId,
        input.batchId,
        upserts,
        prepared.report.counts,
      );
      const outboxCountAfter = await this.prisma.integrationOutbox.count({
        where: { companyId: input.companyId },
      });
      const appliedAt = new Date();
      const finalized = await this.prisma.whatsAppImportBatch.updateMany({
        where: {
          id: input.batchId,
          status: WhatsAppImportBatchStatus.APPLYING,
          claimId,
        },
        data: {
          status: WhatsAppImportBatchStatus.APPLIED,
          appliedCounts: asJson(appliedCounts),
          outboxCountAfter,
          appliedAt,
          errorMessage: null,
          claimId: null,
          leaseUntil: null,
        },
      });
      if (finalized.count !== 1) {
        throw new Error(
          'Não foi possível finalizar o lote porque o lease foi perdido.',
        );
      }
      return {
        schemaVersion: '1.0',
        mode: 'apply',
        batchId: input.batchId,
        status: 'applied',
        idempotentReplay: false,
        counts: appliedCounts,
        outboxCreatedByImporter: 0,
      };
    } catch (error) {
      await this.prisma.whatsAppImportBatch.updateMany({
        where: {
          id: input.batchId,
          status: WhatsAppImportBatchStatus.APPLYING,
          claimId,
        },
        data: {
          status: WhatsAppImportBatchStatus.FAILED,
          errorMessage: (error instanceof Error
            ? error.message
            : 'Falha desconhecida.'
          ).slice(0, 1_000),
          claimId: null,
          leaseUntil: null,
        },
      });
      throw error;
    }
  }

  private async assertNoDriftSinceLastImport(
    transaction: Transaction | PrismaService,
    input: { companyId: string },
    row: ConversationImportRow,
    existingReference: {
      internalId: string;
    } | null,
    existingContact: {
      id: string;
      displayName: string | null;
    } | null,
  ): Promise<void> {
    if (!existingReference) {
      return;
    }
    const [conversation, latestRecord] = await Promise.all([
      transaction.whatsAppConversation.findUnique({
        where: {
          id_companyId: {
            id: existingReference.internalId,
            companyId: input.companyId,
          },
        },
      }),
      transaction.whatsAppImportRecord.findFirst({
        where: {
          companyId: input.companyId,
          conversationId: existingReference.internalId,
          status: WhatsAppImportRecordStatus.APPLIED,
        },
        orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    if (!conversation || !latestRecord) {
      throw new Error(
        `A referência de ${row.externalConversationId} não possui conversa e snapshot aplicados.`,
      );
    }
    const previousQuoteSequence = this.snapshotQuoteSequence(
      latestRecord.afterSnapshot,
    );
    const previousQuote = previousQuoteSequence
      ? await transaction.quoteRequest.findUnique({
          where: {
            companyId_conversationId_sequence: {
              companyId: input.companyId,
              conversationId: conversation.id,
              sequence: previousQuoteSequence,
            },
          },
        })
      : null;
    const currentSnapshot: Snapshot = {
      contact: selectedContactSnapshot(existingContact),
      conversation: selectedConversationSnapshot(conversation),
      quoteRequest: selectedQuoteSnapshot(previousQuote),
    };
    const expectedSnapshot = latestRecord.afterSnapshot as unknown as Snapshot;
    if (
      !snapshotEquals(currentSnapshot.contact, expectedSnapshot.contact) ||
      !snapshotEquals(
        currentSnapshot.conversation,
        expectedSnapshot.conversation,
      ) ||
      !snapshotEquals(
        currentSnapshot.quoteRequest,
        expectedSnapshot.quoteRequest,
      )
    ) {
      throw new Error(
        `A conversa ${row.externalConversationId} mudou desde a última importação.`,
      );
    }

    const [messages, transitions, documents] = await Promise.all([
      transaction.whatsAppMessage.findMany({
        where: {
          companyId: input.companyId,
          conversationId: conversation.id,
          createdAt: { gt: latestRecord.appliedAt },
        },
        select: { id: true },
      }),
      transaction.whatsAppConversationTransition.findMany({
        where: {
          companyId: input.companyId,
          conversationId: conversation.id,
          createdAt: { gt: latestRecord.appliedAt },
        },
        select: { id: true },
      }),
      transaction.quoteProposalDocument.findMany({
        where: {
          companyId: input.companyId,
          conversationId: conversation.id,
          createdAt: { gt: latestRecord.appliedAt },
        },
        select: { id: true },
      }),
    ]);
    const candidateIds = [
      ...messages.map((message) => ({
        entityType: 'message',
        internalId: message.id,
      })),
      ...documents.map((document) => ({
        entityType: 'document',
        internalId: document.id,
      })),
    ];
    const importedReferences = await collectChunked(
      candidateIds,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (candidateChunk) =>
        transaction.whatsAppImportExternalRef.findMany({
          where: {
            companyId: input.companyId,
            OR: [...candidateChunk],
          },
          select: { entityType: true, internalId: true },
        }),
    );
    const importedResourceKeys = new Set(
      importedReferences.map(
        (reference) => `${reference.entityType}\0${reference.internalId}`,
      ),
    );
    const hasRealMessage = messages.some(
      (message) => !importedResourceKeys.has(`message\0${message.id}`),
    );
    const hasRealDocument = documents.some(
      (document) => !importedResourceKeys.has(`document\0${document.id}`),
    );
    if (hasRealMessage || transitions.length > 0 || hasRealDocument) {
      throw new Error(
        `A conversa ${row.externalConversationId} recebeu atividade real após a última importação.`,
      );
    }
  }

  private async applyConversation(
    transaction: Transaction,
    input: WhatsAppImportApplyInput,
    actorUserId: string,
    row: ConversationImportRow,
    messages: MessageImportRow[],
    documents: DocumentImportRow[],
  ): Promise<AppliedConversationResult> {
    const created: CreatedResourceIds = {
      messageIds: [],
      documentIds: [],
      externalRefIds: [],
    };
    const existingReference =
      await transaction.whatsAppImportExternalRef.findUnique({
        where: {
          companyId_entityType_sourceSystem_externalId: {
            companyId: input.companyId,
            entityType: 'conversation',
            sourceSystem: row.sourceSystem,
            externalId: row.externalConversationId,
          },
        },
      });
    const existingContact = await transaction.whatsAppContact.findUnique({
      where: {
        companyId_phoneNormalized: {
          companyId: input.companyId,
          phoneNormalized: row.phoneE164,
        },
      },
      select: {
        id: true,
        displayName: true,
        isSaved: true,
        updatedAt: true,
      },
    });
    await this.assertNoDriftSinceLastImport(
      transaction,
      input,
      row,
      existingReference,
      existingContact,
    );
    const contact = existingContact
      ? existingReference &&
        !existingContact.isSaved &&
        row.contactName &&
        row.contactName !== existingContact.displayName
        ? await transaction.whatsAppContact.update({
            where: {
              id_companyId: {
                id: existingContact.id,
                companyId: input.companyId,
              },
            },
            data: { displayName: row.contactName },
            select: { id: true, displayName: true },
          })
        : existingContact
      : await transaction.whatsAppContact.create({
          data: {
            companyId: input.companyId,
            phoneNormalized: row.phoneE164,
            phoneDisplay: formatWhatsAppPhone(row.phoneE164),
            displayName: row.contactName,
          },
          select: { id: true, displayName: true },
        });
    if (!existingContact) {
      created.contactId = contact.id;
    }
    const referencedConversation = existingReference
      ? await transaction.whatsAppConversation.findUniqueOrThrow({
          where: {
            id_companyId: {
              id: existingReference.internalId,
              companyId: input.companyId,
            },
          },
        })
      : null;
    const canonicalConversation =
      await transaction.whatsAppConversation.findUnique({
        where: {
          companyId_channelId_contactId: {
            companyId: input.companyId,
            channelId: input.channelId,
            contactId: contact.id,
          },
        },
      });
    if (
      referencedConversation &&
      referencedConversation.channelId !== input.channelId
    ) {
      throw new Error(
        `Referência externa ${row.externalConversationId} pertence a outro canal.`,
      );
    }
    if (
      referencedConversation &&
      referencedConversation.contactId !== contact.id
    ) {
      throw new Error(
        `Referência externa ${row.externalConversationId} pertence a outro contato.`,
      );
    }
    if (
      referencedConversation &&
      canonicalConversation &&
      referencedConversation.id !== canonicalConversation.id
    ) {
      throw new Error(
        `Segunda conversa aberta bloqueada para ${row.externalConversationId}.`,
      );
    }
    const existingConversation =
      referencedConversation ?? canonicalConversation ?? null;
    if (OPEN_STATES.has(row.conversationState)) {
      const collision = await transaction.whatsAppConversation.findFirst({
        where: {
          companyId: input.companyId,
          channelId: input.channelId,
          contactId: contact.id,
          closedAt: null,
          ...(existingConversation
            ? { id: { not: existingConversation.id } }
            : {}),
        },
        select: { id: true },
      });
      if (collision) {
        throw new Error(
          `Segunda conversa aberta bloqueada para ${row.externalConversationId}.`,
        );
      }
    }
    const owner = row.ownerUsername
      ? await transaction.user.findFirstOrThrow({
          where: {
            companyId: input.companyId,
            usernameNormalized: normalizeUsername(row.ownerUsername),
            isActive: true,
            status: UserAccountStatus.ACTIVE,
          },
          select: { id: true },
        })
      : undefined;
    const inboundAt =
      messages.filter((message) => message.direction === 'inbound').at(-1)
        ?.occurredAt ??
      existingConversation?.lastInboundAt ??
      null;
    const outboundAt =
      messages.filter((message) => message.direction === 'outbound').at(-1)
        ?.occurredAt ??
      existingConversation?.lastOutboundAt ??
      null;
    const contextualFollowUpAt =
      row.conversationState === 'bot-active' &&
      row.flowStep === 'commercial-follow-up-menu' &&
      ['under-review', 'approved'].includes(row.requestStatus)
        ? row.lastInteractionAt
        : null;
    const conversationData = {
      department: DEPARTMENT_TO_PRISMA[row.departmentCode],
      conversationState: STATE_TO_PRISMA[row.conversationState],
      flowStep: FLOW_TO_PRISMA[row.flowStep],
      requestStatus: REQUEST_TO_PRISMA[row.requestStatus],
      resumeState: null,
      resumeFlowStep: null,
      assignedToUserId: owner?.id ?? null,
      unreadCount: row.unreadCount,
      mainMenuPresentedAt:
        row.flowStep === 'main-menu'
          ? null
          : existingConversation?.mainMenuPresentedAt,
      followUpMenuPresentedAt:
        row.flowStep === 'commercial-follow-up-menu'
          ? null
          : existingConversation?.followUpMenuPresentedAt,
      contextualFollowUpAt,
      lastInboundAt: inboundAt,
      lastOutboundAt: outboundAt,
      lastMessagePreview: row.lastMessagePreview?.slice(0, 240) ?? null,
      closedAt:
        row.conversationState === 'closed' ? row.lastInteractionAt : null,
    };
    const conversation = existingConversation
      ? await transaction.whatsAppConversation.update({
          where: {
            id_companyId: {
              id: existingConversation.id,
              companyId: input.companyId,
            },
          },
          data: {
            ...conversationData,
            version: { increment: 1 },
          },
        })
      : await transaction.whatsAppConversation.create({
          data: {
            companyId: input.companyId,
            channelId: input.channelId,
            contactId: contact.id,
            ...conversationData,
          },
        });
    if (!existingConversation) {
      created.conversationId = conversation.id;
    }
    if (!existingReference) {
      const reference = await transaction.whatsAppImportExternalRef.create({
        data: {
          batchId: input.batchId,
          companyId: input.companyId,
          entityType: 'conversation',
          sourceSystem: row.sourceSystem,
          externalId: row.externalConversationId,
          internalId: conversation.id,
        },
      });
      created.externalRefIds.push(reference.id);
    }

    const existingQuote = row.quoteSequence
      ? await transaction.quoteRequest.findUnique({
          where: {
            companyId_conversationId_sequence: {
              companyId: input.companyId,
              conversationId: conversation.id,
              sequence: row.quoteSequence,
            },
          },
        })
      : null;
    const before: Snapshot = {
      contact: selectedContactSnapshot(existingContact),
      conversation: selectedConversationSnapshot(existingConversation),
      quoteRequest: selectedQuoteSnapshot(existingQuote),
    };
    let quote = existingQuote;
    if (row.quoteSequence) {
      const existingStructured =
        existingQuote?.structuredData &&
        typeof existingQuote.structuredData === 'object' &&
        !Array.isArray(existingQuote.structuredData)
          ? (existingQuote.structuredData as Record<string, unknown>)
          : {};
      const internalTripType =
        row.tripType === 'one-way'
          ? 'one_way'
          : row.tripType === 'round-trip'
            ? 'round_trip'
            : row.tripType === 'unknown'
              ? 'unknown'
              : undefined;
      const structuredData = {
        ...existingStructured,
        source: 'legacy-whatsapp-import',
        ...(internalTripType ? { tripType: internalTripType } : {}),
        ...(row.transferDetails
          ? { transferDetails: row.transferDetails }
          : {}),
      };
      const confirmedSummary = row.confirmedAt
        ? {
            contactName: row.quoteContactName ?? null,
            document: row.quoteDocument ?? null,
            email: row.quoteEmail ?? null,
            serviceType: row.serviceType ?? null,
            tripType: internalTripType ?? null,
            origin: row.origin ?? null,
            destination: row.destination ?? null,
            departureDate: row.departureAt
              ? presentDateOnly(dateOnlyFromDateTime(row.departureAt))
              : null,
            departureAt: row.departureAt?.toISOString() ?? null,
            returnDate: row.returnAt
              ? presentDateOnly(dateOnlyFromDateTime(row.returnAt))
              : null,
            returnAt: row.returnAt?.toISOString() ?? null,
            passengerCount: row.passengerCount ?? null,
            vehicleType: row.vehicleType ?? null,
            vehicleAtDisposal: row.vehicleAtDisposal ?? null,
            localTransfers: row.localTransfers ?? null,
            transferDetails: row.transferDetails ?? null,
            notes: row.notes ?? null,
            source: 'legacy-whatsapp-import',
          }
        : undefined;
      const quoteData = {
        status: REQUEST_TO_PRISMA[row.requestStatus],
        contactName: row.quoteContactName ?? null,
        document: row.quoteDocument ?? null,
        email: row.quoteEmail ?? null,
        serviceType: row.serviceType ?? null,
        origin: row.origin ?? null,
        destination: row.destination ?? null,
        departureDate: row.departureAt
          ? dateOnlyFromDateTime(row.departureAt)
          : null,
        departureAt: row.departureAt ?? null,
        returnDate: row.returnAt ? dateOnlyFromDateTime(row.returnAt) : null,
        returnAt: row.returnAt ?? null,
        passengerCount: row.passengerCount ?? null,
        vehicleType: row.vehicleType ?? null,
        vehicleAtDisposal: row.vehicleAtDisposal ?? null,
        localTransfers: row.localTransfers ?? null,
        notes: row.notes ?? null,
        structuredData: asJson(structuredData),
        confirmedAt: row.confirmedAt ?? null,
        confirmedSummary: confirmedSummary
          ? asJson(confirmedSummary)
          : Prisma.JsonNull,
        decisionReason: row.decisionReason ?? null,
        decidedAt: row.decidedAt ?? null,
      };
      quote = existingQuote
        ? await transaction.quoteRequest.update({
            where: {
              id_companyId: {
                id: existingQuote.id,
                companyId: input.companyId,
              },
            },
            data: {
              ...quoteData,
              confirmedVersion: row.confirmedAt
                ? existingQuote.version + 1
                : null,
              version: { increment: 1 },
            },
          })
        : await transaction.quoteRequest.create({
            data: {
              companyId: input.companyId,
              conversationId: conversation.id,
              sequence: row.quoteSequence,
              ...quoteData,
              confirmedVersion: row.confirmedAt ? 1 : null,
            },
          });
      if (!existingQuote) {
        created.quoteRequestId = quote.id;
      }
    }

    const externalMessageIds = messages.map(
      (message) => message.externalMessageId,
    );
    const existingMessageRefs = await collectChunked(
      externalMessageIds,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (externalIdChunk) =>
        transaction.whatsAppImportExternalRef.findMany({
          where: {
            companyId: input.companyId,
            entityType: 'message',
            sourceSystem: row.sourceSystem,
            externalId: { in: [...externalIdChunk] },
          },
          select: {
            id: true,
            externalId: true,
            internalId: true,
            payloadHash: true,
          },
        }),
    );
    const existingMessageRefByExternalId = new Map(
      existingMessageRefs.map((reference) => [reference.externalId, reference]),
    );
    const referencedMessages = await collectChunked(
      existingMessageRefs.map((reference) => reference.internalId),
      IMPORT_LOOKUP_CHUNK_SIZE,
      (idChunk) =>
        transaction.whatsAppMessage.findMany({
          where: {
            companyId: input.companyId,
            id: { in: [...idChunk] },
          },
          select: { id: true, conversationId: true },
        }),
    );
    const referencedMessageById = new Map(
      referencedMessages.map((message) => [message.id, message]),
    );
    const actorUsernames = Array.from(
      new Set(
        messages
          .map((message) => message.actorUsername)
          .filter((value): value is string => Boolean(value))
          .map(normalizeUsername),
      ),
    );
    const messageActors = await collectChunked(
      actorUsernames,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (usernameChunk) =>
        transaction.user.findMany({
          where: {
            companyId: input.companyId,
            usernameNormalized: { in: [...usernameChunk] },
            isActive: true,
            status: UserAccountStatus.ACTIVE,
          },
          select: { id: true, usernameNormalized: true },
        }),
    );
    const messageActorByUsername = new Map(
      messageActors.map((actor) => [actor.usernameNormalized, actor.id]),
    );
    const messagesToCreate: Prisma.WhatsAppMessageCreateManyInput[] = [];
    const messageReferencesToCreate: Prisma.WhatsAppImportExternalRefCreateManyInput[] =
      [];

    for (const message of messages) {
      const payloadHash = this.messagePayloadHash(message);
      const existingMessageRef = existingMessageRefByExternalId.get(
        message.externalMessageId,
      );
      if (existingMessageRef) {
        if (existingMessageRef.payloadHash !== payloadHash) {
          throw new Error(
            `Mensagem ${message.externalMessageId} diverge da carga anterior.`,
          );
        }
        const referencedMessage = referencedMessageById.get(
          existingMessageRef.internalId,
        );
        if (
          !referencedMessage ||
          referencedMessage.conversationId !== conversation.id
        ) {
          throw new Error(
            `Mensagem ${message.externalMessageId} possui referência órfã ou pertence a outra conversa.`,
          );
        }
        continue;
      }
      const actorUserId = message.actorUsername
        ? messageActorByUsername.get(normalizeUsername(message.actorUsername))
        : undefined;
      if (message.actorUsername && !actorUserId) {
        throw new Error(
          `O usuário ${message.actorUsername} não está disponível para a mensagem importada.`,
        );
      }
      const messageId = randomUUID();
      const referenceId = randomUUID();
      const mediaMetadata = importedMediaMetadata(
        message.mediaReference,
        message.correlationId,
      );
      messagesToCreate.push({
        id: messageId,
        companyId: input.companyId,
        conversationId: conversation.id,
        channelId: input.channelId,
        contactId: contact.id,
        actorUserId,
        providerMessageId: message.providerMessageId,
        direction: DIRECTION_TO_PRISMA[message.direction],
        deliveryStatus: DELIVERY_TO_PRISMA[message.deliveryStatus],
        kind: KIND_TO_PRISMA[message.kind],
        text: message.text,
        ...(mediaMetadata !== undefined ? { media: mediaMetadata } : {}),
        correlationId: deterministicCorrelation(
          row.sourceSystem,
          message.externalMessageId,
        ),
        occurredAt: message.occurredAt,
      });
      messageReferencesToCreate.push({
        id: referenceId,
        batchId: input.batchId,
        companyId: input.companyId,
        entityType: 'message',
        sourceSystem: row.sourceSystem,
        externalId: message.externalMessageId,
        internalId: messageId,
        payloadHash,
      });
      created.messageIds.push(messageId);
      created.externalRefIds.push(referenceId);
    }
    for (const messageChunk of chunks(
      messagesToCreate,
      IMPORT_CREATE_MANY_CHUNK_SIZE,
    )) {
      await transaction.whatsAppMessage.createMany({ data: messageChunk });
    }
    for (const referenceChunk of chunks(
      messageReferencesToCreate,
      IMPORT_CREATE_MANY_CHUNK_SIZE,
    )) {
      await transaction.whatsAppImportExternalRef.createMany({
        data: referenceChunk,
      });
    }
    const messageCount = messagesToCreate.length;

    let documentCount = 0;
    for (const document of documents) {
      if (!quote || quote.sequence !== document.quoteSequence) {
        throw new Error(
          `Documento ${document.externalDocumentId} não possui QuoteRequest correspondente.`,
        );
      }
      const payloadHash = this.documentPayloadHash(document);
      const existingDocumentRef =
        await transaction.whatsAppImportExternalRef.findUnique({
          where: {
            companyId_entityType_sourceSystem_externalId: {
              companyId: input.companyId,
              entityType: 'document',
              sourceSystem: row.sourceSystem,
              externalId: document.externalDocumentId,
            },
          },
        });
      if (existingDocumentRef) {
        if (existingDocumentRef.payloadHash !== payloadHash) {
          throw new Error(
            `Documento ${document.externalDocumentId} diverge da carga anterior.`,
          );
        }
        const referencedDocument =
          await transaction.quoteProposalDocument.findUnique({
            where: {
              id_companyId: {
                id: existingDocumentRef.internalId,
                companyId: input.companyId,
              },
            },
            select: {
              conversationId: true,
              quoteRequest: { select: { sequence: true } },
            },
          });
        if (
          !referencedDocument ||
          referencedDocument.conversationId !== conversation.id ||
          referencedDocument.quoteRequest.sequence !== document.quoteSequence
        ) {
          throw new Error(
            `Documento ${document.externalDocumentId} possui referência órfã ou pertence a outra solicitação.`,
          );
        }
        continue;
      }
      const content = await readFile(document.absoluteFilePath);
      const currentHash = createHash('sha256').update(content).digest('hex');
      if (
        currentHash !== document.sha256 ||
        !content.subarray(0, 5).equals(Buffer.from('%PDF-'))
      ) {
        throw new Error(
          `O PDF ${document.externalDocumentId} foi alterado após o dry-run.`,
        );
      }
      const lastDocument = await transaction.quoteProposalDocument.findFirst({
        where: {
          companyId: input.companyId,
          quoteRequestId: quote.id,
        },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const persisted = await transaction.quoteProposalDocument.create({
        data: {
          companyId: input.companyId,
          conversationId: conversation.id,
          quoteRequestId: quote.id,
          uploadedByUserId: actorUserId,
          sentByUserId: document.documentStatus === 'sent' ? actorUserId : null,
          sequence: (lastDocument?.sequence ?? 0) + 1,
          status: DOCUMENT_STATUS_TO_PRISMA[document.documentStatus],
          fileName: document.fileName,
          mimeType: 'application/pdf',
          sizeBytes: content.length,
          sha256: currentHash,
          content,
          providerMessageId: document.providerMessageId,
          sentAt: document.sentAt,
        },
      });
      const reference = await transaction.whatsAppImportExternalRef.create({
        data: {
          batchId: input.batchId,
          companyId: input.companyId,
          entityType: 'document',
          sourceSystem: row.sourceSystem,
          externalId: document.externalDocumentId,
          internalId: persisted.id,
          payloadHash,
        },
      });
      created.documentIds.push(persisted.id);
      created.externalRefIds.push(reference.id);
      documentCount += 1;
    }

    const after = await this.loadSnapshot(
      transaction,
      input.companyId,
      contact.id,
      conversation.id,
      row.quoteSequence,
    );
    await transaction.whatsAppImportRecord.create({
      data: {
        batchId: input.batchId,
        companyId: input.companyId,
        sourceSystem: row.sourceSystem,
        externalConversationId: row.externalConversationId,
        conversationId: conversation.id,
        contactId: contact.id,
        action: existingConversation ? 'updated' : 'created',
        beforeSnapshot: asJson(before),
        afterSnapshot: asJson(after),
        createdResourceIds: asJson(created),
      },
    });
    await transaction.tenantAuditLog.create({
      data: {
        companyId: input.companyId,
        actorUserId,
        action: 'legacy-conversation-imported',
        targetType: 'whatsapp-conversation',
        targetId: conversation.id,
        metadata: asJson({
          batchId: input.batchId,
          batchName: input.batchName,
          sourceSystem: row.sourceSystem,
          externalConversationId: row.externalConversationId,
          silent: true,
          outboxCreated: false,
        }),
      },
    });
    return {
      created: !existingConversation,
      contactCreated: !existingContact,
      contactUpdated: Boolean(
        existingContact &&
        existingReference &&
        row.contactName &&
        row.contactName !== existingContact.displayName,
      ),
      quoteCreated: Boolean(row.quoteSequence && !existingQuote),
      quoteUpdated: Boolean(existingQuote),
      conversationId: conversation.id,
      contactId: contact.id,
      messageCount,
      documentCount,
    };
  }

  private async loadSnapshot(
    transaction: Transaction | PrismaService,
    companyId: string,
    contactId: string,
    conversationId: string,
    quoteSequence: number | undefined,
  ): Promise<Snapshot> {
    const [contact, conversation, quoteRequest] = await Promise.all([
      transaction.whatsAppContact.findUnique({
        where: { id_companyId: { id: contactId, companyId } },
        select: { id: true, displayName: true },
      }),
      transaction.whatsAppConversation.findUnique({
        where: { id_companyId: { id: conversationId, companyId } },
      }),
      quoteSequence
        ? transaction.quoteRequest.findUnique({
            where: {
              companyId_conversationId_sequence: {
                companyId,
                conversationId,
                sequence: quoteSequence,
              },
            },
          })
        : Promise.resolve(null),
    ]);
    return {
      contact: selectedContactSnapshot(contact),
      conversation: selectedConversationSnapshot(conversation),
      quoteRequest: selectedQuoteSnapshot(quoteRequest),
    };
  }

  private async computeAppliedCounts(
    companyId: string,
    batchId: string,
    upserts: ConversationImportRow[],
    validationCounts: WhatsAppImportCounts,
  ): Promise<WhatsAppImportCounts> {
    const [records, refs] = await Promise.all([
      this.prisma.whatsAppImportRecord.findMany({
        where: {
          companyId,
          batchId,
          status: WhatsAppImportRecordStatus.APPLIED,
        },
      }),
      this.prisma.whatsAppImportExternalRef.findMany({
        where: { companyId, batchId },
        select: { entityType: true },
      }),
    ]);
    const counts = emptyImportCounts();
    counts.conversations = records.length;
    counts.messagesToCreate = refs.filter(
      (reference) => reference.entityType === 'message',
    ).length;
    counts.documentsToCreate = refs.filter(
      (reference) => reference.entityType === 'document',
    ).length;
    counts.messagesDuplicate = validationCounts.messagesDuplicate;
    counts.documentsDuplicate = validationCounts.documentsDuplicate;
    const appliedKeys = new Set(
      records.map((record) =>
        externalKey(record.sourceSystem, record.externalConversationId),
      ),
    );
    for (const row of upserts) {
      if (
        !appliedKeys.has(
          externalKey(row.sourceSystem, row.externalConversationId),
        )
      ) {
        continue;
      }
      incrementImportCount(counts.byDepartment, row.departmentCode);
      incrementImportCount(counts.byConversationState, row.conversationState);
      incrementImportCount(counts.byRequestStatus, row.requestStatus);
    }
    for (const record of records) {
      const created =
        record.createdResourceIds as unknown as CreatedResourceIds;
      const before = record.beforeSnapshot as unknown as Snapshot;
      const after = record.afterSnapshot as unknown as Snapshot;
      if (record.action === 'created') {
        counts.conversationsToCreate += 1;
      } else {
        counts.conversationsToUpdate += 1;
      }
      if (created.contactId) {
        counts.contactsToCreate += 1;
      } else if (
        before.contact &&
        after.contact &&
        !snapshotEquals(before.contact, after.contact)
      ) {
        counts.contactsToUpdate += 1;
      }
      if (created.quoteRequestId) {
        counts.quoteRequestsToCreate += 1;
      } else if (before.quoteRequest && after.quoteRequest) {
        counts.quoteRequestsToUpdate += 1;
      }
    }
    return counts;
  }

  async reconcile(
    companyId: string,
    batchId: string,
  ): Promise<{
    schemaVersion: '1.0';
    mode: 'reconcile';
    batchId: string;
    status: string;
    valid: boolean;
    counts: {
      records: number;
      conversations: number;
      messages: number;
      documents: number;
      outboxCountBefore: number;
      outboxCountAfter: number | null;
      outboxDeltaDuringApply: number | null;
    };
    byDepartment: Record<string, number>;
    byConversationState: Record<string, number>;
    byRequestStatus: Record<string, number>;
    issues: ImportIssue[];
  }> {
    assertUuid('companyId', companyId);
    assertUuid('batchId', batchId);
    const batch = await this.prisma.whatsAppImportBatch.findFirstOrThrow({
      where: { id: batchId, companyId },
    });
    const records = await this.prisma.whatsAppImportRecord.findMany({
      where: {
        batchId,
        companyId,
        status: WhatsAppImportRecordStatus.APPLIED,
      },
    });
    const refs = await this.prisma.whatsAppImportExternalRef.findMany({
      where: { batchId, companyId },
    });
    const issues: ImportIssue[] = [];
    if (batch.status !== WhatsAppImportBatchStatus.APPLIED) {
      issue(
        issues,
        'database',
        'BATCH_NOT_APPLIED',
        'Somente um lote aplicado pode ser reconciliado como válido.',
      );
    }
    const conversationIds = records.map((record) => record.conversationId);
    const conversations = await collectChunked(
      conversationIds,
      IMPORT_LOOKUP_CHUNK_SIZE,
      (idChunk) =>
        this.prisma.whatsAppConversation.findMany({
          where: { companyId, id: { in: [...idChunk] } },
          select: {
            id: true,
            contactId: true,
            department: true,
            conversationState: true,
            requestStatus: true,
            closedAt: true,
          },
        }),
    );
    const messages = refs.filter(
      (reference) => reference.entityType === 'message',
    );
    const documents = refs.filter(
      (reference) => reference.entityType === 'document',
    );
    const persistedMessageIds = await collectChunked(
      messages.map((reference) => reference.internalId),
      IMPORT_LOOKUP_CHUNK_SIZE,
      (idChunk) =>
        this.prisma.whatsAppMessage.findMany({
          where: {
            companyId,
            id: { in: [...idChunk] },
          },
          select: { id: true, conversationId: true },
        }),
    );
    const persistedDocumentIds = await collectChunked(
      documents.map((reference) => reference.internalId),
      IMPORT_LOOKUP_CHUNK_SIZE,
      (idChunk) =>
        this.prisma.quoteProposalDocument.findMany({
          where: {
            companyId,
            id: { in: [...idChunk] },
          },
          select: { id: true, conversationId: true },
        }),
    );
    if (conversations.length !== records.length) {
      issue(
        issues,
        'database',
        'MISSING_IMPORTED_CONVERSATION',
        'Uma ou mais conversas registradas no lote não existem mais.',
      );
    }
    if (persistedMessageIds.length !== messages.length) {
      issue(
        issues,
        'database',
        'MISSING_IMPORTED_MESSAGE',
        'Uma ou mais mensagens registradas no lote não existem mais.',
      );
    }
    if (persistedDocumentIds.length !== documents.length) {
      issue(
        issues,
        'database',
        'MISSING_IMPORTED_DOCUMENT',
        'Um ou mais documentos registrados no lote não existem mais.',
      );
    }
    const conversationIdSet = new Set(
      conversations.map((conversation) => conversation.id),
    );
    const messageById = new Map(
      persistedMessageIds.map((message) => [message.id, message]),
    );
    const documentById = new Map(
      persistedDocumentIds.map((document) => [document.id, document]),
    );
    const recordExternalRefIds = new Set<string>();
    for (const record of records) {
      const created =
        record.createdResourceIds as unknown as CreatedResourceIds;
      created.externalRefIds.forEach((id) => recordExternalRefIds.add(id));
      for (const messageId of created.messageIds) {
        const message = messageById.get(messageId);
        if (!message || message.conversationId !== record.conversationId) {
          issue(
            issues,
            'database',
            'IMPORTED_MESSAGE_OWNERSHIP_MISMATCH',
            `A mensagem ${messageId} não pertence mais à conversa registrada no lote.`,
          );
        }
      }
      for (const documentId of created.documentIds) {
        const document = documentById.get(documentId);
        if (!document || document.conversationId !== record.conversationId) {
          issue(
            issues,
            'database',
            'IMPORTED_DOCUMENT_OWNERSHIP_MISMATCH',
            `O documento ${documentId} não pertence mais à conversa registrada no lote.`,
          );
        }
      }
      if (conversationIdSet.has(record.conversationId)) {
        const currentSnapshot = await this.loadSnapshot(
          this.prisma,
          companyId,
          record.contactId,
          record.conversationId,
          this.snapshotQuoteSequence(record.afterSnapshot),
        );
        const expectedAfter = record.afterSnapshot as unknown as Snapshot;
        if (
          !snapshotEquals(currentSnapshot.contact, expectedAfter.contact) ||
          !snapshotEquals(
            currentSnapshot.conversation,
            expectedAfter.conversation,
          ) ||
          !snapshotEquals(
            currentSnapshot.quoteRequest,
            expectedAfter.quoteRequest,
          )
        ) {
          issue(
            issues,
            'database',
            'IMPORTED_RECORD_DRIFT',
            `A conversa ${record.conversationId} diverge do snapshot aplicado.`,
          );
        }
      }
    }
    if (refs.some((reference) => !recordExternalRefIds.has(reference.id))) {
      issue(
        issues,
        'database',
        'UNOWNED_IMPORT_REFERENCE',
        'Uma ou mais referências externas do lote não pertencem a nenhum registro aplicado.',
      );
    }
    const openByContact = new Map<string, number>();
    const allOpen =
      conversations.length === 0
        ? []
        : await this.prisma.whatsAppConversation.findMany({
            where: {
              companyId,
              channelId: batch.channelId,
              contactId: {
                in: Array.from(
                  new Set(
                    conversations.map((conversation) => conversation.contactId),
                  ),
                ),
              },
              closedAt: null,
            },
            select: { contactId: true },
          });
    for (const conversation of allOpen) {
      openByContact.set(
        conversation.contactId,
        (openByContact.get(conversation.contactId) ?? 0) + 1,
      );
    }
    if (Array.from(openByContact.values()).some((count) => count > 1)) {
      issue(
        issues,
        'database',
        'DUPLICATE_OPEN_CONVERSATION',
        'A reconciliação encontrou mais de uma conversa aberta para um contato.',
      );
    }
    const byDepartment: Record<string, number> = {};
    const byConversationState: Record<string, number> = {};
    const byRequestStatus: Record<string, number> = {};
    for (const conversation of conversations) {
      incrementImportCount(
        byDepartment,
        canonicalValue(DEPARTMENT_TO_PRISMA, conversation.department),
      );
      incrementImportCount(
        byConversationState,
        canonicalValue(STATE_TO_PRISMA, conversation.conversationState),
      );
      incrementImportCount(
        byRequestStatus,
        canonicalValue(REQUEST_TO_PRISMA, conversation.requestStatus),
      );
    }
    const expected =
      batch.appliedCounts as unknown as WhatsAppImportCounts | null;
    if (!expected) {
      issue(
        issues,
        'database',
        'MISSING_APPLIED_COUNTS',
        'O lote não possui contagens aplicadas para reconciliação.',
      );
    } else {
      if (records.length !== expected.conversations) {
        issue(
          issues,
          'database',
          'RECORD_COUNT_MISMATCH',
          `Esperados ${expected.conversations} registros; encontrados ${records.length}.`,
        );
      }
      if (persistedMessageIds.length !== expected.messagesToCreate) {
        issue(
          issues,
          'database',
          'MESSAGE_COUNT_MISMATCH',
          `Esperadas ${expected.messagesToCreate} mensagens novas; encontradas ${persistedMessageIds.length}.`,
        );
      }
      if (persistedDocumentIds.length !== expected.documentsToCreate) {
        issue(
          issues,
          'database',
          'DOCUMENT_COUNT_MISMATCH',
          `Esperados ${expected.documentsToCreate} documentos novos; encontrados ${persistedDocumentIds.length}.`,
        );
      }
      for (const [name, actual, expectedDistribution] of [
        ['departamento', byDepartment, expected.byDepartment],
        [
          'estado da conversa',
          byConversationState,
          expected.byConversationState,
        ],
        ['status comercial', byRequestStatus, expected.byRequestStatus],
      ] as const) {
        if (!sameDistribution(actual, expectedDistribution)) {
          issue(
            issues,
            'database',
            'DISTRIBUTION_MISMATCH',
            `A distribuição por ${name} diverge do lote aplicado.`,
          );
        }
      }
    }
    if (
      batch.outboxCountAfter !== null &&
      batch.outboxCountAfter !== batch.outboxCountBefore
    ) {
      issue(
        issues,
        'database',
        'CONCURRENT_OUTBOX_ACTIVITY_OBSERVED',
        'A contagem global da outbox mudou durante a aplicação. O importador não publica outbox, mas houve atividade concorrente no tenant.',
        undefined,
        'warning',
      );
    }
    return {
      schemaVersion: '1.0',
      mode: 'reconcile',
      batchId,
      status: batch.status,
      valid: !issues.some((entry) => entry.severity === 'error'),
      counts: {
        records: records.length,
        conversations: conversations.length,
        messages: persistedMessageIds.length,
        documents: persistedDocumentIds.length,
        outboxCountBefore: batch.outboxCountBefore,
        outboxCountAfter: batch.outboxCountAfter,
        outboxDeltaDuringApply:
          batch.outboxCountAfter === null
            ? null
            : batch.outboxCountAfter - batch.outboxCountBefore,
      },
      byDepartment,
      byConversationState,
      byRequestStatus,
      issues,
    };
  }

  private async collectRollbackBlockers(
    transaction: Transaction,
    batch: WhatsAppImportBatch,
    records: WhatsAppImportRecord[],
  ): Promise<ImportIssue[]> {
    const batchConversationIds = new Set(
      records.map((record) => record.conversationId),
    );
    const blockers: ImportIssue[] = [];
    for (const record of records) {
      const created =
        record.createdResourceIds as unknown as CreatedResourceIds;
      const [realMessage, realTransition, laterDocument, currentSnapshot] =
        await Promise.all([
          transaction.whatsAppMessage.findFirst({
            where: {
              companyId: batch.companyId,
              conversationId: record.conversationId,
              createdAt: { gt: batch.cutoffAt },
              id: { notIn: created.messageIds },
            },
            select: { id: true },
          }),
          transaction.whatsAppConversationTransition.findFirst({
            where: {
              companyId: batch.companyId,
              conversationId: record.conversationId,
              createdAt: { gt: batch.cutoffAt },
            },
            select: { id: true },
          }),
          transaction.quoteProposalDocument.findFirst({
            where: {
              companyId: batch.companyId,
              conversationId: record.conversationId,
              createdAt: { gt: batch.cutoffAt },
              id: { notIn: created.documentIds },
            },
            select: { id: true },
          }),
          this.loadSnapshot(
            transaction,
            batch.companyId,
            record.contactId,
            record.conversationId,
            this.snapshotQuoteSequence(record.afterSnapshot),
          ),
        ]);
      if (realMessage || realTransition || laterDocument) {
        issue(
          blockers,
          'database',
          'POST_CUTOFF_INTERACTION',
          `A conversa ${record.conversationId} recebeu atividade real após a aplicação.`,
        );
      }
      const expectedAfter = record.afterSnapshot as unknown as Snapshot;
      if (
        !snapshotEquals(currentSnapshot.contact, expectedAfter.contact) ||
        !snapshotEquals(
          currentSnapshot.conversation,
          expectedAfter.conversation,
        ) ||
        !snapshotEquals(
          currentSnapshot.quoteRequest,
          expectedAfter.quoteRequest,
        )
      ) {
        issue(
          blockers,
          'database',
          'IMPORTED_RECORD_CHANGED',
          `A conversa ${record.conversationId} foi alterada depois da importação.`,
        );
      }
      if (created.contactId) {
        const contactConversations =
          await transaction.whatsAppConversation.findMany({
            where: {
              companyId: batch.companyId,
              contactId: created.contactId,
            },
            select: { id: true },
          });
        if (
          contactConversations.some(
            (conversation) => !batchConversationIds.has(conversation.id),
          )
        ) {
          issue(
            blockers,
            'database',
            'IMPORTED_CONTACT_REUSED',
            `O contato ${created.contactId} passou a ser usado por outra conversa.`,
          );
        }
      }
    }
    return blockers;
  }

  private async lockRollbackScope(
    transaction: Transaction,
    batchId: string,
    companyId: string,
    records: WhatsAppImportRecord[],
  ): Promise<void> {
    await transaction.$queryRaw(
      Prisma.sql`
        SELECT "id"
        FROM "whatsapp_import_batches"
        WHERE "id" = CAST(${batchId} AS uuid)
          AND "company_id" = CAST(${companyId} AS uuid)
        FOR UPDATE
      `,
    );
    const conversationIds = [
      ...new Set(records.map((record) => record.conversationId)),
    ].sort();
    if (conversationIds.length > 0) {
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT "id"
          FROM "whatsapp_conversations"
          WHERE "company_id" = CAST(${companyId} AS uuid)
            AND "id" IN (${Prisma.join(conversationIds)})
          ORDER BY "id"
          FOR UPDATE
        `,
      );
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT "id"
          FROM "quote_requests"
          WHERE "company_id" = CAST(${companyId} AS uuid)
            AND "conversation_id" IN (${Prisma.join(conversationIds)})
          ORDER BY "id"
          FOR UPDATE
        `,
      );
    }
    const contactIds = [
      ...new Set(records.map((record) => record.contactId)),
    ].sort();
    if (contactIds.length > 0) {
      await transaction.$queryRaw(
        Prisma.sql`
          SELECT "id"
          FROM "whatsapp_contacts"
          WHERE "company_id" = CAST(${companyId} AS uuid)
            AND "id" IN (${Prisma.join(contactIds)})
          ORDER BY "id"
          FOR UPDATE
        `,
      );
    }
  }

  private async rollbackRecord(
    transaction: Transaction,
    input: WhatsAppImportRollbackInput,
    actorUserId: string,
    record: WhatsAppImportRecord,
  ): Promise<void> {
    const created = record.createdResourceIds as unknown as CreatedResourceIds;
    const before = record.beforeSnapshot as unknown as Snapshot;
    if (created.externalRefIds.length > 0) {
      await transaction.whatsAppImportExternalRef.deleteMany({
        where: {
          companyId: input.companyId,
          id: { in: created.externalRefIds },
        },
      });
    }
    if (created.documentIds.length > 0) {
      await transaction.quoteProposalDocument.deleteMany({
        where: {
          companyId: input.companyId,
          id: { in: created.documentIds },
        },
      });
    }
    if (created.messageIds.length > 0) {
      await transaction.whatsAppMessage.deleteMany({
        where: {
          companyId: input.companyId,
          id: { in: created.messageIds },
        },
      });
    }
    if (created.quoteRequestId) {
      await transaction.quoteRequest.delete({
        where: {
          id_companyId: {
            id: created.quoteRequestId,
            companyId: input.companyId,
          },
        },
      });
    } else if (before.quoteRequest) {
      await this.restoreQuote(
        transaction,
        input.companyId,
        before.quoteRequest,
      );
    }
    if (created.conversationId) {
      await transaction.whatsAppConversation.delete({
        where: {
          id_companyId: {
            id: created.conversationId,
            companyId: input.companyId,
          },
        },
      });
    } else if (before.conversation) {
      await this.restoreConversation(
        transaction,
        input.companyId,
        before.conversation,
      );
    }
    if (created.contactId) {
      await transaction.whatsAppContact.delete({
        where: {
          id_companyId: {
            id: created.contactId,
            companyId: input.companyId,
          },
        },
      });
    } else if (before.contact) {
      await transaction.whatsAppContact.update({
        where: {
          id_companyId: {
            id: String(before.contact.id),
            companyId: input.companyId,
          },
        },
        data: {
          displayName:
            typeof before.contact.displayName === 'string'
              ? before.contact.displayName
              : null,
        },
      });
    }
    await transaction.whatsAppImportRecord.update({
      where: { id: record.id },
      data: {
        status: WhatsAppImportRecordStatus.ROLLED_BACK,
        rolledBackAt: new Date(),
      },
    });
    await transaction.tenantAuditLog.create({
      data: {
        companyId: input.companyId,
        actorUserId,
        action: 'legacy-conversation-import-rolled-back',
        targetType: 'whatsapp-conversation',
        targetId: record.conversationId,
        metadata: asJson({
          batchId: input.batchId,
          sourceSystem: record.sourceSystem,
          externalConversationId: record.externalConversationId,
        }),
      },
    });
  }

  async rollback(input: WhatsAppImportRollbackInput): Promise<{
    schemaVersion: '1.0';
    mode: 'rollback';
    batchId: string;
    status: 'rolled-back';
    recordsRolledBack: number;
  }> {
    assertUuid('companyId', input.companyId);
    assertUuid('batchId', input.batchId);
    if (
      input.actorUsername.trim() !== input.actorUsername ||
      input.actorUsername.length < 1 ||
      input.actorUsername.length > 40
    ) {
      throw new Error(
        'actorUsername deve possuir de 1 a 40 caracteres, sem espaços nas extremidades.',
      );
    }
    if (input.confirmation !== `ROLLBACK:${input.batchId}`) {
      throw new Error(
        `Confirmação inválida. Use --confirm=ROLLBACK:${input.batchId}.`,
      );
    }
    const actor = await this.prisma.user.findFirstOrThrow({
      where: {
        companyId: input.companyId,
        usernameNormalized: normalizeUsername(input.actorUsername),
        isActive: true,
        status: UserAccountStatus.ACTIVE,
      },
      select: { id: true },
    });
    const batch = await this.prisma.whatsAppImportBatch.findFirstOrThrow({
      where: { id: input.batchId, companyId: input.companyId },
    });
    if (batch.status === WhatsAppImportBatchStatus.ROLLED_BACK) {
      return {
        schemaVersion: '1.0',
        mode: 'rollback',
        batchId: input.batchId,
        status: 'rolled-back',
        recordsRolledBack: 0,
      };
    }
    if (
      batch.status !== WhatsAppImportBatchStatus.APPLIED ||
      !batch.appliedAt
    ) {
      throw new Error('Somente lotes aplicados podem ser revertidos.');
    }
    const claimId = randomUUID();
    const claimedAt = new Date();
    const claimed = await this.prisma.whatsAppImportBatch.updateMany({
      where: {
        id: input.batchId,
        companyId: input.companyId,
        status: WhatsAppImportBatchStatus.APPLIED,
        OR: [
          { claimId: null },
          { leaseUntil: null },
          { leaseUntil: { lte: claimedAt } },
        ],
      },
      data: {
        claimId,
        leaseUntil: new Date(claimedAt.getTime() + IMPORT_BATCH_LEASE_MS),
      },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.whatsAppImportBatch.findFirstOrThrow({
        where: { id: input.batchId, companyId: input.companyId },
      });
      if (current.status === WhatsAppImportBatchStatus.ROLLED_BACK) {
        return {
          schemaVersion: '1.0',
          mode: 'rollback',
          batchId: input.batchId,
          status: 'rolled-back',
          recordsRolledBack: 0,
        };
      }
      throw new Error(
        'O rollback do lote já está em execução; aguarde o lease atual.',
      );
    }

    try {
      const recordsRolledBack = await this.prisma.$transaction(
        async (transaction) => {
          const records = await transaction.whatsAppImportRecord.findMany({
            where: {
              batchId: input.batchId,
              companyId: input.companyId,
              status: WhatsAppImportRecordStatus.APPLIED,
            },
            orderBy: [{ appliedAt: 'desc' }, { id: 'desc' }],
          });
          await this.lockRollbackScope(
            transaction,
            input.batchId,
            input.companyId,
            records,
          );
          const lockedBatch =
            await transaction.whatsAppImportBatch.findFirstOrThrow({
              where: {
                id: input.batchId,
                companyId: input.companyId,
                status: WhatsAppImportBatchStatus.APPLIED,
                claimId,
              },
            });
          if (!lockedBatch.appliedAt) {
            throw new Error('O lote não possui data de aplicação.');
          }
          await transaction.whatsAppImportBatch.update({
            where: { id: input.batchId },
            data: {
              leaseUntil: new Date(Date.now() + IMPORT_BATCH_LEASE_MS),
            },
          });
          const blockers = await this.collectRollbackBlockers(
            transaction,
            lockedBatch,
            records,
          );
          if (blockers.length > 0) {
            const error = new Error(
              'Rollback automático bloqueado; execute reconciliação assistida.',
            );
            Object.assign(error, { issues: blockers });
            throw error;
          }
          for (const record of records) {
            await this.rollbackRecord(transaction, input, actor.id, record);
          }
          const finalized = await transaction.whatsAppImportBatch.updateMany({
            where: {
              id: input.batchId,
              companyId: input.companyId,
              status: WhatsAppImportBatchStatus.APPLIED,
              claimId,
            },
            data: {
              status: WhatsAppImportBatchStatus.ROLLED_BACK,
              rolledBackAt: new Date(),
              claimId: null,
              leaseUntil: null,
            },
          });
          if (finalized.count !== 1) {
            throw new Error(
              'Não foi possível finalizar o rollback porque o lease foi perdido.',
            );
          }
          return records.length;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: IMPORT_TRANSACTION_MAX_WAIT_MS,
          timeout: IMPORT_TRANSACTION_TIMEOUT_MS,
        },
      );
      return {
        schemaVersion: '1.0',
        mode: 'rollback',
        batchId: input.batchId,
        status: 'rolled-back',
        recordsRolledBack,
      };
    } catch (error) {
      await this.prisma.whatsAppImportBatch.updateMany({
        where: {
          id: input.batchId,
          companyId: input.companyId,
          status: WhatsAppImportBatchStatus.APPLIED,
          claimId,
        },
        data: {
          claimId: null,
          leaseUntil: null,
        },
      });
      throw error;
    }
  }

  private snapshotQuoteSequence(
    snapshot: Prisma.JsonValue,
  ): number | undefined {
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot) ||
      !('quoteRequest' in snapshot)
    ) {
      return undefined;
    }
    const quote = snapshot.quoteRequest;
    if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
      return undefined;
    }
    const sequence = quote.sequence;
    return typeof sequence === 'number' ? sequence : undefined;
  }

  private async restoreConversation(
    transaction: Transaction,
    companyId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    await transaction.whatsAppConversation.update({
      where: {
        id_companyId: { id: String(snapshot.id), companyId },
      },
      data: {
        department: snapshot.department as DepartmentCode,
        conversationState: snapshot.conversationState as ConversationState,
        flowStep: snapshot.flowStep as FlowStep,
        requestStatus: snapshot.requestStatus as RequestStatus,
        resumeState: (snapshot.resumeState as ConversationState | null) ?? null,
        resumeFlowStep: (snapshot.resumeFlowStep as FlowStep | null) ?? null,
        assignedToUserId:
          typeof snapshot.assignedToUserId === 'string'
            ? snapshot.assignedToUserId
            : null,
        unreadCount: Number(snapshot.unreadCount),
        version: Number(snapshot.version),
        mainMenuPresentedAt: restoreDate(snapshot.mainMenuPresentedAt),
        followUpMenuPresentedAt: restoreDate(snapshot.followUpMenuPresentedAt),
        contextualFollowUpAt: restoreDate(snapshot.contextualFollowUpAt),
        departmentContactOption:
          typeof snapshot.departmentContactOption === 'string'
            ? snapshot.departmentContactOption
            : null,
        lastInboundAt: restoreDate(snapshot.lastInboundAt),
        lastOutboundAt: restoreDate(snapshot.lastOutboundAt),
        lastMessagePreview:
          typeof snapshot.lastMessagePreview === 'string'
            ? snapshot.lastMessagePreview
            : null,
        closedAt: restoreDate(snapshot.closedAt),
      },
    });
  }

  private async restoreQuote(
    transaction: Transaction,
    companyId: string,
    snapshot: Record<string, unknown>,
  ): Promise<void> {
    await transaction.quoteRequest.update({
      where: {
        id_companyId: { id: String(snapshot.id), companyId },
      },
      data: {
        status: snapshot.status as RequestStatus,
        contactName:
          typeof snapshot.contactName === 'string'
            ? snapshot.contactName
            : null,
        document:
          typeof snapshot.document === 'string' ? snapshot.document : null,
        email: typeof snapshot.email === 'string' ? snapshot.email : null,
        serviceType:
          typeof snapshot.serviceType === 'string'
            ? snapshot.serviceType
            : null,
        origin: typeof snapshot.origin === 'string' ? snapshot.origin : null,
        destination:
          typeof snapshot.destination === 'string'
            ? snapshot.destination
            : null,
        departureDate: restoreDate(snapshot.departureDate),
        departureAt: restoreDate(snapshot.departureAt),
        returnDate: restoreDate(snapshot.returnDate),
        returnAt: restoreDate(snapshot.returnAt),
        passengerCount:
          typeof snapshot.passengerCount === 'number'
            ? snapshot.passengerCount
            : null,
        vehicleType:
          typeof snapshot.vehicleType === 'string'
            ? snapshot.vehicleType
            : null,
        vehicleAtDisposal:
          typeof snapshot.vehicleAtDisposal === 'boolean'
            ? snapshot.vehicleAtDisposal
            : null,
        localTransfers:
          typeof snapshot.localTransfers === 'boolean'
            ? snapshot.localTransfers
            : null,
        notes: typeof snapshot.notes === 'string' ? snapshot.notes : null,
        structuredData: asJson(snapshot.structuredData ?? {}),
        confirmedAt: restoreDate(snapshot.confirmedAt),
        confirmedSummary:
          snapshot.confirmedSummary === null ||
          snapshot.confirmedSummary === undefined
            ? Prisma.JsonNull
            : asJson(snapshot.confirmedSummary),
        confirmedVersion:
          typeof snapshot.confirmedVersion === 'number'
            ? snapshot.confirmedVersion
            : null,
        requestedByUserId:
          typeof snapshot.requestedByUserId === 'string'
            ? snapshot.requestedByUserId
            : null,
        decisionReason:
          typeof snapshot.decisionReason === 'string'
            ? snapshot.decisionReason
            : null,
        decidedAt: restoreDate(snapshot.decidedAt),
        decidedByUserId:
          typeof snapshot.decidedByUserId === 'string'
            ? snapshot.decidedByUserId
            : null,
        version: Number(snapshot.version),
      },
    });
  }
}

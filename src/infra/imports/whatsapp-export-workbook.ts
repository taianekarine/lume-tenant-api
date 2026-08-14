import ExcelJS from 'exceljs';

import {
  CONVERSATION_HEADERS,
  DOCUMENT_HEADERS,
  MESSAGE_HEADERS,
  WHATSAPP_IMPORT_TABLES,
} from './whatsapp-import.types';
import {
  deterministicWhatsAppExportId,
  type ParsedWhatsAppExport,
  WHATSAPP_EXPORT_SOURCE_SYSTEM,
} from './whatsapp-export-parser';

export const WHATSAPP_HISTORY_STATE_OPTIONS = [
  'human-queue',
  'human-active',
  'closed',
  'bot-menu',
] as const;

export type WhatsAppHistoryStateOption =
  (typeof WHATSAPP_HISTORY_STATE_OPTIONS)[number];

export interface WhatsAppHistoryConversationMapping {
  archiveId: string;
  phoneE164: string;
  contactName: string;
  companySenderName: string;
  state: WhatsAppHistoryStateOption;
  departmentCode: string;
  ownerUsername?: string | null;
}

export interface GeneratedWhatsAppImportWorkbook {
  content: Buffer;
  conversationCount: number;
  messageCount: number;
  attachmentCount: number;
}

export interface WhatsAppExportMessageIdentity {
  readonly archiveId: string;
  readonly externalConversationId: string;
  readonly externalMessageId: string;
  readonly outbound: boolean;
  readonly message: ParsedWhatsAppExport['messages'][number];
}

export function identifyWhatsAppExportMessages(
  parsed: ParsedWhatsAppExport,
  mapping: WhatsAppHistoryConversationMapping,
  channelPhoneE164: string,
): readonly WhatsAppExportMessageIdentity[] {
  const externalConversationId = `chat-export-${deterministicWhatsAppExportId(
    channelPhoneE164,
    mapping.phoneE164,
  )}`;
  const duplicateOrdinals = new Map<string, number>();

  return parsed.messages.map((message) => {
    const outbound = message.senderName === mapping.companySenderName;
    const signature = deterministicWhatsAppExportId(
      externalConversationId,
      message.wallClockAt.toISOString(),
      message.senderName,
      message.kind,
      message.text,
      message.attachment?.fileName,
    );
    const ordinal = duplicateOrdinals.get(signature) ?? 0;
    duplicateOrdinals.set(signature, ordinal + 1);

    return {
      archiveId: parsed.archiveId,
      externalConversationId,
      externalMessageId: `chat-message-${deterministicWhatsAppExportId(
        signature,
        ordinal,
      )}`,
      outbound,
      message,
    };
  });
}

function stateColumns(mapping: WhatsAppHistoryConversationMapping): {
  conversationState: string;
  flowStep: string;
  requestStatus: string;
  ownerUsername: string;
} {
  switch (mapping.state) {
    case 'human-queue':
      return {
        conversationState: 'sent-to-human',
        flowStep: 'human-service',
        requestStatus: 'not-started',
        ownerUsername: '',
      };
    case 'human-active':
      return {
        conversationState: 'human-active',
        flowStep: 'human-service',
        requestStatus: 'not-started',
        ownerUsername: mapping.ownerUsername?.trim() ?? '',
      };
    case 'closed':
      return {
        conversationState: 'closed',
        flowStep: 'closed',
        requestStatus: 'not-started',
        ownerUsername: '',
      };
    case 'bot-menu':
      return {
        conversationState: 'bot-active',
        flowStep: 'main-menu',
        requestStatus: 'not-started',
        ownerUsername: '',
      };
  }
}

function messagePreview(
  message: ParsedWhatsAppExport['messages'][number] | undefined,
): string {
  if (!message) return '';
  if (message.text) return message.text.replace(/\s+/g, ' ').slice(0, 240);
  return message.attachment
    ? `Arquivo: ${message.attachment.fileName}`.slice(0, 240)
    : 'Mensagem sem texto';
}

function addImportTable(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  tableName: string,
  headers: readonly string[],
  rows: unknown[][],
): ExcelJS.Worksheet {
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.addTable({
    name: tableName,
    ref: 'A1',
    headerRow: true,
    style: { theme: 'TableStyleMedium2', showRowStripes: true },
    columns: headers.map((name) => ({ name })),
    rows,
  });
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column, index) => {
    const header = headers[index] ?? '';
    column.width = /(?:text|message|notes|details)/.test(header)
      ? 42
      : /(?:_at|name|status|state|step)/.test(header)
        ? 24
        : 18;
  });
  return sheet;
}

function asRow(headers: readonly string[], values: Record<string, unknown>) {
  return headers.map((header) => values[header] ?? '');
}

export async function createWhatsAppImportWorkbook(
  exports: readonly ParsedWhatsAppExport[],
  mappings: readonly WhatsAppHistoryConversationMapping[],
  channelPhoneE164: string,
): Promise<GeneratedWhatsAppImportWorkbook> {
  const mappingByArchive = new Map(
    mappings.map((mapping) => [mapping.archiveId, mapping]),
  );
  const conversations: unknown[][] = [];
  const messages: unknown[][] = [];
  let attachmentCount = 0;

  for (const parsed of exports) {
    const mapping = mappingByArchive.get(parsed.archiveId);
    if (!mapping) continue;
    const state = stateColumns(mapping);
    const externalConversationId = `chat-export-${deterministicWhatsAppExportId(
      channelPhoneE164,
      mapping.phoneE164,
    )}`;
    const lastMessage = parsed.messages.at(-1);
    conversations.push(
      asRow(CONVERSATION_HEADERS, {
        external_conversation_id: externalConversationId,
        source_system: WHATSAPP_EXPORT_SOURCE_SYSTEM,
        phone_e164: mapping.phoneE164,
        contact_name: mapping.contactName,
        channel_phone_e164: channelPhoneE164,
        department_code: mapping.departmentCode,
        owner_username: state.ownerUsername,
        conversation_state: state.conversationState,
        flow_step: state.flowStep,
        request_status: state.requestStatus,
        last_interaction_at:
          lastMessage?.wallClockAt ?? parsed.messages[0]?.wallClockAt,
        last_message_preview: messagePreview(lastMessage),
        unread_count: 0,
        migration_action: 'upsert',
        validation_status: '',
        validation_message: '',
      }),
    );

    for (const identity of identifyWhatsAppExportMessages(
      parsed,
      mapping,
      channelPhoneE164,
    )) {
      const { externalMessageId, message, outbound } = identity;
      const mediaReference = message.attachment
        ? `whatsapp-export://${parsed.archiveId}/${encodeURIComponent(
            message.attachment.fileName,
          )}`
        : '';
      if (message.attachment) attachmentCount += 1;
      messages.push(
        asRow(MESSAGE_HEADERS, {
          external_conversation_id: externalConversationId,
          external_message_id: externalMessageId,
          direction: outbound ? 'outbound' : 'inbound',
          kind: message.kind,
          occurred_at: message.wallClockAt,
          delivery_status: outbound ? 'sent' : 'received',
          text: message.system
            ? `[Mensagem do sistema] ${message.text ?? ''}`.trim()
            : (message.text ?? ''),
          media_reference: mediaReference,
          actor_username: '',
          provider_message_id: '',
          correlation_id: externalMessageId,
          validation_status: '',
          validation_message: '',
        }),
      );
    }
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Lume';
  const deterministicWorkbookDate = new Date('2000-01-01T00:00:00.000Z');
  workbook.created = deterministicWorkbookDate;
  workbook.modified = deterministicWorkbookDate;
  workbook.calcProperties.fullCalcOnLoad = false;
  const conversationSheet = addImportTable(
    workbook,
    'Atendimentos',
    WHATSAPP_IMPORT_TABLES.conversations,
    CONVERSATION_HEADERS,
    conversations,
  );
  const messageSheet = addImportTable(
    workbook,
    'Mensagens',
    WHATSAPP_IMPORT_TABLES.messages,
    MESSAGE_HEADERS,
    messages,
  );
  addImportTable(
    workbook,
    'Documentos',
    WHATSAPP_IMPORT_TABLES.documents,
    DOCUMENT_HEADERS,
    [],
  );
  const lastInteractionColumn =
    CONVERSATION_HEADERS.indexOf('last_interaction_at') + 1;
  conversationSheet.getColumn(lastInteractionColumn).numFmt =
    'dd/mm/yyyy hh:mm:ss';
  const occurredAtColumn = MESSAGE_HEADERS.indexOf('occurred_at') + 1;
  messageSheet.getColumn(occurredAtColumn).numFmt = 'dd/mm/yyyy hh:mm:ss';

  const content = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    content,
    conversationCount: conversations.length,
    messageCount: messages.length,
    attachmentCount,
  };
}

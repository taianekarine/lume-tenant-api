import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS, { type Worksheet } from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DepartmentCode,
  UserAccountStatus,
} from '../database/prisma/generated/client';
import type { PrismaService } from '../database/prisma/prisma.service';
import { WhatsAppImportService } from './whatsapp-import.service';
import {
  CONVERSATION_HEADERS,
  DOCUMENT_HEADERS,
  MESSAGE_HEADERS,
} from './whatsapp-import.types';

const temporaryRoots: string[] = [];
const testCompanyId = '00000000-0000-4000-8000-000000000001';
const testChannelId = '00000000-0000-4000-8000-000000000002';

function blanks(length: number): unknown[] {
  return Array.from({ length }, () => null);
}

function addTable(
  worksheet: Worksheet,
  name: string,
  headers: readonly string[],
  rows: unknown[][],
): void {
  worksheet.addTable({
    name,
    ref: 'A1',
    headerRow: true,
    totalsRow: false,
    columns: headers.map((header) => ({ name: header })),
    rows,
  });
}

function conversationRow(
  externalId: string,
  phone = '553496305110',
): unknown[] {
  const row = blanks(CONVERSATION_HEADERS.length);
  row[0] = externalId;
  row[1] = 'legacy-system';
  row[2] = phone;
  row[3] = 'Cliente legado';
  row[4] = '553474009517';
  row[5] = 'commercial';
  row[7] = 'bot-active';
  row[8] = 'main-menu';
  row[9] = 'not-started';
  row[10] = new Date(Date.UTC(2026, 6, 29, 12));
  row[12] = 0;
  row[18] = 'unknown';
  row[25] = 'desconhecido';
  row[26] = 'desconhecido';
  row[32] = 'upsert';
  return row;
}

async function packageWithRows(options: {
  conversations: unknown[][];
  messages?: unknown[][];
}): Promise<{ root: string; packagePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'lume-import-service-'));
  temporaryRoots.push(root);
  const packagePath = join(root, 'batch');
  await mkdir(join(packagePath, 'files'), { recursive: true });
  const workbook = new ExcelJS.Workbook();
  const conversations = workbook.addWorksheet('Atendimentos');
  const messages = workbook.addWorksheet('Mensagens');
  const documents = workbook.addWorksheet('Documentos');
  addTable(
    conversations,
    'AtendimentosImportacao',
    CONVERSATION_HEADERS,
    options.conversations,
  );
  addTable(
    messages,
    'MensagensImportacao',
    MESSAGE_HEADERS,
    options.messages ?? [],
  );
  addTable(documents, 'DocumentosImportacao', DOCUMENT_HEADERS, []);
  await workbook.xlsx.writeFile(
    join(packagePath, 'modelo-importacao-atendimentos-whatsapp.xlsx'),
  );
  return { root, packagePath };
}

function readOnlyPrisma(writeAttempt: ReturnType<typeof vi.fn>): PrismaService {
  const noRows = vi.fn().mockResolvedValue([]);
  return {
    company: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: testCompanyId, status: 'ACTIVE' }),
      create: writeAttempt,
      update: writeAttempt,
      delete: writeAttempt,
    },
    whatsAppChannel: {
      findUnique: vi.fn().mockResolvedValue({
        id: testChannelId,
        phoneNumber: '553474009517',
        enabled: true,
      }),
      create: writeAttempt,
      update: writeAttempt,
      delete: writeAttempt,
    },
    user: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'actor',
        status: UserAccountStatus.ACTIVE,
        isActive: true,
      }),
      findMany: noRows,
      create: writeAttempt,
      update: writeAttempt,
      delete: writeAttempt,
    },
    tenantDepartment: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ code: DepartmentCode.COMMERCIAL }]),
      create: writeAttempt,
      update: writeAttempt,
      delete: writeAttempt,
    },
    whatsAppContact: {
      findMany: noRows,
      create: writeAttempt,
      update: writeAttempt,
      upsert: writeAttempt,
      delete: writeAttempt,
    },
    whatsAppImportExternalRef: {
      findMany: noRows,
      create: writeAttempt,
      update: writeAttempt,
      upsert: writeAttempt,
      delete: writeAttempt,
    },
    whatsAppConversation: {
      findMany: noRows,
      create: writeAttempt,
      update: writeAttempt,
      upsert: writeAttempt,
      delete: writeAttempt,
    },
    quoteRequest: {
      findMany: noRows,
      create: writeAttempt,
      update: writeAttempt,
      upsert: writeAttempt,
      delete: writeAttempt,
    },
    whatsAppMessage: {
      findMany: noRows,
      create: writeAttempt,
      update: writeAttempt,
      upsert: writeAttempt,
      delete: writeAttempt,
    },
    quoteProposalDocument: {
      findMany: noRows,
      create: writeAttempt,
      update: writeAttempt,
      upsert: writeAttempt,
      delete: writeAttempt,
    },
    integrationOutbox: {
      create: writeAttempt,
      update: writeAttempt,
      upsert: writeAttempt,
      delete: writeAttempt,
    },
    quoteNotificationRead: {
      create: writeAttempt,
      update: writeAttempt,
      upsert: writeAttempt,
      delete: writeAttempt,
    },
    $transaction: writeAttempt,
  } as unknown as PrismaService;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('WhatsAppImportService.validate', () => {
  it('faz dry-run com zero writes, zero outbox e relatório JSON seguro', async () => {
    const fixture = await packageWithRows({
      conversations: [conversationRow('legacy-1')],
    });
    const writeAttempt = vi.fn(() => {
      throw new Error('write não permitido no dry-run');
    });
    const service = new WhatsAppImportService(
      readOnlyPrisma(writeAttempt),
      fixture.root,
    );

    const report = await service.validate({
      companyId: testCompanyId,
      channelId: testChannelId,
      actorUsername: 'admin',
      batchName: 'batch',
      packagePath: fixture.packagePath,
      cutoffAt: new Date('2026-07-30T00:00:00.000Z'),
    });

    expect(report.valid).toBe(true);
    expect(report.zeroWrites).toBe(true);
    expect(report.counts.conversationsToCreate).toBe(1);
    expect(JSON.stringify(report)).not.toContain('%PDF-');
    expect(writeAttempt).not.toHaveBeenCalled();
  });

  it('aceita datas de viagem posteriores ao corte da migração', async () => {
    const row = conversationRow('legacy-future-trip');
    row[21] = new Date('2026-08-15T12:00:00.000Z');
    row[22] = new Date('2026-08-16T18:00:00.000Z');
    const fixture = await packageWithRows({ conversations: [row] });
    const writeAttempt = vi.fn(() => {
      throw new Error('write não permitido no dry-run');
    });
    const service = new WhatsAppImportService(
      readOnlyPrisma(writeAttempt),
      fixture.root,
    );

    const report = await service.validate({
      companyId: testCompanyId,
      channelId: testChannelId,
      actorUsername: 'admin',
      batchName: 'batch-future-trip',
      packagePath: fixture.packagePath,
      cutoffAt: new Date('2026-07-30T00:00:00.000Z'),
    });

    expect(report.valid).toBe(true);
    expect(report.zeroWrites).toBe(true);
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({ code: 'DATE_AFTER_CUTOFF' }),
    );
    expect(writeAttempt).not.toHaveBeenCalled();
  });

  it('continua rejeitando confirmação histórica posterior ao corte', async () => {
    const row = conversationRow('legacy-post-cutoff-confirmation');
    row[29] = new Date('2026-07-31T12:00:00.000Z');
    const fixture = await packageWithRows({ conversations: [row] });
    const service = new WhatsAppImportService(
      readOnlyPrisma(vi.fn()),
      fixture.root,
    );

    const report = await service.validate({
      companyId: testCompanyId,
      channelId: testChannelId,
      actorUsername: 'admin',
      batchName: 'batch-post-cutoff-confirmation',
      packagePath: fixture.packagePath,
      cutoffAt: new Date('2026-07-30T00:00:00.000Z'),
    });

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'DATE_AFTER_CUTOFF',
        message: 'confirmed_at é posterior ao horário de corte.',
      }),
    );
  });

  it('rejeita duas novas conversas abertas do mesmo telefone no próprio lote', async () => {
    const fixture = await packageWithRows({
      conversations: [conversationRow('legacy-1'), conversationRow('legacy-2')],
    });
    const service = new WhatsAppImportService(
      readOnlyPrisma(vi.fn()),
      fixture.root,
    );

    const report = await service.validate({
      companyId: testCompanyId,
      channelId: testChannelId,
      actorUsername: 'admin',
      batchName: 'batch',
      packagePath: fixture.packagePath,
    });

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'SECOND_OPEN_CONVERSATION_IN_BATCH',
      }),
    );
  });

  it('rejeita duas conversas fechadas do mesmo contato no lote de estado atual', async () => {
    const first = conversationRow('legacy-1');
    const second = conversationRow('legacy-2');
    for (const row of [first, second]) {
      row[7] = 'closed';
      row[8] = 'closed';
      row[9] = 'rejected';
    }
    const fixture = await packageWithRows({
      conversations: [first, second],
    });
    const service = new WhatsAppImportService(
      readOnlyPrisma(vi.fn()),
      fixture.root,
    );

    const report = await service.validate({
      companyId: testCompanyId,
      channelId: testChannelId,
      actorUsername: 'admin',
      batchName: 'batch',
      packagePath: fixture.packagePath,
    });

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'DUPLICATE_PHONE_IN_BATCH' }),
    );
  });

  it('reporta data inválida sem lançar RangeError ao calcular hash', async () => {
    const message = blanks(MESSAGE_HEADERS.length);
    message[0] = 'legacy-1';
    message[1] = 'legacy-message-1';
    message[2] = 'inbound';
    message[3] = 'text';
    message[4] = 'não é data Excel';
    message[5] = 'received';
    message[6] = 'Olá';
    const fixture = await packageWithRows({
      conversations: [conversationRow('legacy-1')],
      messages: [message],
    });
    const service = new WhatsAppImportService(
      readOnlyPrisma(vi.fn()),
      fixture.root,
    );

    const report = await service.validate({
      companyId: testCompanyId,
      channelId: testChannelId,
      actorUsername: 'admin',
      batchName: 'batch',
      packagePath: fixture.packagePath,
    });

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'INVALID_OCCURRED_AT' }),
    );
  });

  it('aceita mensagem sem corpo quando o conteúdo não foi identificado', async () => {
    const message = blanks(MESSAGE_HEADERS.length);
    message[0] = 'legacy-1';
    message[1] = 'legacy-message-empty';
    message[2] = 'inbound';
    message[3] = 'unknown';
    message[4] = new Date('2026-07-29T12:00:00.000Z');
    message[5] = 'received';
    const fixture = await packageWithRows({
      conversations: [conversationRow('legacy-1')],
      messages: [message],
    });
    const service = new WhatsAppImportService(
      readOnlyPrisma(vi.fn()),
      fixture.root,
    );

    const report = await service.validate({
      companyId: testCompanyId,
      channelId: testChannelId,
      actorUsername: 'admin',
      batchName: 'batch-empty-message',
      packagePath: fixture.packagePath,
      cutoffAt: new Date('2026-07-30T00:00:00.000Z'),
    });

    expect(report.valid).toBe(true);
    expect(report.issues).not.toContainEqual(
      expect.objectContaining({ code: 'TEXT_REQUIRED' }),
    );
  });

  it('rejeita códigos de departamento fora dos nove publicados', async () => {
    const row = conversationRow('legacy-1');
    row[5] = 'information-technology';
    const fixture = await packageWithRows({ conversations: [row] });
    const service = new WhatsAppImportService(
      readOnlyPrisma(vi.fn()),
      fixture.root,
    );

    const report = await service.validate({
      companyId: testCompanyId,
      channelId: testChannelId,
      actorUsername: 'admin',
      batchName: 'batch',
      packagePath: fixture.packagePath,
    });

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: 'INVALID_DEPARTMENT' }),
    );
  });

  it('preserva o nome live de contato sem referência externa e não anuncia atualização', async () => {
    const fixture = await packageWithRows({
      conversations: [conversationRow('legacy-1')],
    });
    const writeAttempt = vi.fn(() => {
      throw new Error('write não permitido no dry-run');
    });
    const prisma = readOnlyPrisma(writeAttempt);
    Object.assign(prisma.whatsAppContact, {
      findMany: vi.fn().mockResolvedValue([
        {
          id: '00000000-0000-4000-8000-000000000003',
          phoneNormalized: '553496305110',
          displayName: 'Nome atual do contato',
          updatedAt: new Date('2026-07-29T20:00:00.000Z'),
        },
      ]),
    });
    const service = new WhatsAppImportService(prisma, fixture.root);

    const report = await service.validate({
      companyId: testCompanyId,
      channelId: testChannelId,
      actorUsername: 'admin',
      batchName: 'batch',
      packagePath: fixture.packagePath,
      cutoffAt: new Date('2026-07-29T19:00:00.000Z'),
    });

    expect(report.valid).toBe(true);
    expect(report.counts).toMatchObject({
      contactsToCreate: 0,
      contactsToUpdate: 0,
      conversationsToCreate: 1,
    });
    expect(writeAttempt).not.toHaveBeenCalled();
  });
});

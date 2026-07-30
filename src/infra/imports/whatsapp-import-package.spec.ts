import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS, { type Worksheet } from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CONVERSATION_HEADERS,
  DOCUMENT_HEADERS,
  MESSAGE_HEADERS,
} from './whatsapp-import.types';
import { parseWhatsAppImportPackage } from './whatsapp-import-package';

const temporaryRoots: string[] = [];

function blankRow(length: number): unknown[] {
  return Array.from({ length }, () => null);
}

function addImportTable(
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

async function createPackage(options?: {
  conversations?: unknown[][];
  messages?: unknown[][];
  documents?: unknown[][];
  outsideConversationRow?: unknown[];
  tableOnWrongSheet?: boolean;
  pdfContent?: Buffer;
}): Promise<{ root: string; packagePath: string; workbookPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'lume-whatsapp-import-'));
  temporaryRoots.push(root);
  const packagePath = join(root, 'batch');
  const filesPath = join(packagePath, 'files');
  await mkdir(filesPath, { recursive: true });
  if (options?.pdfContent) {
    await writeFile(join(filesPath, 'proposal.pdf'), options.pdfContent);
  }
  const workbook = new ExcelJS.Workbook();
  const conversations = workbook.addWorksheet('Atendimentos');
  const messages = workbook.addWorksheet('Mensagens');
  const documents = workbook.addWorksheet('Documentos');
  if (options?.tableOnWrongSheet) {
    addImportTable(
      conversations,
      'MensagensImportacao',
      MESSAGE_HEADERS,
      options.messages ?? [],
    );
    addImportTable(
      messages,
      'AtendimentosImportacao',
      CONVERSATION_HEADERS,
      options.conversations ?? [],
    );
  } else {
    addImportTable(
      conversations,
      'AtendimentosImportacao',
      CONVERSATION_HEADERS,
      options?.conversations ?? [],
    );
    addImportTable(
      messages,
      'MensagensImportacao',
      MESSAGE_HEADERS,
      options?.messages ?? [],
    );
  }
  addImportTable(
    documents,
    'DocumentosImportacao',
    DOCUMENT_HEADERS,
    options?.documents ?? [],
  );
  if (options?.outsideConversationRow) {
    conversations.addRow(options.outsideConversationRow);
  }
  const workbookPath = join(
    packagePath,
    'modelo-importacao-atendimentos-whatsapp.xlsx',
  );
  await workbook.xlsx.writeFile(workbookPath);
  return { root, packagePath, workbookPath };
}

function validConversationRow(
  externalConversationId = 'legacy-conversation-1',
): unknown[] {
  const row = blankRow(CONVERSATION_HEADERS.length);
  row[0] = externalConversationId;
  row[1] = 'legacy-system';
  row[2] = '553496305110';
  row[3] = 'Cliente legado';
  row[4] = '553474009517';
  row[5] = 'commercial';
  row[7] = 'bot-active';
  row[8] = 'main-menu';
  row[9] = 'not-started';
  row[10] = new Date(Date.UTC(2026, 6, 29, 12, 0, 0));
  row[12] = 0;
  row[18] = 'unknown';
  row[25] = 'desconhecido';
  row[26] = 'desconhecido';
  row[32] = 'upsert';
  return row;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('parseWhatsAppImportPackage', () => {
  it('aceita o pacote oficial vazio sem importar as fórmulas de validação', async () => {
    const fixture = await createPackage();

    const parsed = await parseWhatsAppImportPackage({
      importsRoot: fixture.root,
      packagePath: fixture.packagePath,
    });

    expect(parsed.conversations).toEqual([]);
    expect(parsed.messages).toEqual([]);
    expect(parsed.documents).toEqual([]);
  });

  it('bloqueia expansão ZIP declarada antes de carregar o XLSX no JSZip', async () => {
    const fixture = await createPackage();
    const workbook = await readFile(fixture.workbookPath);
    const centralHeaderOffset = workbook.indexOf(
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
    );
    expect(centralHeaderOffset).toBeGreaterThanOrEqual(0);
    workbook.writeUInt32LE(64 * 1024 * 1024 + 1, centralHeaderOffset + 24);
    await writeFile(fixture.workbookPath, workbook);

    await expect(
      parseWhatsAppImportPackage({
        importsRoot: fixture.root,
        packagePath: fixture.packagePath,
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'XLSX_EXPANSION_LIMIT_EXCEEDED',
        }),
      ]),
    });
  });

  it('lê somente linhas dentro do ref da tabela nomeada', async () => {
    const fixture = await createPackage({
      conversations: [validConversationRow('inside-table')],
      outsideConversationRow: validConversationRow('outside-table'),
    });

    const parsed = await parseWhatsAppImportPackage({
      importsRoot: fixture.root,
      packagePath: fixture.packagePath,
    });

    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0].externalConversationId).toBe('inside-table');
  });

  it('rejeita uma tabela oficial relacionada à aba errada', async () => {
    const fixture = await createPackage({ tableOnWrongSheet: true });

    await expect(
      parseWhatsAppImportPackage({
        importsRoot: fixture.root,
        packagePath: fixture.packagePath,
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'TABLE_ON_WRONG_SHEET' }),
      ]),
    });
  });

  it('valida caminho, MIME, assinatura e hash do PDF dentro de files', async () => {
    const conversation = validConversationRow();
    conversation[8] = 'commercial-follow-up-menu';
    conversation[9] = 'under-review';
    conversation[13] = 1;
    const document = blankRow(DOCUMENT_HEADERS.length);
    document[0] = 'legacy-conversation-1';
    document[1] = 1;
    document[2] = 'legacy-document-1';
    document[3] = 'proposal.pdf';
    document[4] = 'files/proposal.pdf';
    document[5] = 'application/pdf';
    document[6] = 'uploaded';
    const fixture = await createPackage({
      conversations: [conversation],
      documents: [document],
      pdfContent: Buffer.from('%PDF-1.7\nfixture\n%%EOF'),
    });

    const parsed = await parseWhatsAppImportPackage({
      importsRoot: fixture.root,
      packagePath: fixture.packagePath,
    });

    expect(parsed.documents).toEqual([
      expect.objectContaining({
        externalDocumentId: 'legacy-document-1',
        mimeType: 'application/pdf',
        sizeBytes: 22,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
  });

  it('rejeita PDF fora de files e não expõe seus bytes no erro', async () => {
    const document = blankRow(DOCUMENT_HEADERS.length);
    document[0] = 'legacy-conversation-1';
    document[1] = 1;
    document[2] = 'legacy-document-unsafe';
    document[3] = 'proposal.pdf';
    document[4] = '../proposal.pdf';
    document[5] = 'application/pdf';
    document[6] = 'uploaded';
    const fixture = await createPackage({
      conversations: [validConversationRow()],
      documents: [document],
    });

    await expect(
      parseWhatsAppImportPackage({
        importsRoot: fixture.root,
        packagePath: fixture.packagePath,
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_DOCUMENT_PATH' }),
      ]),
    });
  });

  it('rejeita a pasta files quando ela e um link para fora do pacote', async () => {
    const conversation = validConversationRow();
    conversation[8] = 'commercial-follow-up-menu';
    conversation[9] = 'under-review';
    conversation[13] = 1;
    const document = blankRow(DOCUMENT_HEADERS.length);
    document[0] = 'legacy-conversation-1';
    document[1] = 1;
    document[2] = 'legacy-document-linked';
    document[3] = 'proposal.pdf';
    document[4] = 'files/proposal.pdf';
    document[5] = 'application/pdf';
    document[6] = 'uploaded';
    const fixture = await createPackage({
      conversations: [conversation],
      documents: [document],
    });
    const outside = join(fixture.root, 'outside-files');
    await mkdir(outside);
    await writeFile(
      join(outside, 'proposal.pdf'),
      Buffer.from('%PDF-1.7\noutside\n%%EOF'),
    );
    await rm(join(fixture.packagePath, 'files'), {
      recursive: true,
      force: true,
    });
    await symlink(outside, join(fixture.packagePath, 'files'), 'junction');

    await expect(
      parseWhatsAppImportPackage({
        importsRoot: fixture.root,
        packagePath: fixture.packagePath,
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'INVALID_DOCUMENT_PATH' }),
      ]),
    });
  });
});

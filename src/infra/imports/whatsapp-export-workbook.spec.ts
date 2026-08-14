import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { parseWhatsAppExportArchive } from './whatsapp-export-parser';
import {
  createWhatsAppImportWorkbook,
  type WhatsAppHistoryConversationMapping,
} from './whatsapp-export-workbook';

async function parsed(
  name: string,
  customer: string,
  company: string,
  minute: number,
) {
  const zip = new JSZip();
  zip.file(
    `Conversa do WhatsApp com ${customer}.txt`,
    [
      `12/08/2026 09:${String(minute).padStart(2, '0')} - ${customer}: Oi`,
      `12/08/2026 09:${String(minute + 1).padStart(2, '0')} - ${company}: Olá`,
    ].join('\n'),
  );
  return parseWhatsAppExportArchive(
    name,
    await zip.generateAsync({ type: 'nodebuffer' }),
  );
}

describe('createWhatsAppImportWorkbook', () => {
  it('consolida conversas sem misturar mensagens e usa o modelo oficial', async () => {
    const first = await parsed('cliente-a.zip', 'Cliente A', 'Milenium', 0);
    const second = await parsed('cliente-b.zip', 'Cliente B', 'Milenium', 10);
    const mappings: WhatsAppHistoryConversationMapping[] = [
      {
        archiveId: first.archiveId,
        phoneE164: '5534999990001',
        contactName: 'Cliente A',
        companySenderName: 'Milenium',
        state: 'human-queue',
        departmentCode: 'commercial',
      },
      {
        archiveId: second.archiveId,
        phoneE164: '5534999990002',
        contactName: 'Cliente B',
        companySenderName: 'Milenium',
        state: 'closed',
        departmentCode: 'commercial',
      },
    ];

    const generated = await createWhatsAppImportWorkbook(
      [first, second],
      mappings,
      '553432236060',
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(generated.content);

    expect(generated).toMatchObject({
      conversationCount: 2,
      messageCount: 4,
      attachmentCount: 0,
    });
    expect(
      workbook.getWorksheet('Atendimentos')?.getTable('AtendimentosImportacao'),
    ).toBeTruthy();
    expect(
      workbook.getWorksheet('Mensagens')?.getTable('MensagensImportacao'),
    ).toBeTruthy();
    expect(
      workbook.getWorksheet('Documentos')?.getTable('DocumentosImportacao'),
    ).toBeTruthy();
    const conversationIds = [
      workbook.getWorksheet('Mensagens')?.getCell('A2').text,
      workbook.getWorksheet('Mensagens')?.getCell('A3').text,
      workbook.getWorksheet('Mensagens')?.getCell('A4').text,
      workbook.getWorksheet('Mensagens')?.getCell('A5').text,
    ];
    expect(new Set(conversationIds).size).toBe(2);
    expect(conversationIds[0]).toBe(conversationIds[1]);
    expect(conversationIds[2]).toBe(conversationIds[3]);
  });

  it('gera os mesmos identificadores em uma repetição da importação', async () => {
    const conversation = await parsed('cliente.zip', 'Cliente', 'Milenium', 0);
    const mapping: WhatsAppHistoryConversationMapping = {
      archiveId: conversation.archiveId,
      phoneE164: '5534999990001',
      contactName: 'Cliente',
      companySenderName: 'Milenium',
      state: 'human-queue',
      departmentCode: 'commercial',
    };
    const first = await createWhatsAppImportWorkbook(
      [conversation],
      [mapping],
      '553432236060',
    );
    const second = await createWhatsAppImportWorkbook(
      [conversation],
      [mapping],
      '553432236060',
    );
    const firstWorkbook = new ExcelJS.Workbook();
    const secondWorkbook = new ExcelJS.Workbook();
    await firstWorkbook.xlsx.load(first.content);
    await secondWorkbook.xlsx.load(second.content);

    expect(firstWorkbook.getWorksheet('Mensagens')?.getCell('B2').text).toBe(
      secondWorkbook.getWorksheet('Mensagens')?.getCell('B2').text,
    );
    expect(first.content.equals(second.content)).toBe(true);
  });
});

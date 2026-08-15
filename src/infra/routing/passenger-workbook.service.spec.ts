import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { PassengerWorkbookService } from './passenger-workbook.service';

describe('PassengerWorkbookService', () => {
  it('creates an official blank import sheet and keeps the example separate', async () => {
    const service = new PassengerWorkbookService();
    const content = await service.createTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer,
    );

    expect(workbook.getWorksheet('Colaboradores')?.actualRowCount).toBe(1);
    expect(workbook.getWorksheet('Exemplo')?.actualRowCount).toBe(2);
    expect(workbook.getWorksheet('Instrucoes')).toBeDefined();
  });

  it('parses a filled official model with company CNPJ and configurable documents', async () => {
    const service = new PassengerWorkbookService();
    const template = await service.createTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      template.buffer.slice(
        template.byteOffset,
        template.byteOffset + template.byteLength,
      ) as ArrayBuffer,
    );
    const dataSheet = workbook.getWorksheet('Colaboradores');
    if (!dataSheet) throw new Error('Aba Colaboradores ausente.');
    dataSheet.getRow(2).values = [
      '12.345.678/0001-95',
      'COL-01',
      'Turno A',
      '07:00',
      'Operacao',
      'Ana Souza',
      'Rua A',
      '10',
      '',
      'Centro',
      '38400000',
      'Uberlandia',
      'MG',
      'Sim',
      'Priorizar embarque proximo',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      -18.91,
      -48.27,
      '',
      '',
      '[{"tipo":"atf-data","dados":{"referencia":"A1"}}]',
    ];
    const rows = await service.parse(
      Buffer.from(await workbook.xlsx.writeBuffer()),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyTaxId: '12.345.678/0001-95',
      fullName: 'Ana Souza',
      accessibilityRequired: true,
      documents: [
        {
          documentTypeCode: 'atf-data',
          data: { referencia: 'A1' },
        },
      ],
    });
  });
});

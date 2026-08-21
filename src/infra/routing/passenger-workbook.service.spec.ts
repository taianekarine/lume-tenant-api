import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { PassengerWorkbookService } from './passenger-workbook.service';
import { DataExchangeConverter } from '../data-exchange/data-exchange-converter';

const service = () => new PassengerWorkbookService(new DataExchangeConverter());

describe('PassengerWorkbookService', () => {
  it('creates an official blank import sheet and keeps the example separate', async () => {
    const workbookService = service();
    const content = await workbookService.createTemplate();
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
    expect(workbook.getWorksheet('Pontos fixos')).toBeDefined();
  });

  it('parses the simple model without client tax id, coordinates or JSON', async () => {
    const workbookService = service();
    const template = await workbookService.createTemplate();
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
      'Ana Souza',
      'COL-01',
      'Turno A',
      '07:00',
      'Operacao',
      'Rua A',
      '10',
      '',
      'Centro',
      '38400000',
      'Uberlandia',
      'MG',
      'Sim',
      'Priorizar embarque proximo',
      'PF-ABC12345',
      '12345678909',
      'MAT-01',
      'Conferido pelo cliente',
    ];
    const rows = await workbookService.parse(
      Buffer.from(await workbook.xlsx.writeBuffer()),
      'modelo-colaboradores.xlsx',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fullName: 'Ana Souza',
      accessibilityRequired: true,
      fixedPointCode: 'PF-ABC12345',
      residenceLatitude: null,
      residenceLongitude: null,
      documents: [
        {
          documentTypeCode: 'cpf',
          data: { numero: '12345678909' },
        },
        { documentTypeCode: 'matricula', data: { numero: 'MAT-01' } },
        {
          documentTypeCode: 'observacoes-documentais',
          data: { observacoes: 'Conferido pelo cliente' },
        },
      ],
    });
  });
});

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../core/errors/app-error';
import { DataExchangeConverter } from './data-exchange-converter';

describe('DataExchangeConverter', () => {
  const converter = new DataExchangeConverter();

  it('converte CSV para XLSX e XLSX para CSV/TSV', async () => {
    const xlsx = await converter.convert(
      'csv',
      'xlsx',
      Buffer.from('nome,quantidade\nÔnibus,2\n', 'utf8'),
    );
    expect(xlsx.mimeType).toContain('spreadsheetml');
    expect(xlsx.content.subarray(0, 4).toString('hex')).toBe('504b0304');

    const csv = await converter.convert('xlsx', 'csv', xlsx.content);
    const tsv = await converter.convert('xlsx', 'tsv', xlsx.content);
    expect(csv.content.toString('utf8')).toContain('Ônibus,2');
    expect(tsv.content.toString('utf8')).toContain('Ônibus\t2');
  });

  it('neutraliza fórmula em texto sem alterar números negativos ou resultados calculados', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dados');
    sheet.addRow([
      '=HYPERLINK("https://example.test")',
      -42,
      {
        formula: '40+2',
        result: 42,
      },
    ]);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    const csv = await converter.convert('xlsx', 'csv', xlsx);
    expect(csv.content.toString('utf8')).toContain(
      `"'=HYPERLINK(""https://example.test"")",-42,42`,
    );
  });

  it('normaliza PDF para PDF sem modificar os bytes', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    const result = await converter.convert('pdf', 'pdf', pdf);
    expect(result.content.equals(pdf)).toBe(true);
    expect(result.mimeType).toBe('application/pdf');
  });

  it('rejeita conversão sem adaptador e XLSX estruturalmente inválido', async () => {
    await expect(
      converter.convert('pdf', 'xlsx', Buffer.from('%PDF-1.4\n%%EOF\n')),
    ).rejects.toMatchObject<AppError>({
      code: 'CONVERSION_NOT_SUPPORTED',
    });
    await expect(
      converter.convert('xlsx', 'csv', Buffer.from('PK\u0003\u0004broken')),
    ).rejects.toMatchObject<AppError>({
      code: 'UNSUPPORTED_FILE_FORMAT',
    });

    const validWorkbook = new ExcelJS.Workbook();
    validWorkbook.addWorksheet('Dados').addRow(['ok']);
    const validBytes = Buffer.from(await validWorkbook.xlsx.writeBuffer());
    await expect(
      converter.convert('xlsx', 'xlsx', validBytes),
    ).resolves.toMatchObject({ format: 'xlsx' });
  });

  it('rejeita XLSX malformado também na validação anterior ao armazenamento', async () => {
    await expect(
      converter.validate('xlsx', Buffer.from('PK\u0003\u0004broken')),
    ).rejects.toMatchObject<AppError>({
      code: 'UNSUPPORTED_FILE_FORMAT',
    });
  });

  it('neutraliza fórmulas com espaços, rich text e hyperlink', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dados');
    sheet.addRow([
      '  =1+1',
      { richText: [{ text: '@SUM(A1:A2)' }] },
      {
        text: '+IMPORTXML("https://example.test")',
        hyperlink: 'https://example.test',
      },
    ]);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
    const csv = await converter.convert('xlsx', 'csv', xlsx);
    const text = csv.content.toString('utf8');
    expect(text).toContain("'  =1+1");
    expect(text).toContain("'@SUM(A1:A2)");
    expect(text).toContain("'+IMPORTXML");
  });

  it('exige a escolha explícita da aba ao exportar XLSX multiaba', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Primeira').addRow(['primeira']);
    workbook.addWorksheet('Segunda').addRow(['segunda']);
    const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(
      converter.convert('xlsx', 'csv', xlsx),
    ).rejects.toMatchObject<AppError>({
      code: 'UNSUPPORTED_FILE_FORMAT',
    });
    const selected = await converter.convert('xlsx', 'csv', xlsx, {
      sheetName: 'Segunda',
    });
    expect(selected.content.toString('utf8')).toContain('segunda');
    expect(selected.content.toString('utf8')).not.toContain('primeira');
  });
});

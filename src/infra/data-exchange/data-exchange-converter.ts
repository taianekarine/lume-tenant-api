import { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import ExcelJS, { type CellValue, type Worksheet } from 'exceljs';

import {
  assertConversionSupported,
  type DataExchangeFormat,
} from '../../domain/data-exchange/data-exchange-capabilities';
import { unsupportedFileFormat } from '../../core/errors/app-error';
import {
  preflightXlsxArchive,
  WhatsAppImportPackageError,
} from '../imports/whatsapp-import-package';

export interface ConvertedDataExchangeFile {
  content: Buffer;
  extension: DataExchangeFormat;
  format: DataExchangeFormat;
  mimeType: string;
}

const mimeByFormat: Readonly<Record<DataExchangeFormat, string>> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
};

const MAX_DELIMITED_ROWS = 50_000;
const MAX_DELIMITED_COLUMNS = 200;
const MAX_DELIMITED_CELLS = 1_000_000;
const MAX_CELL_CHARACTERS = 100_000;
const FORMULA_PREFIXES = new Set(['=', '+', '-', '@']);

function startsWithFormula(text: string): boolean {
  let index = 0;
  while (index < text.length && text.charCodeAt(index) <= 32) index += 1;
  return FORMULA_PREFIXES.has(text[index] ?? '');
}

function rawCellText(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if ('result' in value) return rawCellText(value.result);
  if ('richText' in value) {
    return value.richText.map((part) => part.text).join('');
  }
  if ('text' in value) return value.text;
  if ('error' in value) return value.error;
  return JSON.stringify(value);
}

function cellText(value: CellValue): string {
  if (
    value === null ||
    value === undefined ||
    value instanceof Date ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return rawCellText(value);
  }
  if (typeof value === 'object' && 'result' in value) {
    return cellText(value.result);
  }
  const text = rawCellText(value);
  return startsWithFormula(text) ? `'${text}` : text;
}

function delimitedValue(value: string, delimiter: ',' | '\t'): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\r') ||
    value.includes('\n')
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function worksheetToDelimited(
  worksheet: Worksheet,
  delimiter: ',' | '\t',
): Buffer {
  const rows: string[] = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const lastColumn = Math.max(worksheet.columnCount, row.cellCount);
    const values: string[] = [];
    for (let column = 1; column <= lastColumn; column += 1) {
      values.push(
        delimitedValue(cellText(row.getCell(column).value), delimiter),
      );
    }
    rows.push(values.join(delimiter));
  });
  return Buffer.from(`${rows.join('\r\n')}\r\n`, 'utf8');
}

@Injectable()
export class DataExchangeConverter {
  async validate(
    sourceFormat: DataExchangeFormat,
    content: Buffer,
  ): Promise<void> {
    if (sourceFormat === 'xlsx') {
      await this.loadXlsx(content);
    } else if (sourceFormat === 'csv' || sourceFormat === 'tsv') {
      await this.loadDelimited(sourceFormat, content);
    }
  }

  async convert(
    sourceFormat: DataExchangeFormat,
    targetFormat: DataExchangeFormat,
    content: Buffer,
    options: { sheetName?: string | null } = {},
  ): Promise<ConvertedDataExchangeFile> {
    assertConversionSupported(sourceFormat, targetFormat);

    if (sourceFormat === targetFormat) {
      await this.validate(sourceFormat, content);
      return {
        content: Buffer.from(content),
        extension: targetFormat,
        format: targetFormat,
        mimeType: mimeByFormat[targetFormat],
      };
    }

    if (sourceFormat === 'pdf') {
      // A matriz rejeita este caminho antes daqui. A guarda também mantém o
      // estreitamento de tipo explícito para novos adaptadores.
      assertConversionSupported(sourceFormat, targetFormat);
      throw new Error('Conversão PDF inesperada após validação de capacidade.');
    }

    const workbook =
      sourceFormat === 'xlsx'
        ? await this.loadXlsx(content)
        : await this.loadDelimited(sourceFormat, content);

    if (targetFormat === 'xlsx') {
      const output = await workbook.xlsx.writeBuffer();
      return {
        content: Buffer.from(output),
        extension: 'xlsx',
        format: 'xlsx',
        mimeType: mimeByFormat.xlsx,
      };
    }

    const requestedSheetName = options.sheetName?.trim() || null;
    if (
      sourceFormat === 'xlsx' &&
      workbook.worksheets.length > 1 &&
      !requestedSheetName
    ) {
      throw unsupportedFileFormat(
        'A planilha possui múltiplas abas. Informe sheetName para exportar CSV ou TSV sem perda silenciosa de dados.',
        {
          sourceFormat,
          targetFormat,
          availableSheets: workbook.worksheets.map((sheet) => sheet.name),
        },
      );
    }
    const worksheet = requestedSheetName
      ? workbook.getWorksheet(requestedSheetName)
      : workbook.worksheets[0];
    if (!worksheet) {
      throw unsupportedFileFormat(
        'A planilha XLSX não possui uma aba exportável.',
        { sourceFormat, targetFormat },
      );
    }
    return {
      content: worksheetToDelimited(
        worksheet,
        targetFormat === 'csv' ? ',' : '\t',
      ),
      extension: targetFormat,
      format: targetFormat,
      mimeType: mimeByFormat[targetFormat],
    };
  }

  private async loadXlsx(content: Buffer): Promise<ExcelJS.Workbook> {
    try {
      preflightXlsxArchive(content);
      const workbook = new ExcelJS.Workbook();
      const normalizedArrayBuffer = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
      await workbook.xlsx.load(normalizedArrayBuffer);
      return workbook;
    } catch (error) {
      const structuralReason =
        error instanceof WhatsAppImportPackageError
          ? error.issues[0]?.code
          : undefined;
      throw unsupportedFileFormat(
        'A planilha XLSX é inválida, insegura ou excede os limites estruturais.',
        { format: 'xlsx', structuralReason },
      );
    }
  }

  private async loadDelimited(
    format: 'csv' | 'tsv',
    content: Buffer,
  ): Promise<ExcelJS.Workbook> {
    const text = content.toString('utf8');
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.at(-1) === '') lines.pop();
    if (lines.length > MAX_DELIMITED_ROWS) {
      throw unsupportedFileFormat(
        `A planilha excede o limite de ${MAX_DELIMITED_ROWS} linhas.`,
        { format, rows: lines.length },
      );
    }
    const delimiter = format === 'csv' ? ',' : '\t';
    let totalCells = 0;
    for (const line of lines) {
      const columns = line.split(delimiter);
      if (columns.length > MAX_DELIMITED_COLUMNS) {
        throw unsupportedFileFormat(
          `A planilha excede o limite de ${MAX_DELIMITED_COLUMNS} colunas.`,
          { format, columns: columns.length },
        );
      }
      if (columns.some((cell) => cell.length > MAX_CELL_CHARACTERS)) {
        throw unsupportedFileFormat(
          `Uma célula excede o limite de ${MAX_CELL_CHARACTERS} caracteres.`,
          { format },
        );
      }
      totalCells += columns.length;
      if (totalCells > MAX_DELIMITED_CELLS) {
        throw unsupportedFileFormat(
          `A planilha excede o limite de ${MAX_DELIMITED_CELLS} células.`,
          { format, cells: totalCells },
        );
      }
    }
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.csv.read(Readable.from([content]), {
        parserOptions: { delimiter },
      });
      return workbook;
    } catch {
      throw unsupportedFileFormat(
        `A planilha ${format.toUpperCase()} não pôde ser interpretada.`,
        { format },
      );
    }
  }
}

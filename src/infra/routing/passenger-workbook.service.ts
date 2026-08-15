import { Injectable } from '@nestjs/common';
import ExcelJS, { type Cell, type Worksheet } from 'exceljs';

import { validationError } from '../../core/errors/app-error';
import type { PassengerDocumentInput } from '../../domain/routing/passenger';

const TEMPLATE_SHEET = 'Colaboradores';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10_000;

export const PASSENGER_TEMPLATE_HEADERS = [
  'CNPJ da empresa',
  'Codigo externo',
  'Turno',
  'Horario de chegada',
  'Setor',
  'Nome completo',
  'Logradouro',
  'Numero',
  'Complemento',
  'Bairro',
  'CEP',
  'Cidade',
  'UF',
  'Necessita acessibilidade',
  'Observacao de acessibilidade',
  'Ponto de embarque - nome',
  'Ponto de embarque - logradouro',
  'Ponto de embarque - numero',
  'Ponto de embarque - complemento',
  'Ponto de embarque - bairro',
  'Ponto de embarque - CEP',
  'Ponto de embarque - cidade',
  'Ponto de embarque - UF',
  'Latitude residencial',
  'Longitude residencial',
  'Latitude do ponto de embarque',
  'Longitude do ponto de embarque',
  'Dados documentais (JSON)',
] as const;

export interface PassengerWorkbookRow {
  rowNumber: number;
  companyTaxId: string;
  externalReference: string | null;
  shift: string | null;
  requiredArrivalTime: string | null;
  sector: string | null;
  fullName: string;
  residenceStreet: string | null;
  residenceNumber: string | null;
  residenceComplement: string | null;
  residenceDistrict: string | null;
  residencePostalCode: string | null;
  residenceCity: string | null;
  residenceState: string | null;
  accessibilityRequired: boolean;
  accessibilityNotes: string | null;
  predefinedBoardingLabel: string | null;
  predefinedBoardingStreet: string | null;
  predefinedBoardingNumber: string | null;
  predefinedBoardingComplement: string | null;
  predefinedBoardingDistrict: string | null;
  predefinedBoardingPostalCode: string | null;
  predefinedBoardingCity: string | null;
  predefinedBoardingState: string | null;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
  predefinedBoardingLatitude: number | null;
  predefinedBoardingLongitude: number | null;
  documents: PassengerDocumentInput[];
}

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('pt-BR');
}

function cellText(cell: Cell): string {
  if (cell.value && typeof cell.value === 'object' && 'formula' in cell.value) {
    throw validationError(
      `A planilha contem formula na celula ${cell.address}. Substitua por um valor.`,
    );
  }
  return cell.text.trim();
}

function optionalCell(cell: Cell): string | null {
  return cellText(cell) || null;
}

function numberCell(cell: Cell): number | null {
  const text = cellText(cell).replace(',', '.');
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw validationError(
      `Informe um numero valido na celula ${cell.address}.`,
    );
  }
  return value;
}

function booleanCell(cell: Cell): boolean {
  const value = normalizeHeader(cellText(cell));
  if (!value || ['nao', 'n', 'false', '0'].includes(value)) return false;
  if (['sim', 's', 'true', '1'].includes(value)) return true;
  throw validationError(
    `Use Sim ou Nao para acessibilidade na celula ${cell.address}.`,
  );
}

function documentsCell(cell: Cell): PassengerDocumentInput[] {
  const text = cellText(cell);
  if (!text) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw validationError(
      `Dados documentais invalidos na celula ${cell.address}. Use JSON valido.`,
    );
  }
  if (!Array.isArray(value)) {
    throw validationError(
      `Dados documentais devem ser uma lista na celula ${cell.address}.`,
    );
  }
  return (value as unknown[]).map((entry, index) => {
    const record =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)
        : null;
    const type = record?.tipo;
    const data = record?.dados;
    if (
      !record ||
      typeof type !== 'string' ||
      !/^[a-z][a-z0-9-]{2,79}$/.test(type) ||
      typeof data !== 'object' ||
      data === null ||
      Array.isArray(data)
    ) {
      throw validationError(
        `Documento ${index + 1} invalido na celula ${cell.address}.`,
      );
    }
    return {
      documentTypeCode: type,
      data: data as Readonly<Record<string, unknown>>,
    };
  });
}

function styleTemplateSheet(worksheet: Worksheet): void {
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: PASSENGER_TEMPLATE_HEADERS.length },
  };
  worksheet.properties.defaultRowHeight = 20;
  worksheet.getRow(1).height = 34;
  worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  worksheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF143D59' },
  };
  worksheet.getRow(1).alignment = {
    vertical: 'middle',
    horizontal: 'center',
    wrapText: true,
  };
  const widths = [
    20, 18, 15, 20, 18, 30, 25, 12, 20, 20, 12, 20, 8, 18, 28, 24, 26, 14, 22,
    20, 14, 20, 10, 18, 18, 22, 22, 48,
  ];
  widths.forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
  });
  worksheet.getColumn(1).numFmt = '@';
  worksheet.getColumn(2).numFmt = '@';
  worksheet.getColumn(4).numFmt = '@';
  worksheet.getColumn(11).numFmt = '@';
  worksheet.getColumn(13).numFmt = '@';
  worksheet.getColumn(21).numFmt = '@';
  worksheet.getColumn(23).numFmt = '@';
  const states =
    'AC,AL,AP,AM,BA,CE,DF,ES,GO,MA,MT,MS,MG,PA,PB,PR,PE,PI,RJ,RN,RS,RO,RR,SC,SP,SE,TO';
  for (let row = 2; row <= 1001; row += 1) {
    worksheet.getCell(`N${row}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"Sim,Nao"'],
      showErrorMessage: true,
      errorTitle: 'Valor invalido',
      error: 'Escolha Sim ou Nao.',
    };
    for (const column of ['M', 'W']) {
      worksheet.getCell(`${column}${row}`).dataValidation = {
        type: 'list',
        allowBlank: true,
        formulae: [`"${states}"`],
        showErrorMessage: true,
        errorTitle: 'UF invalida',
        error: 'Escolha uma UF da lista.',
      };
    }
  }
}

@Injectable()
export class PassengerWorkbookService {
  async createTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Lume - Modulo de Roteirizacao';
    workbook.created = new Date('2000-01-01T00:00:00.000Z');
    workbook.modified = new Date('2000-01-01T00:00:00.000Z');
    const worksheet = workbook.addWorksheet(TEMPLATE_SHEET, {
      views: [{ showGridLines: false }],
    });
    worksheet.addRow([...PASSENGER_TEMPLATE_HEADERS]);
    styleTemplateSheet(worksheet);

    const example = workbook.addWorksheet('Exemplo', {
      views: [{ showGridLines: false }],
    });
    example.addRow([...PASSENGER_TEMPLATE_HEADERS]);
    example.addRow([
      '12.345.678/0001-95',
      'COL-0001',
      'Administrativo',
      '08:00',
      'Operacoes',
      'Nome do colaborador',
      'Rua Exemplo',
      '100',
      'Apto 10',
      'Centro',
      '38400000',
      'Uberlandia',
      'MG',
      'Nao',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '[{"tipo":"codigo-configurado","dados":{}}]',
    ]);
    example.getRow(2).font = {
      italic: true,
      color: { argb: 'FF5F6B76' },
    };
    styleTemplateSheet(example);

    const instructions = workbook.addWorksheet('Instrucoes', {
      views: [{ showGridLines: false }],
    });
    instructions.columns = [{ width: 30 }, { width: 100 }];
    instructions.addRows([
      ['Modelo oficial', 'Cadastro e importacao incremental de colaboradores'],
      [
        'Empresa obrigatoria',
        'Preencha o CNPJ da empresa atendida em todas as linhas. Todos os usuarios pertencem a Milenium; o CNPJ identifica o cliente dos colaboradores.',
      ],
      [
        'Importacao parcial',
        'Uma linha com pendencia nao impede as demais. O sistema informa campo, motivo e acao de regularizacao.',
      ],
      [
        'Atualizacao',
        'Codigo externo e a chave preferencial. Sem ele, nome e endereco sao usados para localizar candidatos e conflitos exigem revisao.',
      ],
      [
        'Documentos',
        'Nao ha campos legais inventados. Use uma lista JSON no formato [{"tipo":"codigo-configurado","dados":{}}]. A obrigatoriedade depende da regra da rota.',
      ],
      [
        'Ponto predefinido',
        'Quando informado pela empresa, o ponto e preservado e nunca substituido automaticamente pelo agente.',
      ],
    ]);
    instructions.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    instructions.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF143D59' },
    };
    instructions.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true };
      row.height = 42;
    });
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  async parse(content: Buffer): Promise<PassengerWorkbookRow[]> {
    if (
      content.length < 4 ||
      content.length > MAX_FILE_BYTES ||
      content.subarray(0, 2).toString('ascii') !== 'PK'
    ) {
      throw validationError('Envie um arquivo XLSX valido de ate 10 MB.');
    }
    const workbook = new ExcelJS.Workbook();
    try {
      const normalizedArrayBuffer = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength,
      ) as ArrayBuffer;
      await workbook.xlsx.load(normalizedArrayBuffer);
    } catch {
      throw validationError('Nao foi possivel ler o arquivo XLSX.');
    }
    const worksheet = workbook.getWorksheet(TEMPLATE_SHEET);
    if (!worksheet) {
      throw validationError(`A planilha deve possuir a aba ${TEMPLATE_SHEET}.`);
    }
    if (worksheet.actualRowCount - 1 > MAX_ROWS) {
      throw validationError(`A planilha aceita no maximo ${MAX_ROWS} linhas.`);
    }
    const headerIndex = new Map<string, number>();
    worksheet.getRow(1).eachCell((cell, columnNumber) => {
      headerIndex.set(normalizeHeader(cellText(cell)), columnNumber);
    });
    const requiredHeaders = PASSENGER_TEMPLATE_HEADERS.map(normalizeHeader);
    const missingHeaders = requiredHeaders.filter(
      (header) => !headerIndex.has(header),
    );
    if (missingHeaders.length) {
      throw validationError(
        `Colunas obrigatorias ausentes: ${missingHeaders.join(', ')}.`,
      );
    }
    const column = (header: (typeof PASSENGER_TEMPLATE_HEADERS)[number]) =>
      headerIndex.get(normalizeHeader(header))!;
    const result: PassengerWorkbookRow[] = [];
    for (
      let rowNumber = 2;
      rowNumber <= worksheet.actualRowCount;
      rowNumber += 1
    ) {
      const row = worksheet.getRow(rowNumber);
      const hasContent = requiredHeaders.some((header) =>
        cellText(row.getCell(headerIndex.get(header)!)),
      );
      if (!hasContent) continue;
      result.push({
        rowNumber,
        companyTaxId: cellText(row.getCell(column('CNPJ da empresa'))),
        externalReference: optionalCell(row.getCell(column('Codigo externo'))),
        shift: optionalCell(row.getCell(column('Turno'))),
        requiredArrivalTime: optionalCell(
          row.getCell(column('Horario de chegada')),
        ),
        sector: optionalCell(row.getCell(column('Setor'))),
        fullName: cellText(row.getCell(column('Nome completo'))),
        residenceStreet: optionalCell(row.getCell(column('Logradouro'))),
        residenceNumber: optionalCell(row.getCell(column('Numero'))),
        residenceComplement: optionalCell(row.getCell(column('Complemento'))),
        residenceDistrict: optionalCell(row.getCell(column('Bairro'))),
        residencePostalCode: optionalCell(row.getCell(column('CEP'))),
        residenceCity: optionalCell(row.getCell(column('Cidade'))),
        residenceState: optionalCell(row.getCell(column('UF'))),
        accessibilityRequired: booleanCell(
          row.getCell(column('Necessita acessibilidade')),
        ),
        accessibilityNotes: optionalCell(
          row.getCell(column('Observacao de acessibilidade')),
        ),
        predefinedBoardingLabel: optionalCell(
          row.getCell(column('Ponto de embarque - nome')),
        ),
        predefinedBoardingStreet: optionalCell(
          row.getCell(column('Ponto de embarque - logradouro')),
        ),
        predefinedBoardingNumber: optionalCell(
          row.getCell(column('Ponto de embarque - numero')),
        ),
        predefinedBoardingComplement: optionalCell(
          row.getCell(column('Ponto de embarque - complemento')),
        ),
        predefinedBoardingDistrict: optionalCell(
          row.getCell(column('Ponto de embarque - bairro')),
        ),
        predefinedBoardingPostalCode: optionalCell(
          row.getCell(column('Ponto de embarque - CEP')),
        ),
        predefinedBoardingCity: optionalCell(
          row.getCell(column('Ponto de embarque - cidade')),
        ),
        predefinedBoardingState: optionalCell(
          row.getCell(column('Ponto de embarque - UF')),
        ),
        residenceLatitude: numberCell(
          row.getCell(column('Latitude residencial')),
        ),
        residenceLongitude: numberCell(
          row.getCell(column('Longitude residencial')),
        ),
        predefinedBoardingLatitude: numberCell(
          row.getCell(column('Latitude do ponto de embarque')),
        ),
        predefinedBoardingLongitude: numberCell(
          row.getCell(column('Longitude do ponto de embarque')),
        ),
        documents: documentsCell(
          row.getCell(column('Dados documentais (JSON)')),
        ),
      });
    }
    if (!result.length) {
      throw validationError(
        'A planilha nao possui colaboradores para importar.',
      );
    }
    return result;
  }
}

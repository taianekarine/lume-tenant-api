import { Injectable } from '@nestjs/common';
import ExcelJS, { type Cell, type Worksheet } from 'exceljs';

import { validationError } from '../../core/errors/app-error';
import type { PassengerDocumentInput } from '../../domain/routing/passenger';
import { DataExchangeConverter } from '../data-exchange/data-exchange-converter';

const TEMPLATE_SHEET = 'Colaboradores';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROWS = 10_000;

export const PASSENGER_TEMPLATE_HEADERS = [
  'Nome completo',
  'Identificador do colaborador (opcional)',
  'Turno',
  'Horario de chegada',
  'Setor',
  'Logradouro residencial',
  'Numero residencial',
  'Complemento residencial',
  'Bairro residencial',
  'CEP residencial',
  'Cidade residencial',
  'UF residencial',
  'Necessita acessibilidade',
  'Observacao de acessibilidade',
  'Codigo do ponto de embarque',
  'CPF',
  'Matricula funcional',
  'Observacoes documentais',
] as const;

export interface PassengerWorkbookRow {
  rowNumber: number;
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
  fixedPointCode: string | null;
  residenceLatitude: number | null;
  residenceLongitude: number | null;
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

function booleanCell(cell: Cell): boolean {
  const value = normalizeHeader(cellText(cell));
  if (!value || ['nao', 'n', 'false', '0'].includes(value)) return false;
  if (['sim', 's', 'true', '1'].includes(value)) return true;
  throw validationError(
    `Use Sim ou Nao para acessibilidade na celula ${cell.address}.`,
  );
}

function documents(
  row: ExcelJS.Row,
  column: (header: (typeof PASSENGER_TEMPLATE_HEADERS)[number]) => number,
) {
  const result: PassengerDocumentInput[] = [];
  const cpf = optionalCell(row.getCell(column('CPF')));
  const registration = optionalCell(row.getCell(column('Matricula funcional')));
  const notes = optionalCell(row.getCell(column('Observacoes documentais')));
  if (cpf) result.push({ documentTypeCode: 'cpf', data: { numero: cpf } });
  if (registration) {
    result.push({
      documentTypeCode: 'matricula',
      data: { numero: registration },
    });
  }
  if (notes) {
    result.push({
      documentTypeCode: 'observacoes-documentais',
      data: { observacoes: notes },
    });
  }
  return result;
}

function styleTemplateSheet(worksheet: Worksheet): void {
  worksheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: PASSENGER_TEMPLATE_HEADERS.length },
  };
  worksheet.properties.defaultRowHeight = 22;
  const header = worksheet.getRow(1);
  header.height = 42;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF143D59' },
  };
  header.alignment = {
    vertical: 'middle',
    horizontal: 'center',
    wrapText: true,
  };
  const widths = [
    30, 25, 18, 20, 20, 28, 18, 22, 22, 16, 22, 14, 22, 30, 26, 18, 22, 35,
  ];
  widths.forEach((width, index) => {
    worksheet.getColumn(index + 1).width = width;
  });
  for (const column of [2, 4, 7, 10, 12, 15, 16, 17]) {
    worksheet.getColumn(column).numFmt = '@';
  }
  const states =
    'AC,AL,AP,AM,BA,CE,DF,ES,GO,MA,MT,MS,MG,PA,PB,PR,PE,PI,RJ,RN,RS,RO,RR,SC,SP,SE,TO';
  for (let row = 2; row <= 1001; row += 1) {
    worksheet.getCell(`M${row}`).dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"Sim,Nao"'],
      showErrorMessage: true,
      errorTitle: 'Valor invalido',
      error: 'Escolha Sim ou Nao.',
    };
    worksheet.getCell(`L${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`"${states}"`],
      showErrorMessage: true,
      errorTitle: 'UF invalida',
      error: 'Escolha uma UF da lista.',
    };
  }
}

@Injectable()
export class PassengerWorkbookService {
  constructor(private readonly converter: DataExchangeConverter) {}

  async createTemplate(
    fixedPoints: readonly {
      code: string;
      name: string;
      clientName: string;
      address: string;
    }[] = [],
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Lume - Modulo de Roteirizacao';
    workbook.created = new Date('2000-01-01T00:00:00.000Z');
    workbook.modified = new Date('2000-01-01T00:00:00.000Z');

    const worksheet = workbook.addWorksheet(TEMPLATE_SHEET);
    worksheet.addRow([...PASSENGER_TEMPLATE_HEADERS]);
    styleTemplateSheet(worksheet);

    const example = workbook.addWorksheet('Exemplo');
    example.addRow([...PASSENGER_TEMPLATE_HEADERS]);
    example.addRow([
      'Nome do colaborador',
      'COL-0001',
      'Administrativo',
      '08:00',
      'Operacoes',
      'Rua Exemplo',
      'S/N',
      null,
      'Centro',
      '38400000',
      'Uberlandia',
      'MG',
      'Nao',
      null,
      fixedPoints[0]?.code ?? null,
      '12345678909',
      'MAT-0001',
      null,
    ]);
    example.getRow(2).font = { italic: true, color: { argb: 'FF5F6B76' } };
    styleTemplateSheet(example);

    const points = workbook.addWorksheet('Pontos fixos');
    points.columns = [
      { header: 'Codigo', key: 'code', width: 18 },
      { header: 'Nome do ponto', key: 'name', width: 30 },
      { header: 'Cliente', key: 'clientName', width: 30 },
      { header: 'Endereco', key: 'address', width: 70 },
    ];
    fixedPoints.forEach((point) => points.addRow(point));
    points.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
    points.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    points.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF143D59' },
    };
    points.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true };
    });

    const instructions = workbook.addWorksheet('Instrucoes');
    instructions.columns = [{ width: 30 }, { width: 100 }];
    instructions.addRows([
      [
        'Modelo oficial',
        'Importacao incremental de colaboradores transportados',
      ],
      [
        'Cliente',
        'Escolha o cliente na tela antes de baixar ou importar. Nao repita CPF ou CNPJ na planilha.',
      ],
      [
        'CEP residencial',
        'Informe sempre que disponivel. Se faltar, a linha sera registrada como pendente e podera ser corrigida na tela com consulta automatica ao ViaCEP.',
      ],
      [
        'Ponto de embarque',
        'Use somente o codigo mostrado na aba Pontos fixos. O endereco e as coordenadas pertencem ao cadastro do ponto.',
      ],
      [
        'Identificador',
        'E opcional e identifica o colaborador no sistema do cliente; nao e o codigo do contrato.',
      ],
      [
        'Documentos',
        'Preencha CPF, matricula e observacoes em colunas comuns. Nao e necessario escrever JSON.',
      ],
      [
        'Coordenadas',
        'Latitude e longitude nao fazem parte do preenchimento manual. A aplicacao mantem esses campos internamente quando disponiveis.',
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
      row.height = 44;
    });
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  async parse(
    content: Buffer,
    fileName: string,
  ): Promise<PassengerWorkbookRow[]> {
    if (content.length < 1 || content.length > MAX_FILE_BYTES) {
      throw validationError('Envie uma planilha valida de ate 10 MB.');
    }
    const extension = fileName.split('.').at(-1)?.toLocaleLowerCase('pt-BR');
    const format =
      extension === 'csv' || extension === 'tsv' ? extension : 'xlsx';
    if (!['xlsx', 'csv', 'tsv'].includes(format)) {
      throw validationError('Use uma planilha XLSX, CSV ou TSV.');
    }
    let normalized = content;
    if (format === 'csv' || format === 'tsv') {
      normalized = (await this.converter.convert(format, 'xlsx', content))
        .content;
    } else {
      await this.converter.validate('xlsx', content);
    }
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(
        normalized.buffer.slice(
          normalized.byteOffset,
          normalized.byteOffset + normalized.byteLength,
        ) as ArrayBuffer,
      );
    } catch {
      throw validationError('Nao foi possivel ler a planilha.');
    }
    const worksheet =
      format === 'xlsx'
        ? workbook.getWorksheet(TEMPLATE_SHEET)
        : workbook.worksheets[0];
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
      if (
        !requiredHeaders.some((header) =>
          cellText(row.getCell(headerIndex.get(header)!)),
        )
      ) {
        continue;
      }
      result.push({
        rowNumber,
        fullName: cellText(row.getCell(column('Nome completo'))),
        externalReference: optionalCell(
          row.getCell(column('Identificador do colaborador (opcional)')),
        ),
        shift: optionalCell(row.getCell(column('Turno'))),
        requiredArrivalTime: optionalCell(
          row.getCell(column('Horario de chegada')),
        ),
        sector: optionalCell(row.getCell(column('Setor'))),
        residenceStreet: optionalCell(
          row.getCell(column('Logradouro residencial')),
        ),
        residenceNumber: optionalCell(
          row.getCell(column('Numero residencial')),
        ),
        residenceComplement: optionalCell(
          row.getCell(column('Complemento residencial')),
        ),
        residenceDistrict: optionalCell(
          row.getCell(column('Bairro residencial')),
        ),
        residencePostalCode: optionalCell(
          row.getCell(column('CEP residencial')),
        ),
        residenceCity: optionalCell(row.getCell(column('Cidade residencial'))),
        residenceState: optionalCell(row.getCell(column('UF residencial'))),
        accessibilityRequired: booleanCell(
          row.getCell(column('Necessita acessibilidade')),
        ),
        accessibilityNotes: optionalCell(
          row.getCell(column('Observacao de acessibilidade')),
        ),
        fixedPointCode: optionalCell(
          row.getCell(column('Codigo do ponto de embarque')),
        ),
        residenceLatitude: null,
        residenceLongitude: null,
        documents: documents(row, column),
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

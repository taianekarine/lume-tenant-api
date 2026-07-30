import { createHash } from 'node:crypto';

import {
  conversionNotSupported,
  unsupportedFileFormat,
  validationError,
} from '../../core/errors/app-error';

export const DATA_EXCHANGE_FORMATS = ['pdf', 'xlsx', 'csv', 'tsv'] as const;
export type DataExchangeFormat = (typeof DATA_EXCHANGE_FORMATS)[number];

export interface DataExchangeFormatCapability {
  key: DataExchangeFormat;
  label: string;
  category: 'document' | 'spreadsheet';
  extensions: readonly string[];
  mimeTypes: readonly string[];
  convertsTo: readonly DataExchangeFormat[];
}

export const DATA_EXCHANGE_CAPABILITIES: readonly DataExchangeFormatCapability[] =
  [
    {
      key: 'pdf',
      label: 'Documento PDF',
      category: 'document',
      extensions: ['pdf'],
      mimeTypes: ['application/pdf'],
      convertsTo: ['pdf'],
    },
    {
      key: 'xlsx',
      label: 'Planilha Excel moderna',
      category: 'spreadsheet',
      extensions: ['xlsx'],
      mimeTypes: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
      convertsTo: ['xlsx', 'csv', 'tsv'],
    },
    {
      key: 'csv',
      label: 'Planilha CSV',
      category: 'spreadsheet',
      extensions: ['csv'],
      mimeTypes: ['text/csv', 'application/csv', 'text/plain'],
      convertsTo: ['xlsx'],
    },
    {
      key: 'tsv',
      label: 'Planilha TSV',
      category: 'spreadsheet',
      extensions: ['tsv'],
      mimeTypes: ['text/tab-separated-values', 'text/plain'],
      convertsTo: ['xlsx'],
    },
  ] as const;

export const RECOGNIZED_UNAVAILABLE_FORMATS = [
  {
    key: 'xls',
    label: 'Planilha Excel 97-2003',
    reason:
      'O adaptador binário .xls ainda não foi instalado. Converta para .xlsx antes do upload.',
  },
  {
    key: 'ods',
    label: 'Planilha OpenDocument',
    reason:
      'O adaptador .ods ainda não foi instalado. Exporte para .xlsx antes do upload.',
  },
] as const;

export interface DataExchangeFileInput {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
}

export interface ValidatedDataExchangeFile {
  fileName: string;
  mimeType: string;
  extension: string;
  format: DataExchangeFormat;
  sizeBytes: number;
  sha256: string;
}

function safeFileName(value: string): string {
  const fileName = value
    .split(/[\\/]/)
    .at(-1)
    ?.trim()
    .split('')
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
  if (!fileName || fileName.length > 255) {
    throw validationError(
      'O nome do arquivo deve possuir entre 1 e 255 caracteres.',
    );
  }
  return fileName;
}

function assertPdf(content: Buffer): void {
  if (
    content.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    !content
      .subarray(Math.max(0, content.byteLength - 2048))
      .includes(Buffer.from('%%EOF', 'ascii'))
  ) {
    throw unsupportedFileFormat(
      'O conteúdo não possui a estrutura mínima de um PDF completo.',
      { expectedFormat: 'pdf' },
    );
  }
}

function assertXlsx(content: Buffer): void {
  if (
    content.byteLength < 4 ||
    content.subarray(0, 4).toString('hex') !== '504b0304'
  ) {
    throw unsupportedFileFormat(
      'O conteúdo não possui a assinatura ZIP esperada de uma planilha XLSX.',
      { expectedFormat: 'xlsx' },
    );
  }
}

function assertUtf8Text(content: Buffer, format: 'csv' | 'tsv'): void {
  if (content.includes(0)) {
    throw unsupportedFileFormat(
      `O arquivo ${format.toUpperCase()} contém bytes binários inesperados.`,
      { expectedFormat: format },
    );
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw unsupportedFileFormat(
      `O arquivo ${format.toUpperCase()} deve usar codificação UTF-8.`,
      { expectedFormat: format },
    );
  }
}

export function validateDataExchangeFile(
  input: DataExchangeFileInput,
  maximumBytes: number,
): ValidatedDataExchangeFile {
  if (
    input.sizeBytes < 1 ||
    input.sizeBytes > maximumBytes ||
    input.content.byteLength !== input.sizeBytes
  ) {
    throw validationError(
      `O arquivo deve possuir entre 1 e ${maximumBytes} bytes.`,
    );
  }

  const fileName = safeFileName(input.originalName);
  const extension = fileName.split('.').at(-1)?.toLowerCase() ?? '';
  const unavailable = RECOGNIZED_UNAVAILABLE_FORMATS.find(
    (candidate) => candidate.key === extension,
  );
  if (unavailable) {
    throw unsupportedFileFormat(unavailable.reason, {
      format: unavailable.key,
      availableFormats: DATA_EXCHANGE_FORMATS,
    });
  }
  const capability = DATA_EXCHANGE_CAPABILITIES.find((candidate) =>
    candidate.extensions.includes(extension),
  );
  if (!capability) {
    throw unsupportedFileFormat(
      `A extensão .${extension || '(ausente)'} ainda não possui adaptador seguro.`,
      { availableFormats: DATA_EXCHANGE_FORMATS },
    );
  }

  const mimeType = input.mimeType.trim().toLowerCase();
  if (!capability.mimeTypes.includes(mimeType)) {
    throw unsupportedFileFormat(
      `O MIME ${mimeType || '(ausente)'} não corresponde à extensão .${extension}.`,
      {
        format: capability.key,
        acceptedMimeTypes: capability.mimeTypes,
      },
    );
  }

  switch (capability.key) {
    case 'pdf':
      assertPdf(input.content);
      break;
    case 'xlsx':
      assertXlsx(input.content);
      break;
    case 'csv':
    case 'tsv':
      assertUtf8Text(input.content, capability.key);
      break;
  }

  return {
    fileName,
    mimeType,
    extension,
    format: capability.key,
    sizeBytes: input.sizeBytes,
    sha256: createHash('sha256').update(input.content).digest('hex'),
  };
}

export function assertConversionSupported(
  source: DataExchangeFormat,
  target: DataExchangeFormat,
): void {
  const capability = DATA_EXCHANGE_CAPABILITIES.find(
    (candidate) => candidate.key === source,
  );
  if (!capability?.convertsTo.includes(target)) {
    throw conversionNotSupported(
      `A conversão de ${source.toUpperCase()} para ${target.toUpperCase()} não possui adaptador ativo.`,
      {
        sourceFormat: source,
        targetFormat: target,
        availableTargets: capability?.convertsTo ?? [],
      },
    );
  }
}

export function dataExchangeCapabilities(maximumBytes: number) {
  return {
    schemaVersion: '1.0',
    maximumUploadBytes: maximumBytes,
    formats: DATA_EXCHANGE_CAPABILITIES,
    recognizedButUnavailable: RECOGNIZED_UNAVAILABLE_FORMATS,
    notes: [
      'PDF possui somente normalização PDF para PDF.',
      'CSV e TSV são importados para XLSX.',
      'XLSX pode ser exportado para XLSX, CSV ou TSV.',
      'Novos formatos exigem adaptador, validação estrutural e testes antes de serem anunciados.',
    ],
  };
}

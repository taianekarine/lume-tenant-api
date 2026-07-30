import { describe, expect, it } from 'vitest';

import { AppError } from '../../core/errors/app-error';
import {
  assertConversionSupported,
  dataExchangeCapabilities,
  validateDataExchangeFile,
} from './data-exchange-capabilities';

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

describe('data exchange capabilities', () => {
  it('identifica PDF por extensão, MIME e assinatura e calcula o hash', () => {
    expect(
      validateDataExchangeFile(
        {
          originalName: 'C:\\fakepath\\relatório.pdf',
          mimeType: 'application/pdf',
          sizeBytes: pdf.byteLength,
          content: pdf,
        },
        1024,
      ),
    ).toMatchObject({
      fileName: 'relatório.pdf',
      extension: 'pdf',
      format: 'pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdf.byteLength,
    });
  });

  it('rejeita formato reconhecido sem adaptador e MIME incompatível', () => {
    expect(() =>
      validateDataExchangeFile(
        {
          originalName: 'legado.xls',
          mimeType: 'application/vnd.ms-excel',
          sizeBytes: 4,
          content: Buffer.from('test'),
        },
        1024,
      ),
    ).toThrowError(
      expect.objectContaining<AppError>({ code: 'UNSUPPORTED_FILE_FORMAT' }),
    );
    expect(() =>
      validateDataExchangeFile(
        {
          originalName: 'dados.csv',
          mimeType: 'application/pdf',
          sizeBytes: 4,
          content: Buffer.from('a,b\n'),
        },
        1024,
      ),
    ).toThrow('não corresponde');
  });

  it('publica somente conversões que possuem adaptador', () => {
    expect(() => assertConversionSupported('xlsx', 'csv')).not.toThrow();
    expect(() => assertConversionSupported('pdf', 'xlsx')).toThrowError(
      expect.objectContaining<AppError>({
        code: 'CONVERSION_NOT_SUPPORTED',
      }),
    );
    expect(dataExchangeCapabilities(2048)).toMatchObject({
      schemaVersion: '1.0',
      maximumUploadBytes: 2048,
    });
  });
});

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AppError } from '../../core/errors/app-error';
import {
  type QuoteProposalPdfInput,
  validateQuoteProposalPdf,
} from './quote-proposal-pdf';

const validContent = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

function pdf(
  overrides: Partial<QuoteProposalPdfInput> = {},
): QuoteProposalPdfInput {
  return {
    originalName: 'orcamento.pdf',
    mimeType: 'application/pdf',
    sizeBytes: validContent.byteLength,
    content: validContent,
    ...overrides,
  };
}

function expectValidationError(input: QuoteProposalPdfInput): void {
  expect(() => validateQuoteProposalPdf(input)).toThrowError(
    expect.objectContaining<AppError>({ code: 'VALIDATION_ERROR' }),
  );
}

describe('validateQuoteProposalPdf', () => {
  it('normaliza o nome e calcula hash somente de um PDF completo', () => {
    expect(
      validateQuoteProposalPdf(
        pdf({ originalName: 'C:\\fakepath\\Orçamento Final.PDF' }),
      ),
    ).toEqual({
      fileName: 'Orçamento Final.PDF',
      mimeType: 'application/pdf',
      sizeBytes: validContent.byteLength,
      sha256: createHash('sha256').update(validContent).digest('hex'),
    });
  });

  it('rejeita MIME, extensão, tamanho declarado, assinatura e EOF inválidos', () => {
    expectValidationError(pdf({ mimeType: 'application/octet-stream' }));
    expectValidationError(pdf({ originalName: 'orcamento.txt' }));
    expectValidationError(pdf({ sizeBytes: validContent.byteLength + 1 }));
    expectValidationError(
      pdf({
        content: Buffer.from('not-a-pdf%%EOF'),
        sizeBytes: Buffer.byteLength('not-a-pdf%%EOF'),
      }),
    );
    expectValidationError(
      pdf({
        content: Buffer.from('%PDF-1.4 sem eof'),
        sizeBytes: Buffer.byteLength('%PDF-1.4 sem eof'),
      }),
    );
  });
});

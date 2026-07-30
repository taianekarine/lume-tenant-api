import { createHash } from 'node:crypto';

import { validationError } from '../../core/errors/app-error';
import { QUOTE_PROPOSAL_MAX_PDF_BYTES } from './whatsapp.constants';

export interface QuoteProposalPdfInput {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
}

export interface ValidatedQuoteProposalPdf {
  fileName: string;
  mimeType: 'application/pdf';
  sizeBytes: number;
  sha256: string;
}

function normalizeFileName(value: string): string {
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
  if (!fileName || fileName.length > 255 || !/\.pdf$/i.test(fileName)) {
    throw validationError(
      'O arquivo da proposta deve possuir um nome .pdf válido de até 255 caracteres.',
    );
  }
  return fileName;
}

export function validateQuoteProposalPdf(
  input: QuoteProposalPdfInput,
): ValidatedQuoteProposalPdf {
  if (input.mimeType.toLowerCase() !== 'application/pdf') {
    throw validationError('A proposta deve usar o MIME type application/pdf.');
  }
  if (
    input.sizeBytes < 1 ||
    input.sizeBytes > QUOTE_PROPOSAL_MAX_PDF_BYTES ||
    input.content.byteLength !== input.sizeBytes
  ) {
    throw validationError(
      `O PDF deve possuir entre 1 byte e ${QUOTE_PROPOSAL_MAX_PDF_BYTES} bytes.`,
    );
  }
  if (
    input.content.subarray(0, 5).toString('ascii') !== '%PDF-' ||
    !input.content
      .subarray(Math.max(0, input.content.byteLength - 2048))
      .includes(Buffer.from('%%EOF', 'ascii'))
  ) {
    throw validationError(
      'O conteúdo informado não possui a assinatura completa de um PDF.',
    );
  }
  return {
    fileName: normalizeFileName(input.originalName),
    mimeType: 'application/pdf',
    sizeBytes: input.sizeBytes,
    sha256: createHash('sha256').update(input.content).digest('hex'),
  };
}

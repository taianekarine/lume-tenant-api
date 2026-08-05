import { createHash } from 'node:crypto';

import { validationError } from '../../core/errors/app-error';

export const DOCUMENT_REQUEST_CONTEXTS = [
  'admission',
  'document-update',
  'document-renewal',
  'regularization',
  'offboarding',
  'other',
] as const;
export type DocumentRequestContext = (typeof DOCUMENT_REQUEST_CONTEXTS)[number];

export const DOCUMENT_REQUEST_STATUSES = [
  'draft',
  'pending-upload',
  'partially-submitted',
  'submitted',
  'automatic-validation',
  'pending-human-review',
  'resubmission-required',
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type DocumentRequestStatus = (typeof DOCUMENT_REQUEST_STATUSES)[number];

export const DOCUMENT_ITEM_STATUSES = [
  'pending-upload',
  'submitted',
  'automatic-validation',
  'pending-human-review',
  'resubmission-required',
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const;
export type DocumentItemStatus = (typeof DOCUMENT_ITEM_STATUSES)[number];

export type DocumentRequirement = 'required' | 'optional' | 'conditional';
export type DocumentFileSide = 'single' | 'front' | 'back' | 'page';

const itemTransitions: Readonly<
  Record<DocumentItemStatus, readonly DocumentItemStatus[]>
> = {
  'pending-upload': ['submitted', 'cancelled'],
  submitted: ['automatic-validation', 'pending-human-review', 'cancelled'],
  'automatic-validation': ['pending-human-review', 'resubmission-required'],
  'pending-human-review': ['approved', 'rejected', 'resubmission-required'],
  'resubmission-required': ['submitted', 'cancelled'],
  approved: ['expired'],
  rejected: ['submitted', 'cancelled'],
  expired: ['submitted', 'cancelled'],
  cancelled: [],
};

export function assertDocumentItemTransition(
  from: DocumentItemStatus,
  to: DocumentItemStatus,
): void {
  if (!itemTransitions[from].includes(to)) {
    throw validationError(`Transição documental inválida: ${from} -> ${to}.`);
  }
}

export function deriveDocumentRequestStatus(
  items: readonly {
    status: DocumentItemStatus;
    requirement: DocumentRequirement;
  }[],
): DocumentRequestStatus {
  const relevant = items.filter((item) => item.requirement !== 'optional');
  const source = relevant.length > 0 ? relevant : items;
  if (source.length === 0) return 'draft';
  if (source.every((item) => item.status === 'cancelled')) return 'cancelled';
  if (source.some((item) => item.status === 'resubmission-required')) {
    return 'resubmission-required';
  }
  if (source.some((item) => item.status === 'rejected')) return 'rejected';
  if (source.some((item) => item.status === 'expired')) return 'expired';
  if (source.every((item) => item.status === 'approved')) return 'approved';
  if (source.some((item) => item.status === 'pending-human-review')) {
    return 'pending-human-review';
  }
  if (source.some((item) => item.status === 'automatic-validation')) {
    return 'automatic-validation';
  }
  if (source.every((item) => item.status === 'submitted')) return 'submitted';
  if (source.some((item) => item.status !== 'pending-upload')) {
    return 'partially-submitted';
  }
  return 'pending-upload';
}

export interface DocumentUploadPolicy {
  acceptedMimeTypes: readonly string[];
  maxFileSizeBytes: number;
  minFiles: number;
  maxFiles: number;
  allowsMultiplePages: boolean;
  requiresFrontBack: boolean;
}

export interface DocumentUploadFile {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
  side: DocumentFileSide;
  pageNumber: number;
}

const signatures: Readonly<Record<string, (content: Buffer) => boolean>> = {
  'application/pdf': (content) =>
    content.subarray(0, 5).toString('ascii') === '%PDF-',
  'image/jpeg': (content) =>
    content.length >= 3 &&
    content[0] === 0xff &&
    content[1] === 0xd8 &&
    content[2] === 0xff,
  'image/png': (content) =>
    content.length >= 8 &&
    content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
};

export function sanitizeDocumentFileName(value: string): string {
  return (
    value
      .normalize('NFKC')
      .split('')
      .filter((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      })
      .join('')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 255) || 'documento'
  );
}

export function validateDocumentUpload(
  files: readonly DocumentUploadFile[],
  policy: DocumentUploadPolicy,
) {
  if (files.length < policy.minFiles || files.length > policy.maxFiles) {
    throw validationError(
      `Envie entre ${policy.minFiles} e ${policy.maxFiles} arquivo(s).`,
    );
  }

  const sides = new Set(files.map((file) => file.side));
  if (policy.requiresFrontBack && (!sides.has('front') || !sides.has('back'))) {
    throw validationError('Envie a frente e o verso do documento.');
  }
  if (policy.requiresFrontBack) {
    const sidesByPage = new Map<number, Set<DocumentFileSide>>();
    for (const file of files) {
      const pageSides =
        sidesByPage.get(file.pageNumber) ?? new Set<DocumentFileSide>();
      pageSides.add(file.side);
      sidesByPage.set(file.pageNumber, pageSides);
    }
    if (
      [...sidesByPage.values()].some(
        (pageSides) =>
          pageSides.size !== 2 ||
          !pageSides.has('front') ||
          !pageSides.has('back'),
      )
    ) {
      throw validationError(
        'Envie um par completo de frente e verso para cada documento.',
      );
    }
  }
  if (
    !policy.allowsMultiplePages &&
    files.some((file) => file.pageNumber > 1)
  ) {
    throw validationError('Este tipo documental não aceita múltiplas páginas.');
  }

  return files.map((file) => {
    if (!policy.acceptedMimeTypes.includes(file.mimeType)) {
      throw validationError(`Formato não permitido: ${file.mimeType}.`);
    }
    if (file.sizeBytes <= 0 || file.sizeBytes > policy.maxFileSizeBytes) {
      throw validationError(
        'O arquivo excede o limite configurado ou está vazio.',
      );
    }
    const signature = signatures[file.mimeType];
    if (!signature || !signature(file.content)) {
      throw validationError(
        'O conteúdo real do arquivo não corresponde ao MIME informado.',
      );
    }
    if (!Number.isInteger(file.pageNumber) || file.pageNumber < 1) {
      throw validationError('O número da página deve ser um inteiro positivo.');
    }
    return {
      ...file,
      originalName: sanitizeDocumentFileName(file.originalName),
      sha256: createHash('sha256').update(file.content).digest('hex'),
    };
  });
}

export function localStructuralValidation(input: {
  files: readonly {
    side: DocumentFileSide;
    pageNumber: number;
    mimeType: string;
  }[];
  policy: DocumentUploadPolicy;
  documentTypeCode: string;
}) {
  const alerts: string[] = [];
  const sides = new Set(input.files.map((file) => file.side));
  if (input.policy.requiresFrontBack && !sides.has('front'))
    alerts.push('Frente ausente.');
  if (input.policy.requiresFrontBack && !sides.has('back'))
    alerts.push('Verso ausente.');
  if (input.files.length < input.policy.minFiles)
    alerts.push('Quantidade mínima não atendida.');

  alerts.push(
    'OCR/IA não configurado: classificação visual, legibilidade e extração exigem revisão humana.',
  );
  return {
    status: 'completed' as const,
    suggestedDocumentTypeCode: input.documentTypeCode,
    overallConfidence: null,
    alerts,
    extractedFields: {},
    summary:
      'Validação estrutural local concluída; decisão humana obrigatória.',
    provider: 'local-structural',
    modelVersion: '1',
    manualReviewRequired: true,
  };
}

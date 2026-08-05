import type { DocumentFileSide } from '../../domain/documents/document-workflow';

export interface DocumentReviewInput {
  readonly files: readonly {
    readonly fileName: string;
    readonly mimeType: string;
    readonly content: Buffer;
    readonly side: DocumentFileSide;
    readonly pageNumber: number;
  }[];
  readonly expectedDocumentTypeCode: string;
  readonly extractionFields: readonly {
    readonly key: string;
    readonly label: string;
    readonly type?: string;
    readonly multiple?: boolean;
  }[];
  readonly rules: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, unknown>>;
  readonly profileVersion: number;
  readonly safetyIdentifier: string;
}

export interface DocumentReviewResult {
  readonly classification: {
    readonly expectedType: string;
    readonly detectedType: string;
    readonly confidence: number;
  };
  readonly quality: {
    readonly legible: boolean;
    readonly complete: boolean;
    readonly issues: readonly string[];
  };
  readonly fields: readonly {
    readonly key: string;
    readonly rawValue: string | null;
    readonly normalizedValue: string | null;
    readonly confidence: number;
    readonly sourceFile: string;
    readonly page: number;
  }[];
  readonly alerts: readonly string[];
  readonly requiresHumanReview: true;
  readonly summary: string;
  readonly provider: string;
  readonly modelVersion: string;
  readonly attempt: number;
}

export abstract class DocumentReviewAgent {
  abstract review(input: DocumentReviewInput): Promise<DocumentReviewResult>;
}

export const DOCUMENT_REVIEW_AGENT = Symbol('DOCUMENT_REVIEW_AGENT');

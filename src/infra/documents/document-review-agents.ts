import { createHash } from 'node:crypto';

import {
  DocumentReviewAgent,
  type DocumentReviewInput,
  type DocumentReviewResult,
} from '../../application/contracts/document-review-agent';
import { localStructuralValidation } from '../../domain/documents/document-workflow';

function localResult(
  input: DocumentReviewInput,
  additionalAlerts: readonly string[] = [],
): DocumentReviewResult {
  const structural = localStructuralValidation({
    files: input.files.map((file) => ({
      side: file.side,
      pageNumber: file.pageNumber,
      mimeType: file.mimeType,
    })),
    policy: {
      acceptedMimeTypes: input.files.map((file) => file.mimeType),
      maxFileSizeBytes: Number.MAX_SAFE_INTEGER,
      minFiles: 1,
      maxFiles: input.files.length,
      allowsMultiplePages: true,
      requiresFrontBack: input.rules.requiresFrontBack === true,
    },
    documentTypeCode: input.expectedDocumentTypeCode,
  });
  return {
    classification: {
      expectedType: input.expectedDocumentTypeCode,
      detectedType: input.expectedDocumentTypeCode,
      confidence: 0,
    },
    quality: {
      legible: false,
      complete: structural.alerts.length === 0,
      issues: structural.alerts,
    },
    fields: [],
    alerts: [...structural.alerts, ...additionalAlerts],
    requiresHumanReview: true,
    summary: structural.summary,
    provider: structural.provider,
    modelVersion: structural.modelVersion,
    attempt: 1,
  };
}

export class LocalStructuralReviewAgent extends DocumentReviewAgent {
  review(input: DocumentReviewInput): Promise<DocumentReviewResult> {
    return Promise.resolve(localResult(input));
  }
}

const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'classification',
    'quality',
    'fields',
    'alerts',
    'requiresHumanReview',
    'summary',
  ],
  properties: {
    classification: {
      type: 'object',
      additionalProperties: false,
      required: ['expectedType', 'detectedType', 'confidence'],
      properties: {
        expectedType: { type: 'string' },
        detectedType: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
    },
    quality: {
      type: 'object',
      additionalProperties: false,
      required: ['legible', 'complete', 'issues'],
      properties: {
        legible: { type: 'boolean' },
        complete: { type: 'boolean' },
        issues: { type: 'array', items: { type: 'string' } },
      },
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'key',
          'rawValue',
          'normalizedValue',
          'confidence',
          'sourceFile',
          'page',
        ],
        properties: {
          key: { type: 'string' },
          rawValue: { type: ['string', 'null'] },
          normalizedValue: { type: ['string', 'null'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          sourceFile: { type: 'string' },
          page: { type: 'integer', minimum: 1 },
        },
      },
    },
    alerts: { type: 'array', items: { type: 'string' } },
    requiresHumanReview: { type: 'boolean', const: true },
    summary: { type: 'string' },
  },
} as const;

function responseText(value: unknown): string {
  if (!value || typeof value !== 'object')
    throw new Error('Resposta OpenAI inválida.');
  const record = value as Record<string, unknown>;
  if (typeof record.output_text === 'string') return record.output_text;
  if (!Array.isArray(record.output))
    throw new Error('Resposta OpenAI sem saída.');
  for (const item of record.output) {
    if (!item || typeof item !== 'object') continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  }
  throw new Error('Resposta OpenAI sem texto estruturado.');
}

export class OpenAiDocumentReviewAgent extends DocumentReviewAgent {
  constructor(
    private readonly config: {
      apiKey: string;
      model: string;
      timeoutMs: number;
      maxAttempts: number;
      baseUrl?: string;
    },
  ) {
    super();
  }

  async review(input: DocumentReviewInput): Promise<DocumentReviewResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.config.timeoutMs,
      );
      try {
        const content: Array<Record<string, unknown>> = [
          {
            type: 'input_text',
            text: [
              'Você revisa documentos empresariais brasileiros.',
              'Nunca aprove nem atualize cadastros. Retorne apenas dados propostos para revisão humana.',
              `Tipo esperado: ${input.expectedDocumentTypeCode}.`,
              `Perfil v${input.profileVersion}.`,
              `Campos: ${JSON.stringify(input.extractionFields)}.`,
              `Regras: ${JSON.stringify(input.rules)}.`,
              `Contexto: ${JSON.stringify(input.context)}.`,
              'Use somente evidências visíveis nos arquivos. Não invente valores ausentes.',
            ].join('\n'),
          },
          ...input.files.map((file) =>
            file.mimeType === 'application/pdf'
              ? {
                  type: 'input_file',
                  filename: file.fileName,
                  file_data: `data:${file.mimeType};base64,${file.content.toString('base64')}`,
                }
              : {
                  type: 'input_image',
                  image_url: `data:${file.mimeType};base64,${file.content.toString('base64')}`,
                  detail: 'high',
                },
          ),
        ];
        const response = await fetch(
          `${this.config.baseUrl ?? 'https://api.openai.com/v1'}/responses`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: this.config.model,
              store: false,
              safety_identifier: input.safetyIdentifier,
              reasoning: { effort: 'low' },
              input: [{ role: 'user', content }],
              text: {
                format: {
                  type: 'json_schema',
                  name: 'document_review',
                  strict: true,
                  schema: reviewSchema,
                },
              },
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw new Error(`OpenAI respondeu HTTP ${response.status}.`);
        }
        const parsed = JSON.parse(responseText(await response.json())) as Omit<
          DocumentReviewResult,
          'provider' | 'modelVersion' | 'attempt'
        >;
        return {
          ...parsed,
          requiresHumanReview: true,
          provider: 'openai',
          modelVersion: this.config.model,
          attempt,
        };
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error('Falha desconhecida na revisão OpenAI.');
  }
}

export class FallbackDocumentReviewAgent extends DocumentReviewAgent {
  constructor(
    private readonly primary: DocumentReviewAgent,
    private readonly fallback = new LocalStructuralReviewAgent(),
  ) {
    super();
  }

  async review(input: DocumentReviewInput): Promise<DocumentReviewResult> {
    try {
      return await this.primary.review(input);
    } catch (error) {
      const fingerprint = createHash('sha256')
        .update(error instanceof Error ? error.message : 'unknown')
        .digest('hex')
        .slice(0, 12);
      return localResult(input, [
        `Revisão OpenAI indisponível; fallback local aplicado (${fingerprint}).`,
      ]);
    }
  }
}

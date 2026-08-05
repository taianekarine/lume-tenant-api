import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DocumentReviewInput } from '../../application/contracts/document-review-agent';
import {
  FallbackDocumentReviewAgent,
  OpenAiDocumentReviewAgent,
} from './document-review-agents';

const input: DocumentReviewInput = {
  files: [
    {
      fileName: 'cpf.png',
      mimeType: 'image/png',
      content: Buffer.from('imagem'),
      side: 'single',
      pageNumber: 1,
    },
  ],
  expectedDocumentTypeCode: 'cpf',
  extractionFields: [{ key: 'cpf', label: 'CPF' }],
  rules: {},
  context: { requestId: 'request-1' },
  profileVersion: 1,
  safetyIdentifier: 'tenant-user-hash',
};

describe('OpenAiDocumentReviewAgent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('envia imagem pela Responses API sem armazenamento e força revisão humana', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            classification: {
              expectedType: 'cpf',
              detectedType: 'cpf',
              confidence: 0.98,
            },
            quality: { legible: true, complete: true, issues: [] },
            fields: [
              {
                key: 'cpf',
                rawValue: '123',
                normalizedValue: '123',
                confidence: 0.95,
                sourceFile: 'cpf.png',
                page: 1,
              },
            ],
            alerts: [],
            requiresHumanReview: false,
            summary: 'Documento legível.',
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const agent = new OpenAiDocumentReviewAgent({
      apiKey: 'test-key',
      model: 'gpt-5.6-terra',
      timeoutMs: 1000,
      maxAttempts: 1,
    });

    const result = await agent.review(input);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(typeof init.body).toBe('string');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;

    expect(body.store).toBe(false);
    expect(body.safety_identifier).toBe('tenant-user-hash');
    expect(JSON.stringify(body)).toContain('input_image');
    expect(result.requiresHumanReview).toBe(true);
    expect(result.provider).toBe('openai');
  });

  it('mantém o fluxo em revisão humana quando a OpenAI fica indisponível', async () => {
    const primary = { review: vi.fn().mockRejectedValue(new Error('timeout')) };
    const result = await new FallbackDocumentReviewAgent(primary).review(input);

    expect(result.provider).toBe('local-structural');
    expect(result.requiresHumanReview).toBe(true);
    expect(result.alerts.join(' ')).toContain('fallback local');
  });
});

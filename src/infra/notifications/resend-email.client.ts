import type { ConfigService } from '@nestjs/config';

export interface ResendEmailInput {
  readonly idempotencyKey: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface ResendEmailResult {
  readonly providerMessageId: string;
}

interface ResendResponse {
  readonly id?: unknown;
}

export function escapeEmailHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function sanitizeEmailHeader(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export async function sendResendEmail(
  config: ConfigService,
  input: ResendEmailInput,
): Promise<ResendEmailResult> {
  const maximumAttempts = config.get<number>('RESEND_MAX_ATTEMPTS') ?? 2;
  const retryDelayMs = config.get<number>('RESEND_RETRY_DELAY_MS') ?? 150;
  const senderName = sanitizeEmailHeader(
    config.getOrThrow<string>('RESEND_FROM_NAME'),
  );
  const senderEmail = sanitizeEmailHeader(
    config.getOrThrow<string>('RESEND_FROM_EMAIL'),
  );
  let lastStatus: number | null = null;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      const response = await fetch(
        `${config.getOrThrow<string>('RESEND_API_URL')}/emails`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${config.getOrThrow<string>('RESEND_API_KEY')}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': input.idempotencyKey,
            'User-Agent': '@tks-lume/tenant-api/0.1.0',
          },
          body: JSON.stringify({
            from: `${senderName} <${senderEmail}>`,
            to: input.to,
            ...(input.cc?.length ? { cc: input.cc } : {}),
            subject: input.subject,
            html: input.html,
            text: input.text,
          }),
          signal: AbortSignal.timeout(
            config.getOrThrow<number>('RESEND_REQUEST_TIMEOUT_MS'),
          ),
        },
      );
      if (response.ok) {
        const body = (await response.json()) as ResendResponse;
        if (typeof body.id === 'string' && body.id.trim()) {
          return { providerMessageId: body.id.trim() };
        }
        throw new Error('Serviço de e-mail retornou uma resposta inválida.');
      }
      lastStatus = response.status;
      if (
        response.status !== 408 &&
        response.status !== 429 &&
        response.status < 500
      ) {
        break;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'Serviço de e-mail retornou uma resposta inválida.'
      ) {
        throw error;
      }
      lastStatus = null;
    }

    if (attempt < maximumAttempts && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(
    lastStatus
      ? `Serviço de e-mail indisponível (HTTP ${lastStatus}).`
      : 'Serviço de e-mail indisponível.',
  );
}

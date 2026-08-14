import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  EvolutionOutboundGateway,
  type EvolutionOutboundInput,
  type EvolutionOutboundResult,
  type EvolutionTextPayloadMode,
} from '../../../application/contracts/evolution-outbound.gateway';

const DEFAULT_TEXT_TIMEOUT_MS = 10_000;
const DEFAULT_DOCUMENT_TIMEOUT_MS = 30_000;

type JsonObject = Readonly<Record<string, unknown>>;

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function extractEvolutionProviderMessageId(
  responseBody: unknown,
): string | undefined {
  const body = asObject(responseBody);
  if (!body) return undefined;

  const key = asObject(body.key);
  const nestedResponse = asObject(body.response);
  const nestedKey = asObject(nestedResponse?.key);

  return (
    nonEmptyString(key?.id) ??
    nonEmptyString(body.messageId) ??
    nonEmptyString(body.id) ??
    nonEmptyString(nestedKey?.id)
  );
}

export function buildEvolutionTextPayload(
  mode: EvolutionTextPayloadMode,
  recipientPhone: string,
  text: string,
): Readonly<Record<string, unknown>> {
  if (mode === 'textMessage') {
    return {
      number: recipientPhone,
      textMessage: { text },
    };
  }

  return {
    number: recipientPhone,
    text,
  };
}

@Injectable()
export class HttpEvolutionOutboundGateway extends EvolutionOutboundGateway {
  private readonly baseUrl: string;
  private readonly instanceName: string;
  private readonly apiKey: string;
  private readonly textPayloadMode: EvolutionTextPayloadMode;
  private readonly textTimeoutMs: number;
  private readonly documentTimeoutMs: number;

  constructor(config: ConfigService) {
    super();
    this.baseUrl = (config.get<string>('EVOLUTION_BASE_URL') ?? '')
      .trim()
      .replace(/\/+$/, '');
    this.instanceName = (
      config.get<string>('EVOLUTION_INSTANCE_NAME') ?? ''
    ).trim();
    this.apiKey = (config.get<string>('EVOLUTION_API_KEY') ?? '').trim();
    this.textPayloadMode = this.parsePayloadMode(
      config.get<string>('EVOLUTION_SEND_TEXT_PAYLOAD_MODE'),
    );
    this.textTimeoutMs = positiveInteger(
      config.get<unknown>('EVOLUTION_SEND_TEXT_TIMEOUT_MS'),
      DEFAULT_TEXT_TIMEOUT_MS,
    );
    this.documentTimeoutMs = positiveInteger(
      config.get<unknown>('EVOLUTION_SEND_MEDIA_TIMEOUT_MS'),
      DEFAULT_DOCUMENT_TIMEOUT_MS,
    );
  }

  async send(input: EvolutionOutboundInput): Promise<EvolutionOutboundResult> {
    const invalidConfiguration = this.validateConfiguration();
    if (invalidConfiguration) return invalidConfiguration;

    const invalidInput = this.validateInput(input);
    if (invalidInput) return invalidInput;

    if (input.kind === 'text') return this.sendText(input);
    if (input.kind === 'document') return this.sendDocument(input);
    return this.sendMedia(input);
  }

  private async sendText(
    input: Extract<EvolutionOutboundInput, { kind: 'text' }>,
  ): Promise<EvolutionOutboundResult> {
    return this.sendOnce(
      `${this.baseUrl}/message/sendText/${encodeURIComponent(this.instanceName)}`,
      {
        method: 'POST',
        headers: {
          apikey: this.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify(
          buildEvolutionTextPayload(
            this.textPayloadMode,
            input.recipientPhone,
            input.text,
          ),
        ),
      },
      this.textTimeoutMs,
    );
  }

  private async sendDocument(
    input: Extract<EvolutionOutboundInput, { kind: 'document' }>,
  ): Promise<EvolutionOutboundResult> {
    return this.sendMedia({
      ...input,
      kind: 'media',
      mediaType: 'document',
    });
  }

  private async sendMedia(
    input: Extract<EvolutionOutboundInput, { kind: 'media' }>,
  ): Promise<EvolutionOutboundResult> {
    if (input.mediaType === 'audio') {
      return this.sendOnce(
        `${this.baseUrl}/message/sendWhatsAppAudio/${encodeURIComponent(this.instanceName)}`,
        {
          method: 'POST',
          headers: {
            apikey: this.apiKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            number: input.recipientPhone,
            audio: `data:${input.mimeType};base64,${input.content.toString('base64')}`,
          }),
        },
        this.documentTimeoutMs,
      );
    }

    const form = new FormData();
    form.set('number', input.recipientPhone);
    form.set('mediatype', input.mediaType);
    form.set('mimetype', input.mimeType);
    form.set('fileName', input.fileName);
    form.set('caption', input.caption?.trim() ?? '');

    const bytes = new Uint8Array(input.content.byteLength);
    bytes.set(input.content);
    form.set(
      'file',
      new Blob([bytes.buffer], { type: input.mimeType }),
      input.fileName,
    );

    return this.sendOnce(
      `${this.baseUrl}/message/sendMedia/${encodeURIComponent(this.instanceName)}`,
      {
        method: 'POST',
        headers: { apikey: this.apiKey },
        body: form,
      },
      this.documentTimeoutMs,
    );
  }

  private async sendOnce(
    url: string,
    request: RequestInit,
    timeoutMs: number,
  ): Promise<EvolutionOutboundResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, {
        ...request,
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          outcome: 'ambiguous',
          deliveryStatus: 'pending',
          errorCode: 'EVOLUTION_DISPATCH_UNCONFIRMED',
          errorMessage:
            'O provedor respondeu sem confirmação inequívoca do envio.',
          httpStatus: response.status,
          requiresReconciliation: true,
        };
      }

      const responseBody = await this.readJsonSafely(response);
      const providerMessageId = extractEvolutionProviderMessageId(responseBody);

      if (!providerMessageId) {
        return {
          outcome: 'ambiguous',
          deliveryStatus: 'pending',
          errorCode: 'EVOLUTION_DISPATCH_UNCONFIRMED',
          errorMessage:
            'O provedor respondeu sem confirmação inequívoca do envio.',
          httpStatus: response.status,
          requiresReconciliation: true,
        };
      }

      return {
        outcome: 'confirmed',
        deliveryStatus: 'sent',
        providerMessageId,
        httpStatus: response.status,
        requiresReconciliation: false,
      };
    } catch {
      return timedOut
        ? {
            outcome: 'ambiguous',
            deliveryStatus: 'pending',
            errorCode: 'EVOLUTION_DISPATCH_TIMEOUT',
            errorMessage:
              'O tempo limite expirou sem confirmação inequívoca do envio.',
            requiresReconciliation: true,
          }
        : {
            outcome: 'ambiguous',
            deliveryStatus: 'pending',
            errorCode: 'EVOLUTION_DISPATCH_NETWORK_ERROR',
            errorMessage:
              'A chamada terminou sem confirmação inequívoca do envio.',
            requiresReconciliation: true,
          };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readJsonSafely(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  private validateConfiguration():
    Extract<EvolutionOutboundResult, { outcome: 'not-sent' }> | undefined {
    if (this.baseUrl && this.instanceName && this.apiKey) return undefined;

    return {
      outcome: 'not-sent',
      deliveryStatus: 'pending',
      errorCode: 'EVOLUTION_CONFIGURATION_INVALID',
      errorMessage: 'A configuração do provedor de mensagens está incompleta.',
      requiresReconciliation: false,
    };
  }

  private validateInput(
    input: EvolutionOutboundInput,
  ): Extract<EvolutionOutboundResult, { outcome: 'not-sent' }> | undefined {
    const validPhone = /^\d{10,15}$/.test(input.recipientPhone);
    const validContent =
      input.kind === 'text'
        ? input.text.trim().length > 0
        : input.fileName.trim().length > 0 &&
          input.mimeType.trim().length > 0 &&
          input.content.byteLength > 0;

    if (validPhone && validContent) return undefined;

    return {
      outcome: 'not-sent',
      deliveryStatus: 'pending',
      errorCode: 'EVOLUTION_OUTBOUND_INVALID',
      errorMessage:
        'A mensagem não contém todos os dados necessários ao envio.',
      requiresReconciliation: false,
    };
  }

  private parsePayloadMode(
    value: string | undefined,
  ): EvolutionTextPayloadMode {
    return value === 'textMessage' || value === 'legacy-text'
      ? value
      : 'number-text';
  }
}

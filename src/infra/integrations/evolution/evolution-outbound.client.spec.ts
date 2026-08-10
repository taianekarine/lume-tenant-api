import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import { HttpEvolutionOutboundGateway } from './evolution-outbound.client';

const apiKey = 'evolution-secret-that-must-not-leak';

function gateway(
  overrides: Readonly<Record<string, unknown>> = {},
): HttpEvolutionOutboundGateway {
  return new HttpEvolutionOutboundGateway(
    new ConfigService({
      EVOLUTION_BASE_URL: 'https://evolution.example.test/',
      EVOLUTION_INSTANCE_NAME: 'lume tenant',
      EVOLUTION_API_KEY: apiKey,
      EVOLUTION_SEND_TEXT_PAYLOAD_MODE: 'number-text',
      EVOLUTION_SEND_TEXT_TIMEOUT_MS: 10,
      EVOLUTION_SEND_MEDIA_TIMEOUT_MS: 10,
      ...overrides,
    }),
  );
}

function mockFetch(response: Response): Mock<typeof fetch> {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('HttpEvolutionOutboundGateway', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('envia texto no payload number-text sem repetir o POST', async () => {
    const fetchMock = mockFetch(
      new Response(JSON.stringify({ key: { id: 'provider-message-1' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await gateway().send({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: 'Mensagem de teste',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.test/message/sendText/lume%20tenant',
      expect.objectContaining({
        method: 'POST',
        headers: {
          apikey: apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          number: '5534999999999',
          text: 'Mensagem de teste',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual({
      outcome: 'confirmed',
      deliveryStatus: 'sent',
      providerMessageId: 'provider-message-1',
      httpStatus: 201,
      requiresReconciliation: false,
    });
  });

  it('mantém legacy-text como alias do payload number-text', async () => {
    const fetchMock = mockFetch(
      new Response(JSON.stringify({ key: { id: 'legacy-message-id' } }), {
        status: 200,
      }),
    );

    await gateway({ EVOLUTION_SEND_TEXT_PAYLOAD_MODE: 'legacy-text' }).send({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: 'Compatibilidade',
    });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(typeof request?.body).toBe('string');
    expect(JSON.parse(request?.body as string)).toEqual({
      number: '5534999999999',
      text: 'Compatibilidade',
    });
  });

  it('trata resposta 2xx sem identificador como ambígua', async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }));

    const result = await gateway().send({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: 'Sem identificador',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      outcome: 'ambiguous',
      deliveryStatus: 'pending',
      errorCode: 'EVOLUTION_DISPATCH_UNCONFIRMED',
      errorMessage: 'O provedor respondeu sem confirmação inequívoca do envio.',
      httpStatus: 204,
      requiresReconciliation: true,
    });
  });

  it('envia texto no payload textMessage quando configurado', async () => {
    const fetchMock = mockFetch(
      new Response(JSON.stringify({ response: { key: { id: 'nested-id' } } }), {
        status: 200,
      }),
    );

    const result = await gateway({
      EVOLUTION_SEND_TEXT_PAYLOAD_MODE: 'textMessage',
    }).send({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: 'Payload alternativo',
    });

    const request = fetchMock.mock.calls[0]?.[1];
    expect(typeof request?.body).toBe('string');
    expect(JSON.parse(request?.body as string)).toEqual({
      number: '5534999999999',
      textMessage: { text: 'Payload alternativo' },
    });
    expect(result).toMatchObject({
      outcome: 'confirmed',
      providerMessageId: 'nested-id',
    });
  });

  it('envia PDF no multipart compatível com o fluxo atual', async () => {
    const fetchMock = mockFetch(
      new Response(JSON.stringify({ messageId: 'document-id' }), {
        status: 200,
      }),
    );
    const content = Buffer.from('%PDF-1.7\nconteudo\n%%EOF');

    const result = await gateway().send({
      kind: 'document',
      recipientPhone: '5534999999999',
      fileName: 'orcamento.pdf',
      mimeType: 'application/pdf',
      content,
      caption: 'Segue o orçamento solicitado.',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      'https://evolution.example.test/message/sendMedia/lume%20tenant',
    );
    expect(request?.headers).toEqual({ apikey: apiKey });
    expect(request?.body).toBeInstanceOf(FormData);

    const form = request?.body as FormData;
    expect(form.get('number')).toBe('5534999999999');
    expect(form.get('mediatype')).toBe('document');
    expect(form.get('mimetype')).toBe('application/pdf');
    expect(form.get('fileName')).toBe('orcamento.pdf');
    expect(form.get('caption')).toBe('Segue o orçamento solicitado.');

    const file = form.get('file');
    expect(file).toBeInstanceOf(Blob);
    expect(Buffer.from(await (file as Blob).arrayBuffer())).toEqual(content);
    expect(result).toMatchObject({
      outcome: 'confirmed',
      providerMessageId: 'document-id',
    });
  });

  it('trata HTTP não 2xx como ambíguo e nunca repete o envio', async () => {
    const fetchMock = mockFetch(
      new Response(JSON.stringify({ internal: 'must-not-leak' }), {
        status: 503,
      }),
    );

    const result = await gateway().send({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: 'Sem retry automático',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      outcome: 'ambiguous',
      deliveryStatus: 'pending',
      errorCode: 'EVOLUTION_DISPATCH_UNCONFIRMED',
      errorMessage: 'O provedor respondeu sem confirmação inequívoca do envio.',
      httpStatus: 503,
      requiresReconciliation: true,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it('trata falha de rede como ambígua e nunca repete o envio', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(`request failed with apikey=${apiKey}`));
    vi.stubGlobal('fetch', fetchMock);

    const result = await gateway().send({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: 'Sem confirmação',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      outcome: 'ambiguous',
      deliveryStatus: 'pending',
      errorCode: 'EVOLUTION_DISPATCH_NETWORK_ERROR',
      errorMessage: 'A chamada terminou sem confirmação inequívoca do envio.',
      requiresReconciliation: true,
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it('aborta no timeout e não inicia uma segunda chamada', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pendingResult = gateway({
      EVOLUTION_SEND_TEXT_TIMEOUT_MS: 25,
    }).send({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: 'Timeout',
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pendingResult).resolves.toEqual({
      outcome: 'ambiguous',
      deliveryStatus: 'pending',
      errorCode: 'EVOLUTION_DISPATCH_TIMEOUT',
      errorMessage:
        'O tempo limite expirou sem confirmação inequívoca do envio.',
      requiresReconciliation: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('não chama o provedor quando configuração ou entrada são inválidas', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const missingConfiguration = await gateway({
      EVOLUTION_API_KEY: '',
    }).send({
      kind: 'text',
      recipientPhone: '5534999999999',
      text: 'Mensagem',
    });
    const invalidDocument = await gateway().send({
      kind: 'document',
      recipientPhone: '5534999999999',
      fileName: 'arquivo.jpg',
      mimeType: 'image/jpeg',
      content: Buffer.from('imagem'),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(missingConfiguration).toMatchObject({
      outcome: 'not-sent',
      errorCode: 'EVOLUTION_CONFIGURATION_INVALID',
    });
    expect(invalidDocument).toMatchObject({
      outcome: 'not-sent',
      errorCode: 'EVOLUTION_OUTBOUND_INVALID',
    });
  });
});

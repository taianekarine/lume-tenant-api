import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResendSupportRequestNotifier } from './resend-support-request.notifier';

function notifier() {
  return new ResendSupportRequestNotifier(
    new ConfigService({
      EMAIL_DELIVERY_ENABLED: true,
      RESEND_API_URL: 'https://api.resend.com',
      RESEND_API_KEY: 're_test_key_with_enough_characters',
      RESEND_FROM_EMAIL: 'onboarding@resend.dev',
      RESEND_FROM_NAME: 'Lume',
      RESEND_REQUEST_TIMEOUT_MS: 10_000,
      RESEND_MAX_ATTEMPTS: 1,
      RESEND_RETRY_DELAY_MS: 0,
      SUPPORT_RECIPIENT_EMAIL: 'devops@mileniumturismo.com.br',
      SUPPORT_CC_EMAIL:
        'taiane.karine@mileniumturismo.com.br, taianekas.dev@outlook.com',
    }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResendSupportRequestNotifier', () => {
  it('preserves formatted content and includes requester identity', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resend-support-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const service = notifier();

    await expect(
      service.send({
        requestId: '00000000-0000-4000-8000-000000000999',
        requesterName: 'Atendente <Teste>',
        requesterUsername: 'atendente.teste',
        requesterEmail: 'atendente@example.com',
        subject: 'Falha no painel',
        message: 'Primeira linha\nSegunda linha',
        idempotencyKey: 'support-request:test',
      }),
    ).resolves.toEqual({
      providerMessageId: 'resend-support-id',
      recipient: 'devops@mileniumturismo.com.br',
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(typeof request.body).toBe('string');
    if (typeof request.body !== 'string') {
      throw new Error('O corpo enviado ao Resend deveria ser JSON textual.');
    }
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: 'Lume <onboarding@resend.dev>',
      to: ['devops@mileniumturismo.com.br'],
      cc: ['taiane.karine@mileniumturismo.com.br', 'taianekas.dev@outlook.com'],
      subject: '[Lume] Falha no painel',
    });
    expect(String(body.html)).toContain('Primeira linha<br>Segunda linha');
    expect(String(body.html)).toContain('Atendente &lt;Teste&gt;');
    expect(String(body.text)).toContain('Usuário: atendente.teste');
    expect((request.headers as Record<string, string>)['Idempotency-Key']).toBe(
      'support-request:test',
    );
  });

  it('normalizes duplicate copies and never copies the primary recipient', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'resend-support-id' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const service = new ResendSupportRequestNotifier(
      new ConfigService({
        EMAIL_DELIVERY_ENABLED: true,
        RESEND_API_URL: 'https://api.resend.com',
        RESEND_API_KEY: 're_test_key_with_enough_characters',
        RESEND_FROM_EMAIL: 'onboarding@resend.dev',
        RESEND_FROM_NAME: 'Lume',
        RESEND_REQUEST_TIMEOUT_MS: 10_000,
        RESEND_MAX_ATTEMPTS: 1,
        RESEND_RETRY_DELAY_MS: 0,
        SUPPORT_RECIPIENT_EMAIL: 'devops@mileniumturismo.com.br',
        SUPPORT_CC_EMAIL:
          'devops@mileniumturismo.com.br, copy@example.com, COPY@example.com',
      }),
    );

    await service.send({
      requestId: '00000000-0000-4000-8000-000000000999',
      requesterName: 'Atendente Teste',
      requesterUsername: 'atendente.teste',
      requesterEmail: 'atendente@example.com',
      subject: 'Falha no painel',
      message: 'Primeira linha\nSegunda linha',
      idempotencyKey: 'support-request:test',
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    if (typeof request.body !== 'string') {
      throw new Error('O corpo enviado ao Resend deveria ser JSON textual.');
    }
    expect(JSON.parse(request.body)).toMatchObject({
      to: ['devops@mileniumturismo.com.br'],
      cc: ['copy@example.com'],
    });
  });
});

import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ResendPasswordResetNotifier } from './resend-password-reset.notifier';

function createNotifier() {
  return new ResendPasswordResetNotifier(
    new ConfigService({
      EMAIL_DELIVERY_ENABLED: true,
      RESEND_API_URL: 'https://api.resend.com',
      RESEND_API_KEY: 're_test_key_with_enough_characters',
      RESEND_FROM_EMAIL: 'no-reply@example.test',
      RESEND_FROM_NAME: 'Lume',
      RESEND_REQUEST_TIMEOUT_MS: 10_000,
      RESEND_MAX_ATTEMPTS: 2,
      RESEND_RETRY_DELAY_MS: 0,
    }),
  );
}

describe('ResendPasswordResetNotifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends an idempotent HTML and text reset e-mail with account data', async () => {
    const request = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', request);

    await createNotifier().send({
      recipientName: 'Ana <Souza>',
      recipientUsername: 'ana.souza',
      recipientEmail: 'ana@example.test',
      idempotencyKey: '00000000-0000-4000-8000-000000000001',
      resetUrl: 'https://app.example.test/reset-password?token=opaque&next=1',
      expiresAt: new Date('2026-07-28T18:00:00.000Z'),
    });

    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test_key_with_enough_characters',
      'Idempotency-Key': '00000000-0000-4000-8000-000000000001',
      'User-Agent': '@tks-lume/tenant-api/0.1.0',
    });
    expect(typeof init.body).toBe('string');
    const body = JSON.parse(init.body as string) as {
      html: string;
      text: string;
      to: string[];
    };
    expect(body.to).toEqual(['ana@example.test']);
    expect(body.text).toContain('Usuário: ana.souza');
    expect(body.text).toContain('E-mail: ana@example.test');
    expect(body.html).toContain('Ana &lt;Souza&gt;');
    expect(body.html).toContain('token=opaque&amp;next=1');
    expect(body.html).not.toContain('Ana <Souza>');
  });

  it('reports provider failures without exposing the response body or API key', async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });
    vi.stubGlobal('fetch', request);

    await expect(
      createNotifier().send({
        recipientName: 'Ana',
        recipientUsername: 'ana',
        recipientEmail: 'ana@example.test',
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
        resetUrl: 'https://app.example.test/reset-password?token=opaque',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow('Serviço de e-mail indisponível (HTTP 429).');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('normalizes timeout and network errors', async () => {
    const request = vi.fn().mockRejectedValue(new Error('socket'));
    vi.stubGlobal('fetch', request);

    await expect(
      createNotifier().send({
        recipientName: 'Ana',
        recipientUsername: 'ana',
        recipientEmail: 'ana@example.test',
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
        resetUrl: 'https://app.example.test/reset-password?token=opaque',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow('Serviço de e-mail indisponível.');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('retries a transient provider failure with the same idempotency key', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', request);

    await expect(
      createNotifier().send({
        recipientName: 'Ana',
        recipientUsername: 'ana',
        recipientEmail: 'ana@example.test',
        idempotencyKey: '00000000-0000-4000-8000-000000000001',
        resetUrl: 'https://app.example.test/reset-password?token=opaque',
        expiresAt: new Date(),
      }),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][1]?.headers).toMatchObject({
      'Idempotency-Key': '00000000-0000-4000-8000-000000000001',
    });
    expect(request.mock.calls[1][1]?.headers).toMatchObject({
      'Idempotency-Key': '00000000-0000-4000-8000-000000000001',
    });
  });
});

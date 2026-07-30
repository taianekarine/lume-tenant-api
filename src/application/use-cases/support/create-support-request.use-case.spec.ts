import { describe, expect, it, vi } from 'vitest';

import {
  SupportRequestNotifier,
  type SupportRequestNotification,
} from '../../contracts/notifications';
import { AppError } from '../../../core/errors/app-error';
import { CreateSupportRequestUseCase } from './create-support-request.use-case';

class RecordingNotifier extends SupportRequestNotifier {
  readonly notifications: SupportRequestNotification[] = [];

  constructor(
    readonly configured = true,
    private readonly failure?: Error,
  ) {
    super();
  }

  async send(notification: SupportRequestNotification) {
    this.notifications.push(notification);
    if (this.failure) throw this.failure;
    return {
      providerMessageId: 'resend-message-id',
      recipient: 'suporte@example.com',
    };
  }
}

function input() {
  return {
    companyId: '00000000-0000-4000-8000-000000000222',
    userId: '00000000-0000-4000-8000-000000000111',
    requesterName: 'Atendente Teste',
    requesterUsername: 'atendente.teste',
    requesterEmail: 'atendente@example.com',
    subject: 'Falha no atendimento',
    message: 'A conversa não foi carregada após atualizar a página.',
  };
}

describe('CreateSupportRequestUseCase', () => {
  it('derives requester identity and records a delivered support request', async () => {
    const notifier = new RecordingNotifier();
    const create = vi.fn();
    const useCase = new CreateSupportRequestUseCase(notifier, {
      create,
    });

    await expect(useCase.execute(input())).resolves.toMatchObject({
      status: 'sent',
      recipient: 'suporte@example.com',
      providerMessageId: 'resend-message-id',
    });
    expect(notifier.notifications[0]).toMatchObject({
      requesterName: 'Atendente Teste',
      requesterUsername: 'atendente.teste',
      requesterEmail: 'atendente@example.com',
      subject: 'Falha no atendimento',
    });
    expect(notifier.notifications[0].idempotencyKey).toMatch(
      /^support-request:/,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SUPPORT_REQUEST_SENT' }),
    );
  });

  it('returns an explicit fallback contract when the provider is disabled', async () => {
    const useCase = new CreateSupportRequestUseCase(
      new RecordingNotifier(false),
      { create: vi.fn() },
    );

    await expect(useCase.execute(input())).rejects.toMatchObject<AppError>({
      code: 'EMAIL_DELIVERY_UNAVAILABLE',
      details: expect.objectContaining({ fallbackAllowed: true }),
    });
  });

  it('returns a public provider failure code without exposing the message', async () => {
    const create = vi.fn();
    const useCase = new CreateSupportRequestUseCase(
      new RecordingNotifier(
        true,
        new Error('Serviço de e-mail indisponível (HTTP 403).'),
      ),
      { create },
    );

    await expect(useCase.execute(input())).rejects.toMatchObject<AppError>({
      code: 'SUPPORT_EMAIL_DELIVERY_FAILED',
      details: expect.objectContaining({
        failureCode: 'HTTP_403',
        fallbackAllowed: true,
      }),
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SUPPORT_REQUEST_DELIVERY_FAILED',
        metadata: { failureCode: 'HTTP_403' },
      }),
    );
  });

  it('keeps the provider outcome authoritative when audit persistence fails', async () => {
    const delivered = new CreateSupportRequestUseCase(new RecordingNotifier(), {
      create: vi.fn().mockRejectedValue(new Error('audit unavailable')),
    });
    await expect(delivered.execute(input())).resolves.toMatchObject({
      status: 'sent',
      providerMessageId: 'resend-message-id',
    });

    const failed = new CreateSupportRequestUseCase(
      new RecordingNotifier(
        true,
        new Error('Serviço de e-mail indisponível (HTTP 503).'),
      ),
      { create: vi.fn().mockRejectedValue(new Error('audit unavailable')) },
    );
    await expect(failed.execute(input())).rejects.toMatchObject<AppError>({
      code: 'SUPPORT_EMAIL_DELIVERY_FAILED',
      details: expect.objectContaining({
        failureCode: 'HTTP_503',
        fallbackAllowed: true,
      }),
    });
  });
});

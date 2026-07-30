import { randomUUID } from 'node:crypto';

import {
  SupportRequestNotifier,
  type SupportRequestDelivery,
} from '../../contracts/notifications';
import { TenantAuditLogsRepository } from '../../contracts/repositories';
import { AppError, validationError } from '../../../core/errors/app-error';

function deliveryFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return 'PROVIDER_UNAVAILABLE';
  const status = /HTTP (\d{3})/.exec(error.message)?.[1];
  return status ? `HTTP_${status}` : 'PROVIDER_UNAVAILABLE';
}

export interface CreateSupportRequestInput {
  companyId: string;
  userId: string;
  requesterName: string;
  requesterUsername: string;
  requesterEmail: string;
  subject: string;
  message: string;
}

export class CreateSupportRequestUseCase {
  constructor(
    private readonly notifier: SupportRequestNotifier,
    private readonly auditLogs: TenantAuditLogsRepository,
  ) {}

  private async recordAudit(
    input: Parameters<TenantAuditLogsRepository['create']>[0],
  ): Promise<void> {
    try {
      await this.auditLogs.create(input);
    } catch {
      // O resultado já confirmado pelo provedor continua sendo autoritativo.
    }
  }

  async execute(input: CreateSupportRequestInput) {
    const subject = input.subject.trim();
    const message = input.message.trim();
    if (subject.length < 5 || subject.length > 120) {
      throw validationError('O assunto deve possuir entre 5 e 120 caracteres.');
    }
    if (message.length < 20 || message.length > 4_000) {
      throw validationError(
        'A mensagem deve possuir entre 20 e 4000 caracteres.',
      );
    }

    const requestId = randomUUID();
    if (!this.notifier.configured) {
      throw new AppError(
        'EMAIL_DELIVERY_UNAVAILABLE',
        'O provedor de e-mail de suporte não está configurado.',
        { requestId, fallbackAllowed: true },
      );
    }

    let delivery: SupportRequestDelivery;
    try {
      delivery = await this.notifier.send({
        requestId,
        requesterName: input.requesterName,
        requesterUsername: input.requesterUsername,
        requesterEmail: input.requesterEmail,
        subject,
        message,
        idempotencyKey: `support-request:${requestId}`,
      });
    } catch (error) {
      const failureCode = deliveryFailureCode(error);
      await this.recordAudit({
        companyId: input.companyId,
        actorUserId: input.userId,
        action: 'SUPPORT_REQUEST_DELIVERY_FAILED',
        targetType: 'support-request',
        targetId: requestId,
        metadata: { failureCode },
      });
      throw new AppError(
        'SUPPORT_EMAIL_DELIVERY_FAILED',
        'Não foi possível enviar a solicitação pelo provedor de e-mail.',
        { requestId, failureCode, fallbackAllowed: true },
      );
    }

    await this.recordAudit({
      companyId: input.companyId,
      actorUserId: input.userId,
      action: 'SUPPORT_REQUEST_SENT',
      targetType: 'support-request',
      targetId: requestId,
      metadata: {
        providerMessageId: delivery.providerMessageId,
      },
    });
    return {
      id: requestId,
      status: 'sent' as const,
      recipient: delivery.recipient,
      providerMessageId: delivery.providerMessageId,
    };
  }
}

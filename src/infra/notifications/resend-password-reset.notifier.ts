import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  PasswordResetNotifier,
  type PasswordResetNotification,
} from '../../application/contracts/notifications';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

@Injectable()
export class ResendPasswordResetNotifier extends PasswordResetNotifier {
  readonly configured: boolean;

  constructor(private readonly config: ConfigService) {
    super();
    this.configured =
      this.config.get<boolean>('EMAIL_DELIVERY_ENABLED') === true;
  }

  async send(notification: PasswordResetNotification): Promise<void> {
    if (!this.configured) {
      throw new Error('Entrega de e-mail não configurada.');
    }

    const senderName = sanitizeHeaderValue(
      this.config.getOrThrow<string>('RESEND_FROM_NAME'),
    );
    const senderEmail = sanitizeHeaderValue(
      this.config.getOrThrow<string>('RESEND_FROM_EMAIL'),
    );
    const recipientName = notification.recipientName;
    const recipientUsername = notification.recipientUsername;
    const recipientEmail = notification.recipientEmail;
    const resetUrl = notification.resetUrl;
    const expiresAt = notification.expiresAt.toISOString();
    const subject = 'Crie uma nova senha de acesso ao Lume';
    const text = [
      `Olá, ${recipientName}.`,
      'Foi solicitada a criação de uma nova senha para sua conta Lume.',
      `Nome: ${recipientName}`,
      `Usuário: ${recipientUsername}`,
      `E-mail: ${recipientEmail}`,
      `Criar nova senha: ${resetUrl}`,
      `Este link é de uso único e expira em ${expiresAt}.`,
      'Se você não reconhece esta solicitação, informe o administrador.',
    ].join('\n\n');
    const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:#f6f7f9;font-family:Arial,sans-serif;color:#111827">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:32px 16px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px">
            <tr>
              <td style="padding:32px">
                <h1 style="margin:0 0 16px;font-size:24px">Crie uma nova senha</h1>
                <p style="margin:0 0 20px;line-height:1.6">Olá, ${escapeHtml(recipientName)}. Foi solicitada a criação de uma nova senha para sua conta Lume.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 24px;border-collapse:collapse">
                  <tr><td style="padding:6px 0;color:#6b7280">Nome</td><td style="padding:6px 0;text-align:right">${escapeHtml(recipientName)}</td></tr>
                  <tr><td style="padding:6px 0;color:#6b7280">Usuário</td><td style="padding:6px 0;text-align:right">${escapeHtml(recipientUsername)}</td></tr>
                  <tr><td style="padding:6px 0;color:#6b7280">E-mail</td><td style="padding:6px 0;text-align:right">${escapeHtml(recipientEmail)}</td></tr>
                </table>
                <p style="margin:0 0 24px"><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px">Criar nova senha</a></p>
                <p style="margin:0 0 12px;color:#4b5563;line-height:1.6">Este link é de uso único e expira em ${escapeHtml(expiresAt)}.</p>
                <p style="margin:0;color:#4b5563;line-height:1.6">Se você não reconhece esta solicitação, informe o administrador.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

    const maximumAttempts = this.config.get<number>('RESEND_MAX_ATTEMPTS') ?? 2;
    const retryDelayMs =
      this.config.get<number>('RESEND_RETRY_DELAY_MS') ?? 150;
    let lastStatus: number | null = null;

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        const response = await fetch(
          `${this.config.getOrThrow<string>('RESEND_API_URL')}/emails`,
          {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${this.config.getOrThrow<string>('RESEND_API_KEY')}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': notification.idempotencyKey,
              'User-Agent': '@tks-lume/tenant-api/0.1.0',
            },
            body: JSON.stringify({
              from: `${senderName} <${senderEmail}>`,
              to: [recipientEmail],
              subject,
              html,
              text,
            }),
            signal: AbortSignal.timeout(
              this.config.getOrThrow<number>('RESEND_REQUEST_TIMEOUT_MS'),
            ),
          },
        );
        if (response.ok) return;
        lastStatus = response.status;
        if (
          response.status !== 408 &&
          response.status !== 429 &&
          response.status < 500
        ) {
          break;
        }
      } catch {
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
}

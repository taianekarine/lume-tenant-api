import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  SupportRequestNotifier,
  type SupportRequestNotification,
} from '../../application/contracts/notifications';
import { escapeEmailHtml, sendResendEmail } from './resend-email.client';

function messageHtml(value: string): string {
  return escapeEmailHtml(value).replace(/\r?\n/g, '<br>');
}

function emailList(value: string | undefined): string[] {
  const seen = new Set<string>();
  return (value ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean)
    .filter((address) => {
      const normalized = address.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

@Injectable()
export class ResendSupportRequestNotifier extends SupportRequestNotifier {
  readonly configured: boolean;

  constructor(private readonly config: ConfigService) {
    super();
    this.configured =
      this.config.get<boolean>('EMAIL_DELIVERY_ENABLED') === true &&
      Boolean(this.config.get<string>('SUPPORT_RECIPIENT_EMAIL'));
  }

  async send(notification: SupportRequestNotification) {
    if (!this.configured) {
      throw new Error('Entrega de e-mail de suporte não configurada.');
    }

    const recipient = this.config.getOrThrow<string>('SUPPORT_RECIPIENT_EMAIL');
    const cc = emailList(this.config.get<string>('SUPPORT_CC_EMAIL')).filter(
      (address) => address.toLowerCase() !== recipient.toLowerCase(),
    );
    const subject = `[Lume] ${notification.subject}`;
    const text = [
      notification.message,
      '',
      'Dados do solicitante',
      `Nome: ${notification.requesterName}`,
      `Usuário: ${notification.requesterUsername}`,
      `E-mail: ${notification.requesterEmail}`,
      `Código do chamado: ${notification.requestId}`,
    ].join('\n');
    const html = `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;background:#f6f7f9;font-family:Arial,sans-serif;color:#111827">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f6f7f9;padding:32px 16px">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px">
            <tr>
              <td style="padding:32px">
                <h1 style="margin:0 0 16px;font-size:24px">${escapeEmailHtml(notification.subject)}</h1>
                <div style="margin:0 0 24px;line-height:1.6;white-space:pre-wrap">${messageHtml(notification.message)}</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border-top:1px solid #e5e7eb;padding-top:16px">
                  <tr><td style="padding:16px 0 6px;color:#6b7280">Nome</td><td style="padding:16px 0 6px;text-align:right">${escapeEmailHtml(notification.requesterName)}</td></tr>
                  <tr><td style="padding:6px 0;color:#6b7280">Usuário</td><td style="padding:6px 0;text-align:right">${escapeEmailHtml(notification.requesterUsername)}</td></tr>
                  <tr><td style="padding:6px 0;color:#6b7280">E-mail</td><td style="padding:6px 0;text-align:right">${escapeEmailHtml(notification.requesterEmail)}</td></tr>
                  <tr><td style="padding:6px 0;color:#6b7280">Código</td><td style="padding:6px 0;text-align:right">${escapeEmailHtml(notification.requestId)}</td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
    const delivered = await sendResendEmail(this.config, {
      idempotencyKey: notification.idempotencyKey,
      to: [recipient],
      ...(cc.length ? { cc } : {}),
      subject,
      html,
      text,
    });
    return { ...delivered, recipient };
  }
}

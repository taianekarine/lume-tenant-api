export interface PasswordResetNotification {
  readonly recipientName: string;
  readonly recipientUsername: string;
  readonly recipientEmail: string;
  readonly idempotencyKey: string;
  readonly resetUrl: string;
  readonly expiresAt: Date;
}

export abstract class PasswordResetNotifier {
  abstract readonly configured: boolean;
  abstract send(notification: PasswordResetNotification): Promise<void>;
}

export interface SupportRequestNotification {
  readonly requestId: string;
  readonly requesterName: string;
  readonly requesterUsername: string;
  readonly requesterEmail: string;
  readonly subject: string;
  readonly message: string;
  readonly idempotencyKey: string;
}

export interface SupportRequestDelivery {
  readonly providerMessageId: string;
  readonly recipient: string;
}

export abstract class SupportRequestNotifier {
  abstract readonly configured: boolean;
  abstract send(
    notification: SupportRequestNotification,
  ): Promise<SupportRequestDelivery>;
}

export type AppErrorCode =
  | 'ACCOUNT_INACTIVE'
  | 'ACCOUNT_PASSWORD_SETUP_REQUIRED'
  | 'ACCOUNT_SUSPENDED'
  | 'CONFLICT'
  | 'CONVERSION_NOT_SUPPORTED'
  | 'EMAIL_DELIVERY_UNAVAILABLE'
  | 'EXTERNAL_SERVICE_UNAVAILABLE'
  | 'FORBIDDEN'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_PASSWORD_CHANGE_TOKEN'
  | 'INVALID_REFRESH_TOKEN'
  | 'LICENSE_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'QUOTE_CONVERSATION_CLOSED'
  | 'SUPPORT_EMAIL_DELIVERY_FAILED'
  | 'UNSUPPORTED_FILE_FORMAT'
  | 'VALIDATION_ERROR';

export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function conflict(message: string, field?: string): AppError {
  return new AppError('CONFLICT', message, field ? { field } : undefined);
}

export function forbidden(
  message = 'Você não possui permissão para esta operação.',
): AppError {
  return new AppError('FORBIDDEN', message);
}

export function externalServiceUnavailable(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError {
  return new AppError('EXTERNAL_SERVICE_UNAVAILABLE', message, details);
}

export function notFound(resource: string): AppError {
  return new AppError('NOT_FOUND', `${resource} não encontrado.`);
}

export function validationError(message: string): AppError {
  return new AppError('VALIDATION_ERROR', message);
}

export function unsupportedFileFormat(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError {
  return new AppError('UNSUPPORTED_FILE_FORMAT', message, details);
}

export function conversionNotSupported(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AppError {
  return new AppError('CONVERSION_NOT_SUPPORTED', message, details);
}

export function licenseUnavailable(message: string): AppError {
  return new AppError('LICENSE_UNAVAILABLE', message);
}

export type AppErrorCode =
  | 'CONFLICT'
  | 'FORBIDDEN'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_REFRESH_TOKEN'
  | 'LICENSE_UNAVAILABLE'
  | 'NOT_FOUND'
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

export function notFound(resource: string): AppError {
  return new AppError('NOT_FOUND', `${resource} não encontrado.`);
}

export function validationError(message: string): AppError {
  return new AppError('VALIDATION_ERROR', message);
}

export function licenseUnavailable(message: string): AppError {
  return new AppError('LICENSE_UNAVAILABLE', message);
}

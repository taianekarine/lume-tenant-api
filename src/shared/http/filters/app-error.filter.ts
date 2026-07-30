import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AppError, type AppErrorCode } from '../../../core/errors/app-error';

const statusByCode: Readonly<Record<AppErrorCode, HttpStatus>> = {
  ACCOUNT_INACTIVE: HttpStatus.FORBIDDEN,
  ACCOUNT_PASSWORD_SETUP_REQUIRED: HttpStatus.FORBIDDEN,
  ACCOUNT_SUSPENDED: HttpStatus.LOCKED,
  CONFLICT: HttpStatus.CONFLICT,
  CONVERSION_NOT_SUPPORTED: HttpStatus.UNPROCESSABLE_ENTITY,
  EMAIL_DELIVERY_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  INVALID_PASSWORD_CHANGE_TOKEN: HttpStatus.UNAUTHORIZED,
  INVALID_REFRESH_TOKEN: HttpStatus.UNAUTHORIZED,
  LICENSE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  QUOTE_CONVERSATION_CLOSED: HttpStatus.CONFLICT,
  SUPPORT_EMAIL_DELIVERY_FAILED: HttpStatus.SERVICE_UNAVAILABLE,
  UNSUPPORTED_FILE_FORMAT: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
};

@Catch(AppError)
export class AppErrorFilter implements ExceptionFilter<AppError> {
  catch(exception: AppError, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const statusCode = statusByCode[exception.code];

    response.status(statusCode).json({
      statusCode,
      code: exception.code,
      message: exception.message,
      details: exception.details,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

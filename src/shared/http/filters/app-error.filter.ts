import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { AppError, type AppErrorCode } from '../../../core/errors/app-error';

const statusByCode: Readonly<Record<AppErrorCode, HttpStatus>> = {
  CONFLICT: HttpStatus.CONFLICT,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  INVALID_CREDENTIALS: HttpStatus.UNAUTHORIZED,
  INVALID_REFRESH_TOKEN: HttpStatus.UNAUTHORIZED,
  LICENSE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  NOT_FOUND: HttpStatus.NOT_FOUND,
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

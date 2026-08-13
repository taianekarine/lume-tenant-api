import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { ApiUsageRecorderService } from './api-usage-recorder.service';

interface RequestWithPrincipal extends Request {
  user?: AuthenticatedPrincipal;
}

function safeByteCount(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 2_147_483_647)
    : 0;
}

export function normalizedRequestRoute(request: Request): string {
  const matchedRoute = (request as unknown as { route?: { path?: unknown } })
    .route;
  const routePath =
    typeof matchedRoute?.path === 'string'
      ? matchedRoute.path
      : request.path
          .replace(
            /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
            ':id',
          )
          .replace(/\/\d+(?=\/|$)/g, '/:id');
  return `${request.baseUrl ?? ''}${routePath}`
    .replace(/^\/api\/v\d+/, '')
    .replace(/\/{2,}/g, '/')
    .slice(0, 240);
}

@Injectable()
export class ApiUsageInterceptor implements NestInterceptor {
  constructor(private readonly recorder: ApiUsageRecorderService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const response = context.switchToHttp().getResponse<Response>();
    const principal = request.user;
    const route = normalizedRequestRoute(request);
    if (!principal || route.startsWith('/administration/usage')) {
      return next.handle();
    }
    const startedAt = performance.now();
    response.once('finish', () => {
      this.recorder.record({
        companyId: principal.companyId,
        userId: principal.id,
        method: request.method.slice(0, 10),
        route,
        statusCode: response.statusCode,
        requestBytes: safeByteCount(request.header('content-length')),
        responseBytes: safeByteCount(
          response.getHeader('content-length')?.toString(),
        ),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    });
    return next.handle();
  }
}

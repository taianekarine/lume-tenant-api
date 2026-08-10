import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface ServicePrincipal {
  id: string;
  companyId: string;
  type: 'internal-automation';
  name: string;
}

export interface ServiceAuthenticatedRequest extends Request {
  serviceIdentity: ServicePrincipal;
}

export const CurrentService = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ServicePrincipal => {
    return context.switchToHttp().getRequest<ServiceAuthenticatedRequest>()
      .serviceIdentity;
  },
);

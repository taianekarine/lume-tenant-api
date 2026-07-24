import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedPrincipal } from '../../../application/presenters/user.presenter';

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedPrincipal;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedPrincipal => {
    return context.switchToHttp().getRequest<AuthenticatedRequest>().user;
  },
);

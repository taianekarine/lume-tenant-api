import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { PermissionCode } from '../../../domain/access/access.constants';
import type { AuthenticatedRequest } from '../decorators/current-user.decorator';
import { REQUIRED_PERMISSIONS } from '../decorators/require-permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionCode[]>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );

    if (!required?.length) {
      return true;
    }

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;

    if (
      !user ||
      !required.some((permission) => user.permissions.includes(permission))
    ) {
      throw new ForbiddenException(
        'Você não possui permissão para esta operação.',
      );
    }

    return true;
  }
}

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  AccessTokenService,
  OfflineLicenseVerifier,
} from '../../../application/contracts/cryptography';
import { UsersRepository } from '../../../application/contracts/repositories';
import { toAuthenticatedPrincipal } from '../../../application/presenters/user.presenter';
import { type AuthenticatedRequest } from '../decorators/current-user.decorator';
import { IS_PUBLIC_ROUTE } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly users: UsersRepository,
    private readonly license: OfflineLicenseVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_ROUTE,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Autenticação necessária.');
    }

    try {
      const licensedTenantId = this.license.status().payload.tenantId;
      const payload = await this.accessTokens.verify(authorization.slice(7));
      if (payload.companyId !== licensedTenantId) {
        throw new Error('Tenant mismatch.');
      }
      const record = await this.users.findById(payload.companyId, payload.sub);

      if (
        !record ||
        !record.user.props.isActive ||
        record.user.props.status !== 'active' ||
        record.user.props.mustChangePassword ||
        !record.companyIsActive ||
        record.user.props.tokenVersion !== payload.tokenVersion
      ) {
        throw new Error('Inactive identity.');
      }

      request.user = toAuthenticatedPrincipal(record);
      return true;
    } catch {
      throw new UnauthorizedException('Token de acesso inválido ou expirado.');
    }
  }
}

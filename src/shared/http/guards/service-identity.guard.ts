import { createHash, timingSafeEqual } from 'node:crypto';

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../../../infra/database/prisma/prisma.service';
import type { ServiceAuthenticatedRequest } from '../decorators/current-service.decorator';

@Injectable()
export class ServiceIdentityGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<ServiceAuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';
    const separator = token.indexOf('.');
    const keyId = separator > 0 ? token.slice(0, separator) : '';

    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        keyId,
      ) ||
      token.length < 48
    ) {
      throw new UnauthorizedException('Identidade de serviço inválida.');
    }

    const identity = await this.prisma.serviceIdentity.findUnique({
      where: { keyId },
    });
    const actualHash = createHash('sha256').update(token).digest();
    const expectedHash = identity
      ? Buffer.from(identity.secretHash, 'hex')
      : Buffer.alloc(actualHash.length);
    const valid =
      Boolean(identity?.enabled) &&
      actualHash.length === expectedHash.length &&
      timingSafeEqual(actualHash, expectedHash);

    if (!valid || !identity) {
      throw new UnauthorizedException('Identidade de serviço inválida.');
    }

    request.serviceIdentity = {
      id: identity.id,
      companyId: identity.companyId,
      type: 'n8n',
      name: identity.name,
    };
    await this.prisma.serviceIdentity.update({
      where: { id: identity.id },
      data: { lastUsedAt: new Date() },
    });
    return true;
  }
}

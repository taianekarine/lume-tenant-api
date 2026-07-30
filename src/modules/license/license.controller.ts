import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiForbiddenResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { OfflineLicenseVerifier } from '../../application/contracts/cryptography';
import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { forbidden } from '../../core/errors/app-error';
import { CurrentUser } from '../../shared/http/decorators/current-user.decorator';
import { RequireAnyPermission } from '../../shared/http/decorators/require-permissions.decorator';

@ApiTags('Licença local')
@ApiBearerAuth()
@SkipThrottle()
@Controller('license')
export class LicenseController {
  constructor(private readonly license: OfflineLicenseVerifier) {}

  @Get('status')
  @RequireAnyPermission('license:view')
  @ApiForbiddenResponse({
    description: 'Disponível somente para Administrador, Diretoria e Gerência.',
  })
  status(@CurrentUser() current: AuthenticatedPrincipal) {
    if (!current.departments.includes('management')) {
      throw forbidden(
        'A licença só pode ser consultada por usuários autorizados da Gerência.',
      );
    }

    const status = this.license.status();
    return {
      state: status.state,
      tenantId: status.payload.tenantId,
      installationId: status.payload.installationId,
      plan: status.payload.plan,
      features: status.payload.features,
      expiresAt: status.payload.expiresAt,
      graceUntil: status.payload.graceUntil,
    };
  }
}

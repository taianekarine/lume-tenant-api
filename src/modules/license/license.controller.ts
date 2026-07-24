import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { OfflineLicenseVerifier } from '../../application/contracts/cryptography';
import { Public } from '../../shared/http/decorators/public.decorator';

@ApiTags('Licença local')
@SkipThrottle()
@Controller('license')
export class LicenseController {
  constructor(private readonly license: OfflineLicenseVerifier) {}

  @Public()
  @Get('status')
  status() {
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

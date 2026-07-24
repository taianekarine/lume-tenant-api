import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';

import { OfflineLicenseVerifier } from '../../application/contracts/cryptography';
import { PrismaService } from '../../infra/database/prisma/prisma.service';
import { Public } from '../../shared/http/decorators/public.decorator';

@ApiTags('Saúde')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly license: OfflineLicenseVerifier,
  ) {}

  @Public()
  @Get()
  @ApiOkResponse({ description: 'Processo da API em execução.' })
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @ApiOkResponse({ description: 'API e PostgreSQL disponíveis.' })
  async readiness() {
    await this.prisma.$queryRaw`SELECT 1`;
    const license = this.license.status();
    return {
      status: 'ready',
      database: 'up',
      license: license.state,
      tenantId: license.payload.tenantId,
      timestamp: new Date().toISOString(),
    };
  }
}

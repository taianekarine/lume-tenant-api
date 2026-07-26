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
    const now = new Date();
    const [
      pendingOutbox,
      acceptedOutbox,
      expiredExecutionOutbox,
      deadOutbox,
      evolutionDispatchesRequiringReconciliation,
    ] = await this.prisma.$transaction([
      this.prisma.integrationOutbox.count({
        where: { status: { in: ['PENDING', 'PROCESSING'] } },
      }),
      this.prisma.integrationOutbox.count({
        where: {
          status: 'PROCESSING',
          lockId: null,
          executionLeaseUntil: { gt: now },
        },
      }),
      this.prisma.integrationOutbox.count({
        where: {
          status: 'PROCESSING',
          lockId: null,
          executionLeaseUntil: { lte: now },
        },
      }),
      this.prisma.integrationOutbox.count({ where: { status: 'DEAD' } }),
      this.prisma.whatsAppMessageAttempt.count({
        where: {
          OR: [
            { dispatchState: 'UNKNOWN' },
            {
              dispatchState: 'LEASED',
              dispatchLeaseUntil: { lte: now },
            },
          ],
        },
      }),
    ]);
    return {
      status: 'ready',
      database: 'up',
      integrations: {
        pendingOutbox,
        acceptedOutbox,
        expiredExecutionOutbox,
        deadOutbox,
        evolutionDispatchesRequiringReconciliation,
        // Alias compatível com os monitores existentes.
        unknownEvolutionDispatches: evolutionDispatchesRequiringReconciliation,
      },
      license: license.state,
      tenantId: license.payload.tenantId,
      timestamp: new Date().toISOString(),
    };
  }
}

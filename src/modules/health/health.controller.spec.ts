import { describe, expect, it, vi } from 'vitest';

import type { OfflineLicenseVerifier } from '../../application/contracts/cryptography';
import type { PrismaService } from '../../infra/database/prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('signals UNKNOWN and expired LEASED Evolution attempts for reconciliation', async () => {
    const outboxCount = vi.fn().mockResolvedValue(0);
    const reconciliationCount = vi.fn().mockResolvedValue(2);
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
      $transaction: vi.fn(
        async (operations: Array<Promise<number>>) =>
          await Promise.all(operations),
      ),
      integrationOutbox: { count: outboxCount },
      whatsAppMessageAttempt: { count: reconciliationCount },
    } as unknown as PrismaService;
    const license = {
      status: vi.fn().mockReturnValue({
        state: 'active',
        payload: {
          tenantId: '00000000-0000-4000-8000-000000000210',
        },
      }),
    } as unknown as OfflineLicenseVerifier;

    const result = await new HealthController(prisma, license).readiness();

    expect(reconciliationCount).toHaveBeenCalledWith({
      where: {
        OR: [
          { dispatchState: 'UNKNOWN' },
          {
            dispatchState: 'LEASED',
            dispatchLeaseUntil: { lte: expect.any(Date) },
          },
        ],
      },
    });
    expect(result.integrations).toMatchObject({
      evolutionDispatchesRequiringReconciliation: 2,
      unknownEvolutionDispatches: 2,
    });
  });
});

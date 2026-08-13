import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { ApiUsageService } from './api-usage.service';

function principal(isAdministrator: boolean): AuthenticatedPrincipal {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    companyId: '20000000-0000-4000-8000-000000000001',
    isAdministrator,
    departments: ['management'],
    permissions: ['settings:view'],
  } as AuthenticatedPrincipal;
}

describe('ApiUsageService', () => {
  it('rejects access from a non-administrator before querying metrics', async () => {
    const aggregate = vi.fn();
    const service = new ApiUsageService({
      apiRequestMetric: { aggregate },
    } as never);

    await expect(service.summary(principal(false), {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(aggregate).not.toHaveBeenCalled();
  });

  it('isolates the summary by company and returns a humanized action', async () => {
    const aggregate = vi.fn().mockResolvedValue({
      _count: { _all: 2 },
      _sum: { requestBytes: 100, responseBytes: 300 },
      _avg: { durationMs: 42 },
    });
    const groupBy = vi
      .fn()
      .mockResolvedValueOnce([
        {
          userId: '10000000-0000-4000-8000-000000000001',
          _count: { _all: 2 },
          _sum: { requestBytes: 100, responseBytes: 300 },
          _avg: { durationMs: 42 },
        },
      ])
      .mockResolvedValueOnce([
        {
          method: 'POST',
          route: '/document-management/items/:id/submissions/complete',
          _count: { _all: 2 },
          _sum: { requestBytes: 100, responseBytes: 300 },
          _avg: { durationMs: 42 },
        },
      ]);
    const prisma = {
      apiRequestMetric: {
        aggregate,
        count: vi.fn().mockResolvedValue(0),
        groupBy,
      },
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: '10000000-0000-4000-8000-000000000001',
            name: 'Administrador',
            email: 'admin@example.com',
            deletedAt: null,
          },
        ]),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };

    const result = await new ApiUsageService(prisma as never).summary(
      principal(true),
      {
        from: '2026-08-01',
        to: '2026-08-11',
      },
    );

    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: '20000000-0000-4000-8000-000000000001',
        }),
      }),
    );
    expect(result.actions).toEqual([
      expect.objectContaining({
        action: 'Enviar documento para análise',
        requests: 2,
        bytes: 400,
      }),
    ]);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import type { ListPermissionsUseCase } from '../../application/use-cases/access/list-permissions.use-case';
import { AccessController } from './access.controller';

function principal(
  departments: readonly string[],
  isAdministrator = false,
): AuthenticatedPrincipal {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    companyId: '00000000-0000-4000-8000-000000000002',
    departments,
    isAdministrator,
  } as AuthenticatedPrincipal;
}

describe('AccessController permission catalog', () => {
  it('allows TI to load the catalog required by the complete user wizard', () => {
    const listPermissions = { execute: vi.fn(() => ({ permissions: [] })) };
    const controller = new AccessController(
      listPermissions as unknown as ListPermissionsUseCase,
    );

    expect(
      controller.permissions(principal(['information-technology'])),
    ).toEqual({ permissions: [] });
    expect(listPermissions.execute).toHaveBeenCalledOnce();
  });

  it('does not expose the administrative catalog to an ordinary user', () => {
    const controller = new AccessController({
      execute: vi.fn(),
    });

    expect(() => controller.permissions(principal(['commercial']))).toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import { ListPermissionsUseCase } from './list-permissions.use-case';

describe('ListPermissionsUseCase', () => {
  it('publishes a curated department and resource-action catalog', () => {
    const catalog = new ListPermissionsUseCase().execute();

    expect(catalog.permissions).toContain('dashboard:view');
    expect(catalog.permissions).toContain('users:manage');
    expect(catalog.permissions).not.toContain('users:delete');
    expect(catalog.permissions).not.toContain('dashboard:delete');
    expect(catalog.actionsByResource.dashboard).toEqual(['view']);
    expect(catalog.departments).toHaveLength(10);
    expect(catalog.departments).toContainEqual({
      code: 'information-technology',
      name: 'Tecnologia da Informação (TI)',
    });
  });
});

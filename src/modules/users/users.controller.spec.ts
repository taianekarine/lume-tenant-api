import { describe, expect, it } from 'vitest';

import { REQUIRED_PERMISSIONS } from '../../shared/http/decorators/require-permissions.decorator';
import { UsersController } from './users.controller';

function permissionsFor(method: keyof UsersController): readonly string[] {
  const handler = Object.getOwnPropertyDescriptor(
    UsersController.prototype,
    method,
  )?.value as object;
  return Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) as string[];
}

describe('UsersController permissions', () => {
  it('separates user creation, access editing and status management', () => {
    expect(permissionsFor('create')).toEqual(['users:create']);
    expect(permissionsFor('update')).toEqual(['users:update', 'users:create']);
    expect(permissionsFor('resetPassword')).toEqual(['users:update']);
    expect(permissionsFor('status')).toEqual(['users:manage']);
  });

  it('does not expose the unsupported users:delete permission', () => {
    for (const method of [
      'create',
      'list',
      'get',
      'update',
      'status',
      'resetPassword',
    ] as const) {
      expect(permissionsFor(method)).not.toContain('users:delete');
    }
  });
});

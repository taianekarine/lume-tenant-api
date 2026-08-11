import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSION_CODES,
  ASSIGNABLE_DEPARTMENTS,
  DEFAULT_DEPARTMENT_PERMISSIONS,
  MANAGEMENT_DEPARTMENT_PERMISSIONS,
} from './access.constants';
import { resolveEffectivePermissions } from './resolve-permissions';

describe('resolveEffectivePermissions', () => {
  it('always grants dashboard, AI agent and employee self-service permissions', () => {
    expect(resolveEffectivePermissions([])).toEqual([
      'ai-agents:use',
      'dashboard:view',
      'documents:create',
      'documents:update',
      'documents:view',
      'profile:update',
      'profile:view',
      'support:create',
      'support:view',
    ]);
  });

  it('accepts selected Controladoria permissions for current and legacy codes', () => {
    const selected = ['financial:manage'] as const;
    expect(resolveEffectivePermissions(['controllership'], selected)).toEqual(
      resolveEffectivePermissions(['controlling'], selected),
    );
    expect(resolveEffectivePermissions(['controllership'], selected)).toContain(
      'financial:manage',
    );
  });

  it('never lets materialized legacy permissions exceed a Commercial ceiling', () => {
    const permissions = resolveEffectivePermissions(
      ['commercial'],
      ALL_PERMISSION_CODES,
    );

    expect(permissions).toContain('commercial:manage');
    expect(permissions).not.toContain('users:view');
    expect(permissions).not.toContain('users:manage');
    expect(permissions).not.toContain('license:view');
  });

  it('grants the full current catalog only to an explicit administrator', () => {
    expect(resolveEffectivePermissions([], [], true)).toEqual(
      ALL_PERMISSION_CODES,
    );
    expect(resolveEffectivePermissions([], ['users:manage'])).not.toContain(
      'users:manage',
    );
  });

  it('reserves administrative access to management and people operations', () => {
    for (const department of ASSIGNABLE_DEPARTMENTS) {
      if (
        department === 'management' ||
        department === 'human-resources' ||
        department === 'personnel-department' ||
        department === 'information-technology'
      ) {
        continue;
      }
      expect(
        DEFAULT_DEPARTMENT_PERMISSIONS[department].some(
          (permission) =>
            permission.startsWith('users:') ||
            permission.startsWith('settings:') ||
            permission === 'license:view',
        ),
        department,
      ).toBe(false);
    }
  });

  it('grants user management to existing TI users without granting license access', () => {
    const permissions = resolveEffectivePermissions(
      ['information-technology'],
      [],
    );

    expect(permissions).toEqual(
      expect.arrayContaining([
        'users:view',
        'users:create',
        'users:update',
        'users:manage',
      ]),
    );
    expect(permissions).not.toContain('license:view');
  });

  it('limits HR and Personnel Department to viewing and creating user access', () => {
    for (const department of [
      'human-resources',
      'personnel-department',
    ] as const) {
      expect(DEFAULT_DEPARTMENT_PERMISSIONS[department]).toContain(
        'users:view',
      );
      expect(DEFAULT_DEPARTMENT_PERMISSIONS[department]).toContain(
        'users:create',
      );
      expect(DEFAULT_DEPARTMENT_PERMISSIONS[department]).not.toContain(
        'users:update',
      );
      expect(DEFAULT_DEPARTMENT_PERMISSIONS[department]).not.toContain(
        'users:manage',
      );
    }
  });

  it('does not treat the Management department as administrator authority', () => {
    expect(MANAGEMENT_DEPARTMENT_PERMISSIONS).not.toContain('users:view');
    expect(MANAGEMENT_DEPARTMENT_PERMISSIONS).not.toContain('users:create');
    expect(MANAGEMENT_DEPARTMENT_PERMISSIONS).not.toContain('users:update');
    expect(MANAGEMENT_DEPARTMENT_PERMISSIONS).not.toContain('users:manage');
    expect(MANAGEMENT_DEPARTMENT_PERMISSIONS).toContain('settings:manage');
    expect(MANAGEMENT_DEPARTMENT_PERMISSIONS).toContain('license:view');
    expect(
      MANAGEMENT_DEPARTMENT_PERMISSIONS.some(
        (permission) =>
          permission.startsWith('commercial:') ||
          permission.startsWith('whatsapp-conversations:'),
      ),
    ).toBe(false);
  });
});

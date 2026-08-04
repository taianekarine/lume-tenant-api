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
        department === 'personnel-department'
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

  it('does not grant Commercial access to a management-only user', () => {
    expect(MANAGEMENT_DEPARTMENT_PERMISSIONS).toContain('users:manage');
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

import { describe, expect, it } from 'vitest';

import {
  assertCanAccessUserTarget,
  assertCanManageUserTarget,
  resolveUserManagementRole,
} from './user-management-policy';

const commonUser = {
  id: 'common-user',
  isAdministrator: false,
  departments: ['commercial'],
} as const;

describe('user management policy', () => {
  it('recognizes administrator, TI, people operations and ordinary users', () => {
    expect(
      resolveUserManagementRole({
        ...commonUser,
        isAdministrator: true,
      }),
    ).toBe('administrator');
    expect(
      resolveUserManagementRole({
        ...commonUser,
        departments: ['information-technology'],
      }),
    ).toBe('information-technology');
    expect(
      resolveUserManagementRole({
        ...commonUser,
        departments: ['personnel-department'],
      }),
    ).toBe('people-operations');
    expect(resolveUserManagementRole(commonUser)).toBe('none');
  });

  it('allows TI to manage another ordinary user', () => {
    const ti = {
      id: 'ti-user',
      isAdministrator: false,
      departments: ['information-technology'],
    } as const;

    expect(assertCanManageUserTarget(ti, commonUser)).toBe(
      'information-technology',
    );
  });

  it('blocks TI from self-management and administrator accounts', () => {
    const ti = {
      id: 'ti-user',
      isAdministrator: false,
      departments: ['information-technology'],
    } as const;

    expect(() => assertCanAccessUserTarget(ti, ti)).toThrow();
    expect(() =>
      assertCanAccessUserTarget(ti, {
        ...commonUser,
        id: 'administrator',
        isAdministrator: true,
      }),
    ).toThrow();
  });

  it('keeps HR and DP out of lifecycle management', () => {
    expect(() =>
      assertCanManageUserTarget(
        {
          id: 'dp-user',
          isAdministrator: false,
          departments: ['personnel-department'],
        },
        commonUser,
      ),
    ).toThrow();
  });
});

import { describe, expect, it } from 'vitest';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import { FakeOfflineLicenseVerifier } from '../../../test/fakes/in-memory';
import { LicenseController } from './license.controller';

function principal(
  departments: AuthenticatedPrincipal['departments'],
): AuthenticatedPrincipal {
  return {
    companyId: '00000000-0000-4000-8000-000000000010',
    tokenVersion: 1,
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Usuário de teste',
    username: 'usuario.teste',
    email: 'usuario@example.test',
    cpf: null,
    type: 'employee',
    departments,
    permissionCodes: ['license:view'],
    permissions: ['dashboard:view', 'license:view'],
    clientCategory: null,
    isActive: true,
    status: 'active',
    suspendedUntil: null,
    suspensionReason: null,
    mustChangePassword: false,
    hasProfilePicture: false,
    createdAt: '2026-07-28T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z',
  };
}

describe('LicenseController', () => {
  const controller = new LicenseController(new FakeOfflineLicenseVerifier());

  it('permite consultar a licença para Gerência autorizada', () => {
    expect(controller.status(principal(['management']))).toMatchObject({
      state: 'active',
      plan: expect.any(String),
    });
  });

  it('bloqueia Comercial mesmo quando a permissão foi injetada diretamente', () => {
    expect(() => controller.status(principal(['commercial']))).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });
});

import { describe, expect, it } from 'vitest';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import type { QuoteProposalUseCase } from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { REQUIRED_PERMISSIONS } from '../../shared/http/decorators/require-permissions.decorator';
import { QuoteProposalListQueryDto } from './dto/whatsapp.dto';
import { QuoteProposalController } from './quote-proposal.controller';

function principal(
  overrides: Partial<AuthenticatedPrincipal> = {},
): AuthenticatedPrincipal {
  return {
    companyId: '00000000-0000-4000-8000-000000000010',
    tokenVersion: 1,
    id: '00000000-0000-4000-8000-000000000011',
    name: 'Atendente Comercial',
    username: 'atendente.comercial',
    email: 'atendente@example.test',
    cpf: null,
    type: 'employee',
    isAdministrator: false,
    departments: ['commercial'],
    permissionCodes: ['commercial:view'],
    permissions: ['dashboard:view', 'commercial:view'],
    clientCategory: null,
    isActive: true,
    status: 'active',
    suspendedUntil: null,
    suspensionReason: null,
    mustChangePassword: false,
    hasProfilePicture: false,
    createdAt: '2026-07-29T12:00:00.000Z',
    updatedAt: '2026-07-29T12:00:00.000Z',
    ...overrides,
  };
}

describe('QuoteProposalController permissions', () => {
  it('aceita leitura comercial no contrato sem remover os códigos do Painel WhatsApp', () => {
    expect(
      Reflect.getMetadata(REQUIRED_PERMISSIONS, QuoteProposalController),
    ).toEqual([
      'commercial:view',
      'commercial:manage',
      'whatsapp-conversations:view',
      'whatsapp-conversations:manage',
    ]);
  });

  it('restringe mutações a gestão comercial ou gestão do Painel WhatsApp', () => {
    for (const method of [
      'create',
      'decide',
      'updateStatus',
      'upload',
      'send',
    ] as const) {
      const handler = Object.getOwnPropertyDescriptor(
        QuoteProposalController.prototype,
        method,
      )?.value as object;
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual([
        'commercial:manage',
        'whatsapp-conversations:manage',
      ]);
    }
  });

  it('mantém o vínculo ao departamento Comercial como segunda barreira', () => {
    const proposals = { list: () => ({ items: [] }) };
    const controller = new QuoteProposalController(
      proposals as unknown as QuoteProposalUseCase,
    );

    expect(() =>
      controller.list(
        principal({
          departments: ['financial'],
          permissionCodes: ['commercial:view'],
          permissions: ['commercial:view'],
        }),
        new QuoteProposalListQueryDto(),
      ),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });
});

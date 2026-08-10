import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import type { QueryWhatsAppUseCase } from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { ConversationListQueryDto } from './dto/whatsapp.dto';
import { WhatsAppPanelController } from './whatsapp-panel.controller';

function principal(
  overrides: Partial<AuthenticatedPrincipal> = {},
): AuthenticatedPrincipal {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    companyId: '00000000-0000-4000-8000-000000000002',
    name: 'Motorista',
    username: 'motorista',
    email: 'motorista@example.com',
    cpf: null,
    type: 'employee',
    departments: ['operations'],
    permissions: ['dashboard:view', 'drivers:view', 'operations:view'],
    clientCategory: null,
    isActive: true,
    mustChangePassword: false,
    hasProfilePicture: false,
    createdAt: '2026-07-28T12:00:00.000Z',
    updatedAt: '2026-07-28T12:00:00.000Z',
    tokenVersion: 1,
    ...overrides,
  };
}

function setup() {
  const listConversations = vi.fn();
  const queryUseCase = { listConversations };
  const controller = new WhatsAppPanelController(
    queryUseCase as unknown as QueryWhatsAppUseCase,
    {} as never,
    {} as never,
    {} as never,
  );

  return { controller, listConversations };
}

describe('WhatsAppPanelController dashboard indicators', () => {
  it('forces the authenticated user department when none is informed', () => {
    const { controller, listConversations } = setup();
    const result = { data: [], meta: { page: 1, pageSize: 20, total: 0 } };
    listConversations.mockReturnValue(result);

    expect(
      controller.dashboard(principal(), new ConversationListQueryDto()),
    ).toBe(result);
    expect(listConversations).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000002',
      expect.objectContaining({ department: 'operations' }),
    );
  });

  it('accepts an explicitly selected department assigned to the user', () => {
    const { controller, listConversations } = setup();
    const query = new ConversationListQueryDto();
    query.department = 'operations';

    void controller.dashboard(principal(), query);

    expect(listConversations).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000002',
      query,
    );
  });

  it('rejects access to a department not assigned to the user', () => {
    const { controller, listConversations } = setup();
    const query = new ConversationListQueryDto();
    query.department = 'financial';

    expect(() => controller.dashboard(principal(), query)).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('requires an explicit department when the user has multiple assignments', () => {
    const { controller, listConversations } = setup();

    expect(() =>
      controller.dashboard(
        principal({ departments: ['operations', 'monitoring'] }),
        new ConversationListQueryDto(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(listConversations).not.toHaveBeenCalled();
  });

  it('allows an administrator without department assignment to read tenant totals', () => {
    const { controller, listConversations } = setup();
    const query = new ConversationListQueryDto();

    void controller.dashboard(
      principal({
        departments: [],
        permissions: ['dashboard:view', 'whatsapp-conversations:manage'],
      }),
      query,
    );

    expect(listConversations).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000002',
      query,
    );
  });

  it('rejects a department-less profile without WhatsApp management access', () => {
    const { controller, listConversations } = setup();

    expect(() =>
      controller.dashboard(
        principal({ departments: [], permissions: ['dashboard:view'] }),
        new ConversationListQueryDto(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(listConversations).not.toHaveBeenCalled();
  });
});

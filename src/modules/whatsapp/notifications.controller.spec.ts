import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../../application/presenters/user.presenter';
import type { QuoteProposalUseCase } from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import type { UserDepartment } from '../../domain/access/access.constants';
import { NotificationsController } from './notifications.controller';

function principal(
  departments: readonly UserDepartment[],
): AuthenticatedPrincipal {
  return {
    id: '00000000-0000-4000-8000-000000000111',
    companyId: '00000000-0000-4000-8000-000000000222',
    name: 'Atendente',
    username: 'atendente',
    email: 'atendente@example.com',
    cpf: null,
    type: 'employee',
    departments: [...departments],
    permissionCodes: [],
    permissions: [
      'dashboard:view',
      'ai-agents:use',
      'profile:view',
      'profile:update',
      'support:view',
      'support:create',
    ],
    clientCategory: null,
    isActive: true,
    status: 'active',
    suspendedUntil: null,
    suspensionReason: null,
    mustChangePassword: false,
    hasProfilePicture: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    tokenVersion: 1,
  };
}

describe('NotificationsController', () => {
  it('returns commercial pending quotes without requiring WhatsApp management', async () => {
    const notificationSummary = vi.fn().mockResolvedValue({
      notificationId: 'commercial.pending-quote-proposals',
      pendingTotal: 3,
      unreadTotal: 2,
    });
    const controller = new NotificationsController({
      notificationSummary,
    } as unknown as QuoteProposalUseCase);

    await expect(controller.list(principal(['commercial']))).resolves.toEqual({
      items: [
        expect.objectContaining({
          id: 'commercial.pending-quote-proposals',
          department: 'commercial',
          count: 3,
          unreadCount: 2,
          read: false,
          href: '/quote-proposals',
        }),
      ],
      total: 3,
      unreadTotal: 2,
    });
    expect(notificationSummary).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000222',
      '00000000-0000-4000-8000-000000000111',
    );
  });

  it('does not query or expose commercial data to another department', async () => {
    const notificationSummary = vi.fn();
    const controller = new NotificationsController({
      notificationSummary,
    } as unknown as QuoteProposalUseCase);

    await expect(controller.list(principal(['financial']))).resolves.toEqual({
      items: [],
      total: 0,
      unreadTotal: 0,
    });
    expect(notificationSummary).not.toHaveBeenCalled();
  });

  it('marks the current commercial queue as read for the authenticated user', async () => {
    const markNotificationRead = vi.fn().mockResolvedValue({
      notificationId: 'commercial.pending-quote-proposals',
      pendingTotal: 3,
      unreadTotal: 0,
      markedRead: 2,
      readAt: new Date(0).toISOString(),
    });
    const controller = new NotificationsController({
      markNotificationRead,
    } as unknown as QuoteProposalUseCase);

    await expect(
      controller.markCommercialQuotesRead(principal(['commercial'])),
    ).resolves.toMatchObject({
      pendingTotal: 3,
      unreadTotal: 0,
      markedRead: 2,
    });
    expect(markNotificationRead).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000222',
      '00000000-0000-4000-8000-000000000111',
    );
  });
});

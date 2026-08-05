import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';
import { DocumentManagementUseCase } from './document-management.use-case';

describe('DocumentManagementUseCase.createRequest', () => {
  it('does not send companyId in nested request item creates', async () => {
    const createdAt = new Date('2026-08-05T12:00:00.000Z');
    const requestDetail = {
      id: 'request-id',
      context: 'ADMISSION',
      department: 'PERSONNEL_DEPARTMENT',
      status: 'PENDING_UPLOAD',
      deadline: null,
      notes: null,
      version: 1,
      completedAt: null,
      createdAt,
      updatedAt: createdAt,
      subject: {
        id: 'subject-id',
        name: 'Pessoa Teste',
        email: 'pessoa@example.com',
        documentAccessMode: 'DOCUMENT_PORTAL',
      },
      createdBy: { id: 'admin-id', name: 'Admin' },
      checklist: {
        id: 'checklist-id',
        code: 'admission-general',
        name: 'Admissão geral',
        version: 1,
      },
      items: [],
    };
    const createRequest = vi.fn().mockResolvedValue({ id: 'request-id' });
    const transaction = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'subject-id', isActive: true }),
      },
      documentChecklistTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'checklist-id',
          active: true,
          context: 'ADMISSION',
          version: 1,
          items: [
            {
              documentTypeId: 'document-type-id',
              requirement: 'REQUIRED',
              position: 1,
              instructions: null,
              condition: {},
              configOverrides: {},
              documentType: {
                code: 'photo-3x4',
                name: 'Foto 3x4 recente',
                acceptedMimeTypes: ['image/jpeg'],
                maxFileSizeBytes: 10_485_760,
                minFiles: 1,
                maxFiles: 1,
                allowsMultiplePages: false,
                requiresFrontBack: false,
                expires: false,
                defaultValidityDays: null,
                renewalLeadDays: null,
                requiresOriginal: false,
                extractionSchema: { fields: [] },
              },
            },
          ],
        }),
      },
      documentRequest: { create: createRequest },
      documentStatusHistory: { create: vi.fn().mockResolvedValue({}) },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      documentRequest: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(requestDetail),
      },
      $transaction: vi.fn(
        async (callback: (client: typeof transaction) => unknown) =>
          callback(transaction),
      ),
    };
    const principal = {
      id: 'admin-id',
      companyId: 'company-id',
      isAdministrator: true,
      departments: ['management'],
      permissions: ['documents:manage'],
    } as AuthenticatedPrincipal;

    await new DocumentManagementUseCase(prisma as never).createRequest(
      principal,
      {
        commandId: 'command-id',
        subjectUserId: 'subject-id',
        checklistId: 'checklist-id',
        context: 'admission',
      },
    );

    const data = createRequest.mock.calls[0][0].data;
    expect(data.companyId).toBe('company-id');
    expect(data.items.create).toHaveLength(1);
    expect(data.items.create[0]).not.toHaveProperty('companyId');
  });
});

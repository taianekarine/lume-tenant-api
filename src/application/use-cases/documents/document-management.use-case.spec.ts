import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';

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

describe('DocumentManagementUseCase.upload', () => {
  it('does not send companyId in nested document file creates', async () => {
    const createdAt = new Date('2026-08-05T12:00:00.000Z');
    const createSubmission = vi.fn().mockResolvedValue({
      id: 'submission-id',
      version: 1,
    });
    const transaction = {
      documentRequestItem: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi
          .fn()
          .mockResolvedValue([
            { status: 'SUBMITTED', requirement: 'REQUIRED' },
          ]),
      },
      documentSubmission: { create: createSubmission },
      documentRequest: { update: vi.fn().mockResolvedValue({}) },
      documentStatusHistory: { createMany: vi.fn().mockResolvedValue({}) },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      documentSubmission: { findUnique: vi.fn().mockResolvedValue(null) },
      documentRequestItem: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'item-id',
          requestId: 'request-id',
          currentVersion: 0,
          status: 'PENDING_UPLOAD',
          configSnapshot: {},
          request: { subjectUserId: 'subject-id' },
          documentType: {
            acceptedMimeTypes: ['image/jpeg'],
            maxFileSizeBytes: 10_485_760,
            minFiles: 1,
            maxFiles: 2,
            allowsMultiplePages: true,
            requiresFrontBack: false,
          },
        }),
      },
      documentRequest: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'request-id',
          subjectUserId: 'subject-id',
          context: 'ADMISSION',
          department: 'PERSONNEL_DEPARTMENT',
          status: 'PARTIALLY_SUBMITTED',
          deadline: null,
          notes: null,
          version: 2,
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
        }),
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

    await new DocumentManagementUseCase(prisma as never).upload(
      principal,
      'item-id',
      {
        commandId: 'command-id',
        files: [
          {
            originalName: 'filho.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 4,
            content: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
            side: 'page',
            pageNumber: 1,
          },
        ],
      },
    );

    const data = createSubmission.mock.calls[0][0].data;
    expect(data.companyId).toBe('company-id');
    expect(data.files.create).toHaveLength(1);
    expect(data.files.create[0]).not.toHaveProperty('companyId');
  });
});

describe('DocumentManagementUseCase.review', () => {
  it('satisfies an open duplicate requirement after the same document is approved in the dossier', async () => {
    const createdAt = new Date('2026-08-05T12:00:00.000Z');
    const requestDetail = {
      id: 'source-request-id',
      context: 'ADMISSION',
      department: 'PERSONNEL_DEPARTMENT',
      status: 'APPROVED',
      deadline: null,
      notes: null,
      version: 3,
      completedAt: createdAt,
      createdAt,
      updatedAt: createdAt,
      subject: {
        id: 'subject-id',
        name: 'Pessoa Teste',
        email: 'pessoa@example.com',
        documentAccessMode: 'STANDARD',
      },
      createdBy: { id: 'admin-id', name: 'Admin' },
      checklist: {
        id: 'checklist-id',
        code: 'employee-documents-dynamic',
        name: 'Documentos do funcionário',
        version: 1,
      },
      items: [],
    };
    const updateItem = vi.fn().mockResolvedValue({});
    const updateRequest = vi.fn().mockResolvedValue({});
    const transaction = {
      documentSubmission: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      documentRequestItem: {
        update: updateItem,
        findMany: vi.fn().mockImplementation(({ where }) => {
          if (where.documentTypeId) {
            return [
              {
                id: 'duplicate-item-id',
                requestId: 'duplicate-request-id',
                status: 'PENDING_UPLOAD',
                currentVersion: 0,
                configSnapshot: {},
              },
            ];
          }
          return [{ status: 'APPROVED', requirement: 'REQUIRED' }];
        }),
      },
      documentReview: {
        create: vi.fn().mockResolvedValue({ id: 'review-id' }),
      },
      documentRequest: { update: updateRequest },
      documentStatusHistory: { create: vi.fn().mockResolvedValue({}) },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      documentReview: { findUnique: vi.fn().mockResolvedValue(null) },
      documentSubmission: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'submission-id',
          requestItemId: 'source-item-id',
          status: 'PENDING_HUMAN_REVIEW',
          version: 1,
          files: [{ id: 'file-id' }],
          requestItem: {
            id: 'source-item-id',
            requestId: 'source-request-id',
            documentTypeId: 'military-document-type-id',
            configSnapshot: {},
            request: { subjectUserId: 'subject-id' },
            documentType: { code: 'military-certificate' },
          },
        }),
      },
      documentRequest: { findUnique: vi.fn().mockResolvedValue(requestDetail) },
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
      permissions: ['documents:manage', 'documents:approve'],
    } as AuthenticatedPrincipal;

    await new DocumentManagementUseCase(prisma as never).review(
      principal,
      'submission-id',
      { commandId: 'command-id', decision: 'approved' },
    );

    expect(updateItem).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id_companyId: {
            id: 'duplicate-item-id',
            companyId: 'company-id',
          },
        },
        data: expect.objectContaining({
          status: 'WAIVED',
          configSnapshot: expect.objectContaining({
            satisfiedBySubmissionId: 'submission-id',
            satisfiedByRequestItemId: 'source-item-id',
          }),
        }),
      }),
    );
    expect(updateRequest).toHaveBeenCalledTimes(2);
    expect(transaction.documentStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestId: 'duplicate-request-id',
          action: 'item.satisfied-by-dossier-document',
          toStatus: 'waived',
        }),
      }),
    );
  });
});

describe('DocumentManagementUseCase.exportUserFiles', () => {
  it('places every file and the manifest in one versioned employee folder', async () => {
    const createdAt = new Date('2026-08-11T12:00:00.000Z');
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'subject-id',
          name: 'Ana da Silva',
          email: 'ana@example.com',
          deletedAt: null,
        }),
      },
      documentFile: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'file-id',
            submissionId: 'submission-id',
            fileName: 'identidade.jpg',
            content: Buffer.from('arquivo'),
            side: 'FRONT',
            sha256: 'hash',
            createdAt,
            submission: {
              version: 3,
              requestItem: {
                documentType: { code: 'rg', name: 'RG' },
                request: { id: 'request-id' },
              },
            },
          },
        ]),
      },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const principal = {
      id: 'admin-id',
      companyId: 'company-id',
      isAdministrator: true,
      departments: ['management'],
      permissions: ['documents:manage', 'documents:export'],
    } as AuthenticatedPrincipal;

    const result = await new DocumentManagementUseCase(
      prisma as never,
    ).exportUserFiles(principal, 'subject-id');
    const archive = await JSZip.loadAsync(result.content);
    const rootFolder = result.fileName.replace(/\.zip$/, '');
    const files = Object.values(archive.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name);

    expect(files).toHaveLength(2);
    expect(files).toEqual(
      expect.arrayContaining([
        `${rootFolder}/documentos_v3/01_rg_front_identidade.jpg`,
        `${rootFolder}/documentos_v3/manifesto.json`,
      ]),
    );
  });
});

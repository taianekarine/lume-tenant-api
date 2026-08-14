import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';
import { DocumentManagementUseCase } from './document-management.use-case';

const createdAt = new Date('2026-08-14T12:00:00.000Z');
const administrator = {
  id: 'admin-id',
  companyId: 'company-id',
  username: 'admin',
  isAdministrator: true,
  departments: ['management'],
  permissions: ['documents:manage', 'documents:approve', 'documents:export'],
} as AuthenticatedPrincipal;

function requestDetail(subjectUserId = 'subject-id') {
  return {
    id: 'request-id',
    companyId: administrator.companyId,
    subjectUserId,
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
      id: subjectUserId,
      name: 'Pessoa Teste',
      email: 'pessoa@example.com',
      documentAccessMode: 'DOCUMENT_PORTAL',
    },
    createdBy: { id: administrator.id, name: 'Admin' },
    checklist: {
      id: 'checklist-id',
      code: 'employee-documents-dynamic',
      name: 'Documentos do funcionÃ¡rio',
      version: 1,
    },
    items: [],
  };
}

function documentType() {
  return {
    id: 'type-id',
    companyId: administrator.companyId,
    code: 'custom-document',
    name: 'Documento personalizado',
    description: null,
    acceptedMimeTypes: ['application/pdf'],
    maxFileSizeBytes: 10_000,
    minFiles: 1,
    maxFiles: 1,
    allowsMultiplePages: false,
    requiresFrontBack: false,
    expires: false,
    defaultValidityDays: null,
    renewalLeadDays: null,
    requiresOriginal: false,
    extractionSchema: {},
    active: true,
  };
}

describe('DocumentManagementUseCase catalog operations', () => {
  it('reutiliza o catÃ¡logo dinÃ¢mico jÃ¡ provisionado', async () => {
    const prisma = {
      documentChecklistTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'checklist-id',
          items: [{ id: 'item-id' }],
        }),
      },
    };

    await expect(
      new DocumentManagementUseCase(
        prisma as never,
      ).ensureInitialDocumentCatalog(administrator),
    ).resolves.toEqual({ checklistId: 'checklist-id' });
  });

  it('lista e cria tipos documentais com auditoria', async () => {
    const type = documentType();
    const prisma = {
      documentType: {
        findMany: vi.fn().mockResolvedValue([type]),
        create: vi.fn().mockResolvedValue(type),
      },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const useCase = new DocumentManagementUseCase(prisma as never);

    await expect(useCase.listDocumentTypes(administrator)).resolves.toEqual({
      data: [type],
    });
    await expect(
      useCase.createDocumentType(administrator, {
        code: ' Custom-Document ',
        name: ' Documento personalizado ',
        description: ' ',
        acceptedMimeTypes: ['application/pdf'],
        maxFileSizeBytes: 10_000,
        minFiles: 1,
        maxFiles: 1,
        allowsMultiplePages: false,
        requiresFrontBack: false,
        expires: false,
        requiresOriginal: false,
      }),
    ).resolves.toEqual({ documentType: type });
    expect(prisma.documentType.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'custom-document',
          description: null,
        }),
      }),
    );
    expect(prisma.tenantAuditLog.create).toHaveBeenCalled();
  });

  it('valida cÃ³digo, quantidades e unicidade do tipo documental', async () => {
    const prisma = {
      documentType: { create: vi.fn() },
      tenantAuditLog: { create: vi.fn() },
    };
    const useCase = new DocumentManagementUseCase(prisma as never);
    const base = {
      name: 'Documento',
      acceptedMimeTypes: ['application/pdf'],
      maxFileSizeBytes: 1,
      minFiles: 1,
      maxFiles: 1,
      allowsMultiplePages: false,
      requiresFrontBack: false,
      expires: false,
      requiresOriginal: false,
    };

    await expect(
      useCase.createDocumentType(administrator, {
        ...base,
        code: 'InvÃ¡lido!',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      useCase.createDocumentType(administrator, {
        ...base,
        code: 'valid-code',
        minFiles: 2,
        maxFiles: 1,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    prisma.documentType.create.mockRejectedValueOnce({ code: 'P2002' });
    await expect(
      useCase.createDocumentType(administrator, {
        ...base,
        code: 'valid-code',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('humaniza checklists e cria uma nova versÃ£o com itens conectados ao tenant', async () => {
    const checklist = {
      id: 'checklist-id',
      code: 'admission-custom',
      context: 'ADMISSION',
      items: [
        {
          id: 'item-id',
          requirement: 'REQUIRED',
          documentType: {
            id: 'type-id',
            code: 'custom-document',
            name: 'Documento',
          },
        },
      ],
    };
    const transaction = {
      documentType: {
        findMany: vi.fn().mockResolvedValue([{ id: 'type-id' }]),
      },
      documentChecklistTemplate: {
        aggregate: vi.fn().mockResolvedValue({ _max: { version: 2 } }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({ ...checklist, version: 3 }),
      },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      documentChecklistTemplate: {
        findMany: vi.fn().mockResolvedValue([checklist]),
      },
      $transaction: vi.fn((callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };
    const useCase = new DocumentManagementUseCase(prisma as never);

    await expect(useCase.listChecklists(administrator)).resolves.toMatchObject({
      data: [{ context: 'admission', items: [{ requirement: 'required' }] }],
    });
    await expect(
      useCase.createChecklist(administrator, {
        code: ' Admission-Custom ',
        name: ' AdmissÃ£o personalizada ',
        context: 'admission',
        items: [
          {
            documentTypeId: 'type-id',
            requirement: 'required',
            instructions: ' Conferir original ',
          },
        ],
      }),
    ).resolves.toMatchObject({ checklist: { version: 3 } });
    expect(transaction.documentChecklistTemplate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'admission-custom',
          items: {
            create: [
              expect.objectContaining({
                company: { connect: { id: administrator.companyId } },
                position: 1,
              }),
            ],
          },
        }),
      }),
    );
  });
});

describe('DocumentManagementUseCase request maintenance', () => {
  it('cria solicitaÃ§Ãµes em lote com snapshot completo e regras do motorista', async () => {
    const type = {
      ...documentType(),
      id: 'cnh-type-id',
      code: 'cnh',
      name: 'CNH',
      extractionSchema: { fields: [{ key: 'category' }] },
    };
    const checklistItem = {
      id: 'checklist-item-id',
      documentTypeId: type.id,
      requirement: 'REQUIRED',
      instructions: 'Envie frente e verso',
      condition: {},
      configOverrides: { source: 'batch' },
      documentType: { code: type.code },
    };
    const transaction = {
      user: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'driver-id',
            jobTitle: 'Motorista',
            maritalStatus: 'not-informed',
            militaryDocumentStatus: 'not-applicable',
            dependents: [],
          },
        ]),
      },
      documentType: { findMany: vi.fn().mockResolvedValue([type]) },
      documentChecklistTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'checklist-id',
          active: true,
          items: [checklistItem],
        }),
      },
      documentRequest: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 'batch-request-id',
          items: [{ id: 'batch-item-id' }],
        }),
      },
      documentStatusHistory: { create: vi.fn().mockResolvedValue({}) },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      documentChecklistTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'checklist-id',
          items: [{ id: 'child-item-id' }],
        }),
      },
      $transaction: vi.fn((callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };

    await expect(
      new DocumentManagementUseCase(prisma as never).createBatchRequests(
        administrator,
        {
          commandId: 'batch-command-id',
          subjectUserIds: ['driver-id'],
          documentTypeIds: [type.id],
          context: 'regularization',
          deadline: '2026-09-10T12:00:00.000Z',
          notes: ' AtualizaÃ§Ã£o anual ',
        },
      ),
    ).resolves.toMatchObject({
      requests: [
        {
          id: 'batch-request-id',
          subjectUserId: 'driver-id',
          itemCount: 1,
          idempotent: false,
        },
      ],
      skippedDocuments: [],
      createdCount: 1,
      idempotentCount: 0,
    });
    expect(transaction.documentRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          context: 'REGULARIZATION',
          items: {
            create: [
              expect.objectContaining({
                configSnapshot: expect.objectContaining({
                  code: 'cnh',
                  source: 'batch',
                  driverRequirements: {
                    category: 'D',
                    earRequired: true,
                    validityRequired: true,
                  },
                }),
              }),
            ],
          },
        }),
        select: expect.any(Object),
      }),
    );
  });

  it('sincroniza documentos condicionais, reabre itens e preserva decisÃµes do DP', async () => {
    const militaryType = {
      ...documentType(),
      id: 'military-type-id',
      code: 'military-certificate',
      name: 'Certificado militar',
    };
    const cnhType = {
      ...documentType(),
      id: 'cnh-type-id',
      code: 'cnh',
      name: 'CNH',
    };
    const childType = {
      ...documentType(),
      id: 'child-type-id',
      code: 'child-identification',
      name: 'Documentos do dependente',
    };
    const checklistItems = [militaryType, cnhType, childType].map(
      (type, index) => ({
        id: `checklist-item-${index}`,
        documentTypeId: type.id,
        requirement: 'REQUIRED',
        position: index + 1,
        instructions: null,
        condition: {},
        configOverrides: index === 1 ? { source: 'profile-sync' } : {},
        documentType: type,
      }),
    );
    const request = {
      id: 'request-id',
      status: 'PENDING_UPLOAD',
      items: [
        {
          id: 'obsolete-item-id',
          documentTypeId: 'obsolete-type-id',
          documentType: {
            ...documentType(),
            id: 'obsolete-type-id',
            code: 'obsolete',
          },
          status: 'PENDING_UPLOAD',
          requirement: 'REQUIRED',
          position: 1,
          configSnapshot: {},
          submissions: [],
        },
        {
          id: 'military-cancelled-id',
          documentTypeId: militaryType.id,
          documentType: militaryType,
          status: 'CANCELLED',
          requirement: 'OPTIONAL',
          position: 2,
          configSnapshot: {},
          submissions: [],
        },
        {
          id: 'military-pending-id',
          documentTypeId: militaryType.id,
          documentType: militaryType,
          status: 'PENDING_UPLOAD',
          requirement: 'REQUIRED',
          position: 3,
          configSnapshot: {},
          submissions: [],
        },
      ],
    };
    const transaction = {
      documentRequestItem: {
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({}),
        findMany: vi
          .fn()
          .mockResolvedValue([
            { status: 'PENDING_UPLOAD', requirement: 'REQUIRED' },
          ]),
      },
      documentRequest: { update: vi.fn().mockResolvedValue({}) },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'driver-id',
          jobTitle: 'Motorista',
          maritalStatus: 'not-informed',
          militaryDocumentStatus: 'pending-confirmation',
          dependents: [
            {
              id: 'dependent-id',
              name: 'Dependente',
              relationship: 'filho',
              birthDate: '2020-01-01',
            },
          ],
        }),
      },
      documentChecklistTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'checklist-id',
          active: true,
          items: checklistItems,
        }),
      },
      documentRequest: {
        findFirst: vi.fn().mockResolvedValue(request),
        findUnique: vi.fn().mockResolvedValue(requestDetail('driver-id')),
      },
      $transaction: vi.fn((callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };

    await expect(
      new DocumentManagementUseCase(
        prisma as never,
      ).synchronizeEmployeeDocuments(administrator, 'driver-id'),
    ).resolves.toMatchObject({ request: { id: 'request-id' } });
    expect(transaction.documentRequestItem.update).toHaveBeenCalledTimes(3);
    expect(transaction.documentRequestItem.create).toHaveBeenCalledTimes(2);
    expect(transaction.documentRequestItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          documentTypeId: cnhType.id,
          configSnapshot: expect.objectContaining({
            source: 'profile-sync',
            driverRequirements: {
              category: 'D',
              earRequired: true,
              validityRequired: true,
            },
          }),
        }),
      }),
    );
  });

  it('apresenta uma solicitaÃ§Ã£o vazia ao titular', async () => {
    const principal = {
      ...administrator,
      id: 'subject-id',
      isAdministrator: false,
      permissions: [],
    };
    const prisma = {
      documentRequest: {
        findUnique: vi.fn().mockResolvedValue(requestDetail('subject-id')),
      },
    };

    await expect(
      new DocumentManagementUseCase(prisma as never).getRequest(
        principal as AuthenticatedPrincipal,
        'request-id',
      ),
    ).resolves.toMatchObject({
      request: {
        id: 'request-id',
        context: 'admission',
        department: 'personnel-department',
        status: 'pending-upload',
        subject: { documentAccessMode: 'document-portal' },
      },
    });
  });

  it('adiciona manualmente um item e recalcula o estado da solicitaÃ§Ã£o', async () => {
    const type = documentType();
    const transaction = {
      documentRequestItem: {
        aggregate: vi.fn().mockResolvedValue({ _max: { position: 2 } }),
        create: vi.fn().mockResolvedValue({ id: 'new-item-id' }),
        findMany: vi
          .fn()
          .mockResolvedValue([
            { status: 'PENDING_UPLOAD', requirement: 'REQUIRED' },
          ]),
      },
      documentStatusHistory: { create: vi.fn().mockResolvedValue({}) },
      documentRequest: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      documentRequest: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: 'request-id' })
          .mockResolvedValueOnce(requestDetail()),
      },
      documentType: { findUnique: vi.fn().mockResolvedValue(type) },
      documentRequestItem: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn((callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };

    await expect(
      new DocumentManagementUseCase(prisma as never).addRequestItem(
        administrator,
        'request-id',
        {
          documentTypeId: type.id,
          requirement: 'required',
          instructions: ' Conferir ',
          dueAt: '2026-09-01T00:00:00.000Z',
          reason: ' Complemento ',
        },
      ),
    ).resolves.toMatchObject({ request: { id: 'request-id' } });
    expect(transaction.documentRequestItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ position: 3, dueAt: expect.any(Date) }),
      }),
    );
  });

  it('altera a polÃ­tica do item e reabre itens antes dispensados', async () => {
    const transaction = {
      documentRequestItem: {
        update: vi.fn().mockResolvedValue({}),
        findMany: vi
          .fn()
          .mockResolvedValue([
            { status: 'PENDING_UPLOAD', requirement: 'REQUIRED' },
          ]),
      },
      documentStatusHistory: { create: vi.fn().mockResolvedValue({}) },
      documentRequest: { update: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      documentRequestItem: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'item-id',
          requestId: 'request-id',
          status: 'WAIVED',
          requirement: 'OPTIONAL',
          configSnapshot: { original: true },
        }),
      },
      documentRequest: {
        findUnique: vi.fn().mockResolvedValue(requestDetail()),
      },
      $transaction: vi.fn((callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };

    await expect(
      new DocumentManagementUseCase(prisma as never).setRequestItemPolicy(
        administrator,
        'item-id',
        { policy: 'required', reason: ' Agora obrigatÃ³rio ' },
      ),
    ).resolves.toMatchObject({ request: { id: 'request-id' } });
    expect(transaction.documentRequestItem.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING_UPLOAD',
          requirement: 'REQUIRED',
          configSnapshot: { original: true, manualPolicy: 'required' },
        }),
      }),
    );
  });
});

describe('DocumentManagementUseCase queries and renewal', () => {
  it('conclui a validação estrutural local e encaminha o envio para revisão humana', async () => {
    const submission = {
      id: 'submission-id',
      requestItemId: 'item-id',
      status: 'SUBMITTED',
      version: 1,
      validation: null,
      files: [
        {
          id: 'file-id',
          fileName: 'documento.pdf',
          mimeType: 'application/pdf',
          content: Uint8Array.from([1, 2, 3]),
          side: 'PAGE',
          pageNumber: 1,
        },
      ],
      requestItem: {
        id: 'item-id',
        requestId: 'request-id',
        configSnapshot: {
          minFiles: 1,
          maxFiles: 1,
          extractionSchema: {
            fields: [
              { key: 'fullName', label: 'Nome completo', type: 'string' },
              { key: 1, label: 'Campo inválido' },
            ],
          },
        },
        request: {
          subjectUserId: 'subject-id',
          context: 'ADMISSION',
        },
        documentType: {
          code: 'custom-document',
          acceptedMimeTypes: ['application/pdf'],
          maxFileSizeBytes: 10_000,
        },
      },
    };
    const validation = {
      id: 'validation-id',
      status: 'COMPLETED',
      provider: 'local-structural',
    };
    const transaction = {
      documentSubmission: { update: vi.fn().mockResolvedValue({}) },
      documentRequestItem: {
        update: vi.fn().mockResolvedValue({}),
        findMany: vi
          .fn()
          .mockResolvedValue([
            { status: 'PENDING_HUMAN_REVIEW', requirement: 'REQUIRED' },
          ]),
      },
      documentValidation: { upsert: vi.fn().mockResolvedValue(validation) },
      documentRequest: { update: vi.fn().mockResolvedValue({}) },
      documentStatusHistory: { create: vi.fn().mockResolvedValue({}) },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      documentSubmission: { findUnique: vi.fn().mockResolvedValue(submission) },
      documentRequest: {
        findUnique: vi.fn().mockResolvedValue(requestDetail()),
      },
      $transaction: vi.fn((callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };

    await expect(
      new DocumentManagementUseCase(prisma as never).completeSubmission(
        administrator,
        submission.id,
      ),
    ).resolves.toMatchObject({
      request: { id: 'request-id' },
      validation,
      idempotent: false,
    });
    expect(transaction.documentSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING_HUMAN_REVIEW',
          extractedData: {},
        }),
      }),
    );
    expect(transaction.documentValidation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          provider: 'local-structural',
          suggestedDocumentTypeCode: 'custom-document',
        }),
      }),
    );
    expect(transaction.documentStatusHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'validation.completed',
          fromStatus: 'submitted',
          toStatus: 'pending-human-review',
        }),
      }),
    );
  });

  it('registra dados extraídos propostos com origem e confiança para revisão humana', async () => {
    const transaction = {
      documentSubmission: { update: vi.fn().mockResolvedValue({}) },
      documentValidation: { upsert: vi.fn().mockResolvedValue({}) },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      documentSubmission: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'submission-id',
          status: 'PENDING_HUMAN_REVIEW',
          version: 2,
          files: [{ id: 'front-file-id' }, { id: 'back-file-id' }],
          validation: null,
          requestItem: {
            requestId: 'request-id',
            configSnapshot: {
              extractionSchema: {
                fields: [
                  { key: 'fullName', label: 'Nome completo' },
                  { key: 'cpf', label: 'CPF' },
                ],
              },
            },
            request: { subjectUserId: 'subject-id' },
            documentType: { code: 'rg' },
          },
        }),
      },
      documentRequest: {
        findUnique: vi.fn().mockResolvedValue(requestDetail()),
      },
      $transaction: vi.fn((callback: (client: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    };

    await expect(
      new DocumentManagementUseCase(prisma as never).updateExtractedData(
        administrator,
        'submission-id',
        {
          fields: { fullName: 'Pessoa Teste', cpf: '12345678901' },
          confidences: { fullName: 0.98, cpf: 2 },
        },
      ),
    ).resolves.toMatchObject({ request: { id: 'request-id' } });
    expect(transaction.documentSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          extractedData: expect.objectContaining({
            fullName: expect.objectContaining({
              value: 'Pessoa Teste',
              confidence: 0.98,
              sourceSubmissionId: 'submission-id',
              sourceDocumentTypeCode: 'rg',
              sourceVersion: 2,
              sourceFileIds: ['front-file-id', 'back-file-id'],
            }),
            cpf: expect.objectContaining({ confidence: null }),
          }),
        },
      }),
    );
    expect(transaction.documentValidation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          provider: 'human-assisted',
          overallConfidence: 0.98,
        }),
        update: expect.objectContaining({ overallConfidence: 0.98 }),
      }),
    );
    expect(transaction.tenantAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'document.extraction.proposed',
          metadata: {
            fieldNames: ['fullName', 'cpf'],
            sourceFileIds: ['front-file-id', 'back-file-id'],
          },
        }),
      }),
    );
  });

  it('entrega arquivo autorizado e registra a consulta', async () => {
    const prisma = {
      documentFile: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'file-id',
          fileName: 'documento.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 3,
          sha256: 'hash',
          content: Uint8Array.from([1, 2, 3]),
          deletedAt: null,
          submission: {
            requestItem: {
              requestId: 'request-id',
              request: { subjectUserId: 'subject-id' },
            },
          },
        }),
      },
      tenantAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };

    await expect(
      new DocumentManagementUseCase(prisma as never).fileContent(
        administrator,
        'file-id',
      ),
    ).resolves.toMatchObject({
      fileName: 'documento.pdf',
      content: Buffer.from([1, 2, 3]),
    });
    expect(prisma.tenantAuditLog.create).toHaveBeenCalled();
  });

  it('ordena e humaniza o histÃ³rico da solicitaÃ§Ã£o', async () => {
    const prisma = {
      documentRequest: {
        findUnique: vi.fn().mockResolvedValue(requestDetail()),
      },
      documentStatusHistory: {
        findMany: vi.fn().mockResolvedValue([{ id: 'history-id', createdAt }]),
      },
    };

    await expect(
      new DocumentManagementUseCase(prisma as never).history(
        administrator,
        'request-id',
      ),
    ).resolves.toEqual({
      data: [{ id: 'history-id', createdAt: createdAt.toISOString() }],
    });
  });

  it('lista vencimentos do tenant para gestores e restringe titulares', async () => {
    const row = {
      id: 'item-id',
      requestId: 'request-id',
      validUntil: createdAt,
      documentType: { code: 'cnh', name: 'CNH', renewalLeadDays: 30 },
      request: { subject: { id: 'subject-id', name: 'Pessoa' } },
    };
    const findMany = vi.fn().mockResolvedValue([row]);
    const useCase = new DocumentManagementUseCase({
      documentRequestItem: { findMany },
    } as never);

    await expect(useCase.expiring(administrator, 30)).resolves.toMatchObject({
      data: [{ requestItemId: 'item-id', validUntil: createdAt.toISOString() }],
    });
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('request');

    await useCase.expiring(
      {
        ...administrator,
        id: 'subject-id',
        isAdministrator: false,
        departments: [],
        permissions: [],
      },
      30,
    );
    expect(findMany.mock.calls[1][0].where).toMatchObject({
      request: { subjectUserId: 'subject-id' },
    });
  });

  it('reutiliza uma solicitaÃ§Ã£o de renovaÃ§Ã£o idempotente', async () => {
    const prisma = {
      documentRequestItem: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'source-item-id',
          status: 'APPROVED',
          request: { subjectUserId: 'subject-id', checklistId: 'checklist-id' },
        }),
      },
      documentRequest: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: 'request-id' })
          .mockResolvedValueOnce(requestDetail()),
      },
    };

    await expect(
      new DocumentManagementUseCase(prisma as never).renew(
        administrator,
        'source-item-id',
        {
          commandId: 'renew-command-id',
        },
      ),
    ).resolves.toMatchObject({
      request: { id: 'request-id' },
      idempotent: true,
    });
  });
});

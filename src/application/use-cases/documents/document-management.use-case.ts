import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';
import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import {
  assertDocumentItemTransition,
  deriveDocumentRequestStatus,
  localStructuralValidation,
  validateDocumentUpload,
  type DocumentFileSide,
  type DocumentItemStatus,
  type DocumentRequestContext,
  type DocumentRequestStatus,
  type DocumentRequirement,
} from '../../../domain/documents/document-workflow';
import {
  DepartmentCode,
  DocumentFileSide as PrismaDocumentFileSide,
  DocumentItemStatus as PrismaDocumentItemStatus,
  DocumentOriginalCheckStatus,
  DocumentRequestContext as PrismaDocumentRequestContext,
  DocumentRequestStatus as PrismaDocumentRequestStatus,
  DocumentRequirement as PrismaDocumentRequirement,
  DocumentReviewDecision,
  DocumentValidationStatus,
  type Prisma,
} from '../../../infra/database/prisma/generated/client';
import { PrismaService } from '../../../infra/database/prisma/prisma.service';

const requestContextToPrisma: Readonly<
  Record<DocumentRequestContext, PrismaDocumentRequestContext>
> = {
  admission: PrismaDocumentRequestContext.ADMISSION,
  'document-update': PrismaDocumentRequestContext.DOCUMENT_UPDATE,
  'document-renewal': PrismaDocumentRequestContext.DOCUMENT_RENEWAL,
  regularization: PrismaDocumentRequestContext.REGULARIZATION,
  offboarding: PrismaDocumentRequestContext.OFFBOARDING,
  other: PrismaDocumentRequestContext.OTHER,
};

const requestStatusFromPrisma: Readonly<
  Record<PrismaDocumentRequestStatus, DocumentRequestStatus>
> = {
  DRAFT: 'draft',
  PENDING_UPLOAD: 'pending-upload',
  PARTIALLY_SUBMITTED: 'partially-submitted',
  SUBMITTED: 'submitted',
  AUTOMATIC_VALIDATION: 'automatic-validation',
  PENDING_HUMAN_REVIEW: 'pending-human-review',
  RESUBMISSION_REQUIRED: 'resubmission-required',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};

const requestStatusToPrisma: Readonly<
  Record<DocumentRequestStatus, PrismaDocumentRequestStatus>
> = Object.fromEntries(
  Object.entries(requestStatusFromPrisma).map(([key, value]) => [value, key]),
) as Record<DocumentRequestStatus, PrismaDocumentRequestStatus>;

const itemStatusFromPrisma: Readonly<
  Record<PrismaDocumentItemStatus, DocumentItemStatus>
> = {
  PENDING_UPLOAD: 'pending-upload',
  SUBMITTED: 'submitted',
  AUTOMATIC_VALIDATION: 'automatic-validation',
  PENDING_HUMAN_REVIEW: 'pending-human-review',
  RESUBMISSION_REQUIRED: 'resubmission-required',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
};

const itemStatusToPrisma: Readonly<
  Record<DocumentItemStatus, PrismaDocumentItemStatus>
> = Object.fromEntries(
  Object.entries(itemStatusFromPrisma).map(([key, value]) => [value, key]),
) as Record<DocumentItemStatus, PrismaDocumentItemStatus>;

const requirementsFromPrisma: Readonly<
  Record<PrismaDocumentRequirement, DocumentRequirement>
> = {
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  CONDITIONAL: 'conditional',
};

const requirementsToPrisma: Readonly<
  Record<DocumentRequirement, PrismaDocumentRequirement>
> = {
  required: PrismaDocumentRequirement.REQUIRED,
  optional: PrismaDocumentRequirement.OPTIONAL,
  conditional: PrismaDocumentRequirement.CONDITIONAL,
};

const sidesToPrisma: Readonly<
  Record<DocumentFileSide, PrismaDocumentFileSide>
> = {
  single: PrismaDocumentFileSide.SINGLE,
  front: PrismaDocumentFileSide.FRONT,
  back: PrismaDocumentFileSide.BACK,
  page: PrismaDocumentFileSide.PAGE,
};

const sidesFromPrisma: Readonly<
  Record<PrismaDocumentFileSide, DocumentFileSide>
> = {
  SINGLE: 'single',
  FRONT: 'front',
  BACK: 'back',
  PAGE: 'page',
};

const requestDetailInclude = {
  subject: {
    select: { id: true, name: true, email: true, documentAccessMode: true },
  },
  createdBy: { select: { id: true, name: true } },
  checklist: { select: { id: true, code: true, name: true, version: true } },
  items: {
    orderBy: { position: 'asc' as const },
    include: {
      documentType: true,
      submissions: {
        orderBy: { version: 'desc' as const },
        include: {
          files: {
            where: { deletedAt: null },
            select: {
              id: true,
              side: true,
              pageNumber: true,
              fileName: true,
              mimeType: true,
              sizeBytes: true,
              sha256: true,
              createdAt: true,
            },
          },
          validation: true,
          reviews: {
            orderBy: { createdAt: 'desc' as const },
            include: { reviewedBy: { select: { id: true, name: true } } },
          },
        },
      },
    },
  },
} as const;

type RequestDetailRow = Prisma.DocumentRequestGetPayload<{
  include: typeof requestDetailInclude;
}>;

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function spreadsheetValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return JSON.stringify(value);
}

function safeArchiveName(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 120) || 'arquivo'
  );
}

function contextFromPrisma(
  value: PrismaDocumentRequestContext,
): DocumentRequestContext {
  return {
    ADMISSION: 'admission',
    DOCUMENT_UPDATE: 'document-update',
    DOCUMENT_RENEWAL: 'document-renewal',
    REGULARIZATION: 'regularization',
    OFFBOARDING: 'offboarding',
    OTHER: 'other',
  }[value] as DocumentRequestContext;
}

function hasPeopleOperationsScope(principal: AuthenticatedPrincipal): boolean {
  return (
    principal.isAdministrator ||
    principal.departments.some((department) =>
      ['management', 'personnel-department', 'human-resources'].includes(
        department,
      ),
    )
  );
}

function assertManage(principal: AuthenticatedPrincipal): void {
  if (
    !hasPeopleOperationsScope(principal) ||
    (!principal.isAdministrator &&
      !principal.permissions.includes('documents:manage'))
  ) {
    throw forbidden(
      'Esta operação exige gestão documental por RH, DP ou Gerência.',
    );
  }
}

function assertReview(principal: AuthenticatedPrincipal): void {
  assertManage(principal);
  if (
    !principal.isAdministrator &&
    !principal.permissions.includes('documents:approve')
  ) {
    throw forbidden('Esta operação exige permissão para revisar documentos.');
  }
}

function presentRequest(row: RequestDetailRow) {
  return {
    id: row.id,
    context: contextFromPrisma(row.context),
    department: row.department.toLowerCase().replaceAll('_', '-'),
    status: requestStatusFromPrisma[row.status],
    deadline: row.deadline?.toISOString() ?? null,
    notes: row.notes,
    version: row.version,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    subject: {
      id: row.subject.id,
      name: row.subject.name,
      email: row.subject.email,
      documentAccessMode:
        row.subject.documentAccessMode === 'DOCUMENT_PORTAL'
          ? 'document-portal'
          : 'standard',
    },
    createdBy: row.createdBy,
    checklist: row.checklist,
    items: row.items.map((item) => ({
      id: item.id,
      requirement: requirementsFromPrisma[item.requirement],
      status: itemStatusFromPrisma[item.status],
      position: item.position,
      instructions: item.instructions,
      dueAt: item.dueAt?.toISOString() ?? null,
      validUntil: item.validUntil?.toISOString() ?? null,
      currentVersion: item.currentVersion,
      config: jsonRecord(item.configSnapshot),
      documentType: {
        id: item.documentType.id,
        code: item.documentType.code,
        name: item.documentType.name,
        description: item.documentType.description,
      },
      submissions: item.submissions.map((submission) => ({
        id: submission.id,
        version: submission.version,
        status: itemStatusFromPrisma[submission.status],
        extractedData: jsonRecord(submission.extractedData),
        confirmedData: jsonRecord(submission.confirmedData),
        submittedAt: submission.submittedAt.toISOString(),
        files: submission.files.map((file) => ({
          ...file,
          side: sidesFromPrisma[file.side],
          createdAt: file.createdAt.toISOString(),
          contentPath: `/document-management/files/${file.id}/content`,
        })),
        validation: submission.validation
          ? {
              status: submission.validation.status.toLowerCase(),
              suggestedDocumentTypeCode:
                submission.validation.suggestedDocumentTypeCode,
              result: submission.validation.result,
              alerts: submission.validation.alerts,
              extractedFields: submission.validation.extractedFields,
              overallConfidence: submission.validation.overallConfidence,
              summary: submission.validation.summary,
              provider: submission.validation.provider,
              modelVersion: submission.validation.modelVersion,
              completedAt:
                submission.validation.completedAt?.toISOString() ?? null,
            }
          : null,
        reviews: submission.reviews.map((review) => ({
          id: review.id,
          decision: review.decision.toLowerCase().replaceAll('_', '-'),
          reason: review.reason,
          notes: review.notes,
          correctedFields: review.correctedFields,
          confirmedFields: review.confirmedFields,
          originalCheckStatus: review.originalCheckStatus
            .toLowerCase()
            .replaceAll('_', '-'),
          originalCheckedAt: review.originalCheckedAt?.toISOString() ?? null,
          originalObservation: review.originalObservation,
          reviewedBy: review.reviewedBy,
          createdAt: review.createdAt.toISOString(),
        })),
      })),
    })),
  };
}

function requestStatusForItems(
  items: readonly {
    status: PrismaDocumentItemStatus;
    requirement: PrismaDocumentRequirement;
  }[],
): PrismaDocumentRequestStatus {
  return requestStatusToPrisma[
    deriveDocumentRequestStatus(
      items.map((item) => ({
        status: itemStatusFromPrisma[item.status],
        requirement: requirementsFromPrisma[item.requirement],
      })),
    )
  ];
}

@Injectable()
export class DocumentManagementUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async listDocumentTypes(principal: AuthenticatedPrincipal) {
    assertManage(principal);
    const data = await this.prisma.documentType.findMany({
      where: { companyId: principal.companyId },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
    return { data };
  }

  async createDocumentType(
    principal: AuthenticatedPrincipal,
    input: {
      code: string;
      name: string;
      description?: string;
      acceptedMimeTypes: string[];
      maxFileSizeBytes: number;
      minFiles: number;
      maxFiles: number;
      allowsMultiplePages: boolean;
      requiresFrontBack: boolean;
      expires: boolean;
      defaultValidityDays?: number;
      renewalLeadDays?: number;
      requiresOriginal: boolean;
      extractionSchema?: Readonly<Record<string, unknown>>;
    },
  ) {
    assertManage(principal);
    const code = input.code.trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{2,79}$/.test(code)) {
      throw validationError('Use um código estável em kebab-case.');
    }
    if (input.minFiles < 1 || input.maxFiles < input.minFiles) {
      throw validationError(
        'A quantidade mínima/máxima de arquivos é inválida.',
      );
    }
    try {
      const documentType = await this.prisma.documentType.create({
        data: {
          companyId: principal.companyId,
          code,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          acceptedMimeTypes: input.acceptedMimeTypes,
          maxFileSizeBytes: input.maxFileSizeBytes,
          minFiles: input.minFiles,
          maxFiles: input.maxFiles,
          allowsMultiplePages: input.allowsMultiplePages,
          requiresFrontBack: input.requiresFrontBack,
          expires: input.expires,
          defaultValidityDays: input.defaultValidityDays,
          renewalLeadDays: input.renewalLeadDays,
          requiresOriginal: input.requiresOriginal,
          extractionSchema: (input.extractionSchema ??
            {}) as Prisma.InputJsonValue,
        },
      });
      await this.audit(
        principal,
        'document.type.create',
        'document-type',
        documentType.id,
        {
          code,
        },
      );
      return { documentType };
    } catch (error) {
      if (this.isUniqueError(error))
        throw conflict('Este código documental já existe.');
      throw error;
    }
  }

  async listChecklists(principal: AuthenticatedPrincipal) {
    assertManage(principal);
    const rows = await this.prisma.documentChecklistTemplate.findMany({
      where: { companyId: principal.companyId },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: {
            documentType: { select: { id: true, code: true, name: true } },
          },
        },
      },
      orderBy: [{ code: 'asc' }, { version: 'desc' }],
    });
    return {
      data: rows.map((row) => ({
        ...row,
        context: contextFromPrisma(row.context),
        items: row.items.map((item) => ({
          ...item,
          requirement: requirementsFromPrisma[item.requirement],
        })),
      })),
    };
  }

  async createChecklist(
    principal: AuthenticatedPrincipal,
    input: {
      code: string;
      name: string;
      description?: string;
      context: DocumentRequestContext;
      items: Array<{
        documentTypeId: string;
        requirement: DocumentRequirement;
        instructions?: string;
        condition?: Readonly<Record<string, unknown>>;
        configOverrides?: Readonly<Record<string, unknown>>;
      }>;
    },
  ) {
    assertManage(principal);
    if (input.items.length === 0)
      throw validationError('Inclua ao menos um item.');
    if (
      new Set(input.items.map((item) => item.documentTypeId)).size !==
      input.items.length
    ) {
      throw validationError(
        'Um tipo documental não pode aparecer duas vezes no checklist.',
      );
    }
    const code = input.code.trim().toLowerCase();
    return this.prisma.$transaction(async (transaction) => {
      const types = await transaction.documentType.findMany({
        where: {
          companyId: principal.companyId,
          id: { in: input.items.map((item) => item.documentTypeId) },
          active: true,
        },
        select: { id: true },
      });
      if (types.length !== input.items.length) {
        throw validationError('Há tipos documentais inexistentes ou inativos.');
      }
      const latest = await transaction.documentChecklistTemplate.aggregate({
        where: { companyId: principal.companyId, code },
        _max: { version: true },
      });
      const version = (latest._max.version ?? 0) + 1;
      await transaction.documentChecklistTemplate.updateMany({
        where: { companyId: principal.companyId, code, active: true },
        data: { active: false },
      });
      const checklist = await transaction.documentChecklistTemplate.create({
        data: {
          companyId: principal.companyId,
          code,
          name: input.name.trim(),
          description: input.description?.trim() || null,
          context: requestContextToPrisma[input.context],
          version,
          createdByUserId: principal.id,
          items: {
            create: input.items.map((item, index) => ({
              companyId: principal.companyId,
              documentTypeId: item.documentTypeId,
              requirement: requirementsToPrisma[item.requirement],
              position: index + 1,
              instructions: item.instructions?.trim() || null,
              condition: (item.condition ?? {}) as Prisma.InputJsonValue,
              configOverrides: (item.configOverrides ??
                {}) as Prisma.InputJsonValue,
            })),
          },
        },
        include: { items: true },
      });
      await transaction.tenantAuditLog.create({
        data: {
          companyId: principal.companyId,
          actorUserId: principal.id,
          action: 'document.checklist.create',
          targetType: 'document-checklist',
          targetId: checklist.id,
          metadata: { code, version, itemCount: input.items.length },
        },
      });
      return { checklist };
    });
  }

  async createRequest(
    principal: AuthenticatedPrincipal,
    input: {
      commandId: string;
      subjectUserId: string;
      checklistId: string;
      context: DocumentRequestContext;
      deadline?: string;
      notes?: string;
    },
    options: { skipManageAssertion?: boolean } = {},
  ) {
    if (!options.skipManageAssertion) assertManage(principal);
    const duplicate = await this.prisma.documentRequest.findUnique({
      where: {
        companyId_commandId: {
          companyId: principal.companyId,
          commandId: input.commandId,
        },
      },
      select: { id: true },
    });
    if (duplicate)
      return {
        request: await this.getRequestById(principal, duplicate.id),
        idempotent: true,
      };

    const requestId = await this.prisma.$transaction(async (transaction) => {
      const [subject, checklist] = await Promise.all([
        transaction.user.findUnique({
          where: {
            id_companyId: {
              id: input.subjectUserId,
              companyId: principal.companyId,
            },
          },
          select: { id: true, isActive: true },
        }),
        transaction.documentChecklistTemplate.findUnique({
          where: {
            id_companyId: {
              id: input.checklistId,
              companyId: principal.companyId,
            },
          },
          include: {
            items: {
              where: { active: true },
              orderBy: { position: 'asc' },
              include: { documentType: true },
            },
          },
        }),
      ]);
      if (!subject?.isActive) throw notFound('Usuário titular ativo');
      if (!checklist?.active) throw notFound('Checklist ativo');
      if (checklist.context !== requestContextToPrisma[input.context]) {
        throw validationError(
          'O contexto não corresponde ao checklist selecionado.',
        );
      }
      const request = await transaction.documentRequest.create({
        data: {
          companyId: principal.companyId,
          subjectUserId: input.subjectUserId,
          createdByUserId: principal.id,
          checklistId: checklist.id,
          context: checklist.context,
          department: DepartmentCode.PERSONNEL_DEPARTMENT,
          status: PrismaDocumentRequestStatus.PENDING_UPLOAD,
          deadline: input.deadline ? new Date(input.deadline) : null,
          notes: input.notes?.trim() || null,
          commandId: input.commandId,
          items: {
            create: checklist.items.map((item) => ({
              documentTypeId: item.documentTypeId,
              requirement: item.requirement,
              position: item.position,
              instructions: item.instructions,
              dueAt: input.deadline ? new Date(input.deadline) : null,
              configSnapshot: {
                code: item.documentType.code,
                name: item.documentType.name,
                acceptedMimeTypes: item.documentType.acceptedMimeTypes,
                maxFileSizeBytes: item.documentType.maxFileSizeBytes,
                minFiles: item.documentType.minFiles,
                maxFiles: item.documentType.maxFiles,
                allowsMultiplePages: item.documentType.allowsMultiplePages,
                requiresFrontBack: item.documentType.requiresFrontBack,
                expires: item.documentType.expires,
                defaultValidityDays: item.documentType.defaultValidityDays,
                renewalLeadDays: item.documentType.renewalLeadDays,
                requiresOriginal: item.documentType.requiresOriginal,
                extractionSchema: item.documentType.extractionSchema,
                checklistCondition: item.condition,
                ...jsonRecord(item.configOverrides),
              },
            })),
          },
        },
      });
      await transaction.documentStatusHistory.create({
        data: {
          companyId: principal.companyId,
          requestId: request.id,
          actorUserId: principal.id,
          action: 'request.created',
          toStatus: 'pending-upload',
          metadata: {
            checklistId: checklist.id,
            checklistVersion: checklist.version,
          },
        },
      });
      await transaction.tenantAuditLog.create({
        data: {
          companyId: principal.companyId,
          actorUserId: principal.id,
          action: 'document.request.create',
          targetType: 'document-request',
          targetId: request.id,
          metadata: {
            subjectUserId: input.subjectUserId,
            context: input.context,
            checklistId: checklist.id,
            checklistVersion: checklist.version,
          },
        },
      });
      return request.id;
    });
    return {
      request: await this.getRequestById(principal, requestId),
      idempotent: false,
    };
  }

  async createAdmissionRequest(
    principal: AuthenticatedPrincipal,
    input: {
      commandId: string;
      subjectUserId: string;
      checklistCode:
        'admission-general' | 'admission-administrative' | 'admission-driver';
    },
  ) {
    if (
      !principal.isAdministrator &&
      !principal.departments.some((department) =>
        ['personnel-department', 'human-resources'].includes(department),
      )
    ) {
      throw forbidden(
        'Somente administradores, RH e Departamento Pessoal podem iniciar a admissão documental.',
      );
    }
    const checklist = await this.prisma.documentChecklistTemplate.findFirst({
      where: {
        companyId: principal.companyId,
        code: input.checklistCode,
        active: true,
      },
      orderBy: { version: 'desc' },
      select: { id: true },
    });
    if (!checklist) throw notFound('Checklist de admissão ativo');
    return this.createRequest(
      principal,
      {
        commandId: input.commandId,
        subjectUserId: input.subjectUserId,
        checklistId: checklist.id,
        context: 'admission',
        notes: 'Solicitação criada automaticamente no cadastro do usuário.',
      },
      { skipManageAssertion: true },
    );
  }

  async listRequests(
    principal: AuthenticatedPrincipal,
    query: {
      page: number;
      pageSize: number;
      status?: DocumentRequestStatus;
      context?: DocumentRequestContext;
      subjectUserId?: string;
    },
  ) {
    const canManage =
      hasPeopleOperationsScope(principal) &&
      (principal.isAdministrator ||
        principal.permissions.includes('documents:manage'));
    const where: Prisma.DocumentRequestWhereInput = {
      companyId: principal.companyId,
      ...(!canManage ? { subjectUserId: principal.id } : {}),
      ...(query.subjectUserId && canManage
        ? { subjectUserId: query.subjectUserId }
        : {}),
      ...(query.status ? { status: requestStatusToPrisma[query.status] } : {}),
      ...(query.context
        ? { context: requestContextToPrisma[query.context] }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.documentRequest.findMany({
        where,
        include: {
          subject: { select: { id: true, name: true, email: true } },
          checklist: {
            select: { id: true, code: true, name: true, version: true },
          },
          items: { select: { status: true, requirement: true } },
        },
        orderBy: [{ deadline: 'asc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.documentRequest.count({ where }),
    ]);
    return {
      data: rows.map((row) => ({
        id: row.id,
        context: contextFromPrisma(row.context),
        status: requestStatusFromPrisma[row.status],
        deadline: row.deadline?.toISOString() ?? null,
        version: row.version,
        subject: row.subject,
        checklist: row.checklist,
        progress: {
          total: row.items.length,
          approved: row.items.filter(
            (item) => item.status === PrismaDocumentItemStatus.APPROVED,
          ).length,
          pending: row.items.filter(
            (item) => item.status !== PrismaDocumentItemStatus.APPROVED,
          ).length,
        },
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      meta: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.ceil(total / query.pageSize),
      },
    };
  }

  async getRequest(principal: AuthenticatedPrincipal, requestId: string) {
    return { request: await this.getRequestById(principal, requestId) };
  }

  async upload(
    principal: AuthenticatedPrincipal,
    requestItemId: string,
    input: {
      commandId: string;
      files: Array<{
        originalName: string;
        mimeType: string;
        sizeBytes: number;
        content: Buffer;
        side: DocumentFileSide;
        pageNumber: number;
      }>;
    },
  ) {
    const duplicate = await this.prisma.documentSubmission.findUnique({
      where: {
        companyId_commandId: {
          companyId: principal.companyId,
          commandId: input.commandId,
        },
      },
      include: { requestItem: { select: { requestId: true } } },
    });
    if (duplicate) {
      return {
        request: await this.getRequestById(
          principal,
          duplicate.requestItem.requestId,
        ),
        submissionId: duplicate.id,
        idempotent: true,
      };
    }

    const item = await this.prisma.documentRequestItem.findUnique({
      where: {
        id_companyId: { id: requestItemId, companyId: principal.companyId },
      },
      include: { request: true, documentType: true },
    });
    if (!item) throw notFound('Item documental');
    this.assertOwnOrManage(principal, item.request.subjectUserId);
    const currentStatus = itemStatusFromPrisma[item.status];
    if (
      ![
        'pending-upload',
        'resubmission-required',
        'rejected',
        'expired',
      ].includes(currentStatus)
    ) {
      throw conflict('Este item não aceita um novo envio no estado atual.');
    }
    const config = jsonRecord(item.configSnapshot);
    const policy = {
      acceptedMimeTypes: Array.isArray(config.acceptedMimeTypes)
        ? config.acceptedMimeTypes.filter(
            (value): value is string => typeof value === 'string',
          )
        : item.documentType.acceptedMimeTypes,
      maxFileSizeBytes:
        typeof config.maxFileSizeBytes === 'number'
          ? config.maxFileSizeBytes
          : item.documentType.maxFileSizeBytes,
      minFiles:
        typeof config.minFiles === 'number'
          ? config.minFiles
          : item.documentType.minFiles,
      maxFiles:
        typeof config.maxFiles === 'number'
          ? config.maxFiles
          : item.documentType.maxFiles,
      allowsMultiplePages:
        typeof config.allowsMultiplePages === 'boolean'
          ? config.allowsMultiplePages
          : item.documentType.allowsMultiplePages,
      requiresFrontBack:
        typeof config.requiresFrontBack === 'boolean'
          ? config.requiresFrontBack
          : item.documentType.requiresFrontBack,
    };
    const files = validateDocumentUpload(input.files, policy);
    assertDocumentItemTransition(currentStatus, 'submitted');

    const submissionId = await this.prisma.$transaction(async (transaction) => {
      const changed = await transaction.documentRequestItem.updateMany({
        where: {
          id: item.id,
          companyId: principal.companyId,
          currentVersion: item.currentVersion,
          status: item.status,
        },
        data: {
          currentVersion: { increment: 1 },
          status: PrismaDocumentItemStatus.SUBMITTED,
        },
      });
      if (changed.count !== 1)
        throw conflict('O item foi alterado; recarregue e tente novamente.');
      const submission = await transaction.documentSubmission.create({
        data: {
          companyId: principal.companyId,
          requestItemId: item.id,
          submittedByUserId: principal.id,
          commandId: input.commandId,
          version: item.currentVersion + 1,
          files: {
            create: files.map((file) => ({
              uploadedByUserId: principal.id,
              side: sidesToPrisma[file.side],
              pageNumber: file.pageNumber,
              fileName: file.originalName,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              sha256: file.sha256,
              content: Uint8Array.from(file.content),
            })),
          },
        },
      });
      const allItems = await transaction.documentRequestItem.findMany({
        where: { companyId: principal.companyId, requestId: item.requestId },
        select: { status: true, requirement: true },
      });
      const nextRequestStatus = requestStatusForItems(allItems);
      await transaction.documentRequest.update({
        where: {
          id_companyId: { id: item.requestId, companyId: principal.companyId },
        },
        data: { status: nextRequestStatus, version: { increment: 1 } },
      });
      await transaction.documentStatusHistory.createMany({
        data: [
          {
            companyId: principal.companyId,
            requestId: item.requestId,
            requestItemId: item.id,
            submissionId: submission.id,
            actorUserId: principal.id,
            action: 'submission.created',
            fromStatus: currentStatus,
            toStatus: 'submitted',
            metadata: { version: submission.version, fileCount: files.length },
          },
        ],
      });
      await transaction.tenantAuditLog.create({
        data: {
          companyId: principal.companyId,
          actorUserId: principal.id,
          action: 'document.submission.create',
          targetType: 'document-submission',
          targetId: submission.id,
          metadata: {
            requestId: item.requestId,
            requestItemId: item.id,
            version: submission.version,
            files: files.map((file) => ({
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              sha256: file.sha256,
              side: file.side,
              pageNumber: file.pageNumber,
            })),
          },
        },
      });
      return submission.id;
    });
    return {
      request: await this.getRequestById(principal, item.requestId),
      submissionId,
      idempotent: false,
    };
  }

  async completeSubmission(
    principal: AuthenticatedPrincipal,
    submissionId: string,
  ) {
    const submission = await this.prisma.documentSubmission.findUnique({
      where: {
        id_companyId: { id: submissionId, companyId: principal.companyId },
      },
      include: {
        validation: true,
        files: { where: { deletedAt: null } },
        requestItem: { include: { request: true, documentType: true } },
      },
    });
    if (!submission) throw notFound('Envio documental');
    this.assertOwnOrManage(
      principal,
      submission.requestItem.request.subjectUserId,
    );
    if (submission.validation?.status === DocumentValidationStatus.COMPLETED) {
      return {
        request: await this.getRequestById(
          principal,
          submission.requestItem.requestId,
        ),
        validation: submission.validation,
        idempotent: true,
      };
    }
    const current = itemStatusFromPrisma[submission.status];
    assertDocumentItemTransition(current, 'automatic-validation');
    assertDocumentItemTransition(
      'automatic-validation',
      'pending-human-review',
    );
    const config = jsonRecord(submission.requestItem.configSnapshot);
    const policy = {
      acceptedMimeTypes: submission.requestItem.documentType.acceptedMimeTypes,
      maxFileSizeBytes: submission.requestItem.documentType.maxFileSizeBytes,
      minFiles: typeof config.minFiles === 'number' ? config.minFiles : 1,
      maxFiles: typeof config.maxFiles === 'number' ? config.maxFiles : 1,
      allowsMultiplePages: config.allowsMultiplePages === true,
      requiresFrontBack: config.requiresFrontBack === true,
    };
    const result = localStructuralValidation({
      files: submission.files.map((file) => ({
        side: sidesFromPrisma[file.side],
        pageNumber: file.pageNumber,
        mimeType: file.mimeType,
      })),
      policy,
      documentTypeCode: submission.requestItem.documentType.code,
    });

    const validation = await this.prisma.$transaction(async (transaction) => {
      await transaction.documentSubmission.update({
        where: {
          id_companyId: { id: submission.id, companyId: principal.companyId },
        },
        data: { status: PrismaDocumentItemStatus.PENDING_HUMAN_REVIEW },
      });
      await transaction.documentRequestItem.update({
        where: {
          id_companyId: {
            id: submission.requestItemId,
            companyId: principal.companyId,
          },
        },
        data: { status: PrismaDocumentItemStatus.PENDING_HUMAN_REVIEW },
      });
      const record = await transaction.documentValidation.upsert({
        where: {
          submissionId_companyId: {
            submissionId: submission.id,
            companyId: principal.companyId,
          },
        },
        create: {
          companyId: principal.companyId,
          submissionId: submission.id,
          status: DocumentValidationStatus.COMPLETED,
          suggestedDocumentTypeCode: result.suggestedDocumentTypeCode,
          result: { manualReviewRequired: true },
          alerts: result.alerts,
          extractedFields: {},
          overallConfidence: result.overallConfidence,
          summary: result.summary,
          provider: result.provider,
          modelVersion: result.modelVersion,
          startedAt: new Date(),
          completedAt: new Date(),
        },
        update: {
          status: DocumentValidationStatus.COMPLETED,
          alerts: result.alerts,
          result: { manualReviewRequired: true },
          summary: result.summary,
          completedAt: new Date(),
        },
      });
      const allItems = await transaction.documentRequestItem.findMany({
        where: {
          companyId: principal.companyId,
          requestId: submission.requestItem.requestId,
        },
        select: { status: true, requirement: true },
      });
      await transaction.documentRequest.update({
        where: {
          id_companyId: {
            id: submission.requestItem.requestId,
            companyId: principal.companyId,
          },
        },
        data: {
          status: requestStatusForItems(allItems),
          version: { increment: 1 },
        },
      });
      await transaction.documentStatusHistory.create({
        data: {
          companyId: principal.companyId,
          requestId: submission.requestItem.requestId,
          requestItemId: submission.requestItemId,
          submissionId: submission.id,
          actorUserId: principal.id,
          action: 'validation.completed',
          fromStatus: current,
          toStatus: 'pending-human-review',
          metadata: { provider: result.provider, manualReviewRequired: true },
        },
      });
      await transaction.tenantAuditLog.create({
        data: {
          companyId: principal.companyId,
          actorUserId: principal.id,
          action: 'document.validation.complete',
          targetType: 'document-submission',
          targetId: submission.id,
          metadata: {
            provider: result.provider,
            alertCount: result.alerts.length,
          },
        },
      });
      return record;
    });
    return {
      request: await this.getRequestById(
        principal,
        submission.requestItem.requestId,
      ),
      validation,
      idempotent: false,
    };
  }

  async review(
    principal: AuthenticatedPrincipal,
    submissionId: string,
    input: {
      commandId: string;
      decision: 'approved' | 'rejected' | 'resubmission-required';
      reason?: string;
      notes?: string;
      correctedFields?: Readonly<Record<string, unknown>>;
      confirmedFields?: Readonly<Record<string, unknown>>;
      validUntil?: string;
      originalCheckStatus?:
        'not-required' | 'pending' | 'confirmed' | 'divergent';
      originalObservation?: string;
    },
  ) {
    assertReview(principal);
    const duplicate = await this.prisma.documentReview.findUnique({
      where: {
        companyId_commandId: {
          companyId: principal.companyId,
          commandId: input.commandId,
        },
      },
      include: { submission: { include: { requestItem: true } } },
    });
    if (duplicate) {
      return {
        request: await this.getRequestById(
          principal,
          duplicate.submission.requestItem.requestId,
        ),
        reviewId: duplicate.id,
        idempotent: true,
      };
    }
    if (
      input.decision !== 'approved' &&
      (!input.reason || input.reason.trim().length < 3)
    ) {
      throw validationError(
        'Informe o motivo da recusa ou solicitação de reenvio.',
      );
    }
    const submission = await this.prisma.documentSubmission.findUnique({
      where: {
        id_companyId: { id: submissionId, companyId: principal.companyId },
      },
      include: {
        files: { where: { deletedAt: null }, select: { id: true } },
        requestItem: { include: { request: true, documentType: true } },
      },
    });
    if (!submission) throw notFound('Envio documental');
    const current = itemStatusFromPrisma[submission.status];
    const target: DocumentItemStatus = input.decision;
    assertDocumentItemTransition(current, target);
    const config = jsonRecord(submission.requestItem.configSnapshot);
    const originalRequired = config.requiresOriginal === true;
    if (
      input.decision === 'approved' &&
      originalRequired &&
      input.originalCheckStatus !== 'confirmed'
    ) {
      throw validationError(
        'Confirme a apresentação do original antes da aprovação.',
      );
    }
    if (
      input.decision === 'approved' &&
      config.expires === true &&
      !input.validUntil
    ) {
      throw validationError('Informe a data de validade do documento.');
    }

    const reviewId = await this.prisma.$transaction(async (transaction) => {
      const correctedFields = input.correctedFields ?? {};
      const confirmedAt = new Date();
      const confirmedFields = Object.fromEntries(
        Object.entries(input.confirmedFields ?? {}).map(([key, value]) => [
          key,
          {
            value,
            confirmedByUserId: principal.id,
            confirmedAt: confirmedAt.toISOString(),
            sourceSubmissionId: submission.id,
            sourceDocumentTypeCode: submission.requestItem.documentType.code,
            sourceVersion: submission.version,
            sourceFileIds: submission.files.map((file) => file.id),
          },
        ]),
      );
      await transaction.documentSubmission.update({
        where: {
          id_companyId: { id: submission.id, companyId: principal.companyId },
        },
        data: {
          status: itemStatusToPrisma[target],
          confirmedData: confirmedFields as Prisma.InputJsonValue,
        },
      });
      await transaction.documentRequestItem.update({
        where: {
          id_companyId: {
            id: submission.requestItemId,
            companyId: principal.companyId,
          },
        },
        data: {
          status: itemStatusToPrisma[target],
          validUntil: input.validUntil ? new Date(input.validUntil) : undefined,
        },
      });
      const review = await transaction.documentReview.create({
        data: {
          companyId: principal.companyId,
          submissionId: submission.id,
          reviewedByUserId: principal.id,
          commandId: input.commandId,
          decision:
            input.decision === 'approved'
              ? DocumentReviewDecision.APPROVED
              : input.decision === 'rejected'
                ? DocumentReviewDecision.REJECTED
                : DocumentReviewDecision.RESUBMISSION_REQUIRED,
          reason: input.reason?.trim() || null,
          notes: input.notes?.trim() || null,
          correctedFields: correctedFields as Prisma.InputJsonValue,
          confirmedFields: confirmedFields as Prisma.InputJsonValue,
          originalCheckStatus:
            input.originalCheckStatus === 'confirmed'
              ? DocumentOriginalCheckStatus.CONFIRMED
              : input.originalCheckStatus === 'divergent'
                ? DocumentOriginalCheckStatus.DIVERGENT
                : input.originalCheckStatus === 'pending'
                  ? DocumentOriginalCheckStatus.PENDING
                  : DocumentOriginalCheckStatus.NOT_REQUIRED,
          originalCheckedAt:
            input.originalCheckStatus === 'confirmed' ||
            input.originalCheckStatus === 'divergent'
              ? new Date()
              : null,
          originalObservation: input.originalObservation?.trim() || null,
        },
      });
      const allItems = await transaction.documentRequestItem.findMany({
        where: {
          companyId: principal.companyId,
          requestId: submission.requestItem.requestId,
        },
        select: { status: true, requirement: true },
      });
      const requestStatus = requestStatusForItems(allItems);
      await transaction.documentRequest.update({
        where: {
          id_companyId: {
            id: submission.requestItem.requestId,
            companyId: principal.companyId,
          },
        },
        data: {
          status: requestStatus,
          version: { increment: 1 },
          completedAt:
            requestStatus === PrismaDocumentRequestStatus.APPROVED
              ? new Date()
              : null,
        },
      });
      await transaction.documentStatusHistory.create({
        data: {
          companyId: principal.companyId,
          requestId: submission.requestItem.requestId,
          requestItemId: submission.requestItemId,
          submissionId: submission.id,
          actorUserId: principal.id,
          action: `review.${input.decision}`,
          fromStatus: current,
          toStatus: target,
          reason: input.reason?.trim() || null,
          metadata: {
            correctedFieldNames: Object.keys(correctedFields),
            confirmedFieldNames: Object.keys(confirmedFields),
            originalCheckStatus: input.originalCheckStatus ?? 'not-required',
          },
        },
      });
      await transaction.tenantAuditLog.create({
        data: {
          companyId: principal.companyId,
          actorUserId: principal.id,
          action: `document.review.${input.decision}`,
          targetType: 'document-submission',
          targetId: submission.id,
          metadata: {
            requestId: submission.requestItem.requestId,
            requestItemId: submission.requestItemId,
            fromStatus: current,
            toStatus: target,
          },
        },
      });
      return review.id;
    });
    return {
      request: await this.getRequestById(
        principal,
        submission.requestItem.requestId,
      ),
      reviewId,
      idempotent: false,
    };
  }

  async updateExtractedData(
    principal: AuthenticatedPrincipal,
    submissionId: string,
    input: {
      fields: Readonly<Record<string, unknown>>;
      confidences?: Readonly<Record<string, unknown>>;
    },
  ) {
    assertReview(principal);
    const submission = await this.prisma.documentSubmission.findUnique({
      where: {
        id_companyId: { id: submissionId, companyId: principal.companyId },
      },
      include: {
        files: { where: { deletedAt: null }, select: { id: true } },
        validation: true,
        requestItem: { include: { request: true, documentType: true } },
      },
    });
    if (!submission) throw notFound('Envio documental');
    if (submission.status !== PrismaDocumentItemStatus.PENDING_HUMAN_REVIEW) {
      throw validationError(
        'Os dados propostos só podem ser alterados durante a revisão humana.',
      );
    }
    const config = jsonRecord(submission.requestItem.configSnapshot);
    const schema = jsonRecord(config.extractionSchema);
    const definitions = Array.isArray(schema.fields) ? schema.fields : [];
    const allowedKeys = new Set(
      definitions
        .map((definition) => jsonRecord(definition).key)
        .filter((key): key is string => typeof key === 'string'),
    );
    const unexpected = Object.keys(input.fields).filter(
      (key) => !allowedKeys.has(key),
    );
    if (unexpected.length) {
      throw validationError(
        `Campos fora do esquema configurado: ${unexpected.join(', ')}.`,
      );
    }
    const updatedAt = new Date();
    const sourceFileIds = submission.files.map((file) => file.id);
    const extractedData = Object.fromEntries(
      Object.entries(input.fields).map(([key, value]) => {
        const rawConfidence = input.confidences?.[key];
        const confidence =
          typeof rawConfidence === 'number' &&
          rawConfidence >= 0 &&
          rawConfidence <= 1
            ? rawConfidence
            : null;
        return [
          key,
          {
            value,
            confidence,
            proposedByUserId: principal.id,
            proposedAt: updatedAt.toISOString(),
            sourceSubmissionId: submission.id,
            sourceDocumentTypeCode: submission.requestItem.documentType.code,
            sourceVersion: submission.version,
            sourceFileIds,
          },
        ];
      }),
    );
    const numericConfidences = Object.values(extractedData)
      .map((record) => record.confidence)
      .filter((value): value is number => typeof value === 'number');
    await this.prisma.$transaction(async (transaction) => {
      await transaction.documentSubmission.update({
        where: {
          id_companyId: { id: submission.id, companyId: principal.companyId },
        },
        data: { extractedData: extractedData as Prisma.InputJsonValue },
      });
      await transaction.documentValidation.upsert({
        where: {
          submissionId_companyId: {
            submissionId: submission.id,
            companyId: principal.companyId,
          },
        },
        create: {
          companyId: principal.companyId,
          submissionId: submission.id,
          status: DocumentValidationStatus.COMPLETED,
          extractedFields: extractedData as Prisma.InputJsonValue,
          alerts: [],
          result: { manualReviewRequired: true },
          provider: 'human-assisted',
          startedAt: updatedAt,
          completedAt: updatedAt,
          overallConfidence: numericConfidences.length
            ? numericConfidences.reduce((sum, value) => sum + value, 0) /
              numericConfidences.length
            : null,
          summary: 'Dados propostos registrados para confirmação humana.',
        },
        update: {
          extractedFields: extractedData as Prisma.InputJsonValue,
          provider: 'human-assisted',
          completedAt: updatedAt,
          overallConfidence: numericConfidences.length
            ? numericConfidences.reduce((sum, value) => sum + value, 0) /
              numericConfidences.length
            : null,
          summary: 'Dados propostos registrados para confirmação humana.',
        },
      });
      await transaction.tenantAuditLog.create({
        data: {
          companyId: principal.companyId,
          actorUserId: principal.id,
          action: 'document.extraction.proposed',
          targetType: 'document-submission',
          targetId: submission.id,
          metadata: { fieldNames: Object.keys(input.fields), sourceFileIds },
        },
      });
    });
    return {
      request: await this.getRequestById(
        principal,
        submission.requestItem.requestId,
      ),
    };
  }

  async fileContent(principal: AuthenticatedPrincipal, fileId: string) {
    const file = await this.prisma.documentFile.findUnique({
      where: { id_companyId: { id: fileId, companyId: principal.companyId } },
      include: {
        submission: {
          include: { requestItem: { include: { request: true } } },
        },
      },
    });
    if (!file || file.deletedAt) throw notFound('Arquivo documental');
    this.assertOwnOrManage(
      principal,
      file.submission.requestItem.request.subjectUserId,
    );
    await this.audit(
      principal,
      'document.file.view',
      'document-file',
      file.id,
      {
        requestId: file.submission.requestItem.requestId,
      },
    );
    return {
      fileName: file.fileName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      content: Buffer.from(file.content),
    };
  }

  async history(principal: AuthenticatedPrincipal, requestId: string) {
    await this.getRequestById(principal, requestId);
    const data = await this.prisma.documentStatusHistory.findMany({
      where: { companyId: principal.companyId, requestId },
      include: { actor: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      data: data.map((entry) => ({
        ...entry,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  async expiring(principal: AuthenticatedPrincipal, withinDays: number) {
    const canManage =
      hasPeopleOperationsScope(principal) &&
      (principal.isAdministrator ||
        principal.permissions.includes('documents:manage'));
    const now = new Date();
    const until = new Date(now.getTime() + withinDays * 86_400_000);
    const rows = await this.prisma.documentRequestItem.findMany({
      where: {
        companyId: principal.companyId,
        status: PrismaDocumentItemStatus.APPROVED,
        validUntil: { gte: now, lte: until },
        ...(!canManage ? { request: { subjectUserId: principal.id } } : {}),
      },
      include: {
        documentType: {
          select: { code: true, name: true, renewalLeadDays: true },
        },
        request: { include: { subject: { select: { id: true, name: true } } } },
      },
      orderBy: { validUntil: 'asc' },
    });
    return {
      data: rows.map((row) => ({
        requestItemId: row.id,
        requestId: row.requestId,
        subject: row.request.subject,
        documentType: row.documentType,
        validUntil: row.validUntil?.toISOString() ?? null,
      })),
    };
  }

  async renew(
    principal: AuthenticatedPrincipal,
    requestItemId: string,
    input: { commandId: string; deadline?: string },
  ) {
    assertManage(principal);
    const source = await this.prisma.documentRequestItem.findUnique({
      where: {
        id_companyId: { id: requestItemId, companyId: principal.companyId },
      },
      include: { request: true },
    });
    if (!source) throw notFound('Documento de origem');
    if (
      source.status !== PrismaDocumentItemStatus.APPROVED &&
      source.status !== PrismaDocumentItemStatus.EXPIRED
    ) {
      throw conflict(
        'Somente documentos aprovados ou vencidos podem ser renovados.',
      );
    }
    const duplicate = await this.prisma.documentRequest.findUnique({
      where: {
        companyId_commandId: {
          companyId: principal.companyId,
          commandId: input.commandId,
        },
      },
      select: { id: true },
    });
    if (duplicate)
      return {
        request: await this.getRequestById(principal, duplicate.id),
        idempotent: true,
      };

    const request = await this.prisma.$transaction(async (transaction) => {
      const created = await transaction.documentRequest.create({
        data: {
          companyId: principal.companyId,
          subjectUserId: source.request.subjectUserId,
          createdByUserId: principal.id,
          checklistId: source.request.checklistId,
          context: PrismaDocumentRequestContext.DOCUMENT_RENEWAL,
          department: source.request.department,
          status: PrismaDocumentRequestStatus.PENDING_UPLOAD,
          deadline: input.deadline ? new Date(input.deadline) : null,
          notes: `Renovação do item ${source.id}.`,
          commandId: input.commandId,
          items: {
            create: {
              documentTypeId: source.documentTypeId,
              renewedFromItemId: source.id,
              requirement: PrismaDocumentRequirement.REQUIRED,
              position: 1,
              instructions: source.instructions,
              configSnapshot: jsonRecord(
                source.configSnapshot,
              ) as Prisma.InputJsonValue,
              dueAt: input.deadline ? new Date(input.deadline) : null,
            },
          },
        },
      });
      await transaction.documentStatusHistory.create({
        data: {
          companyId: principal.companyId,
          requestId: created.id,
          actorUserId: principal.id,
          action: 'renewal.created',
          toStatus: 'pending-upload',
          metadata: { renewedFromItemId: source.id },
        },
      });
      return created;
    });
    return {
      request: await this.getRequestById(principal, request.id),
      idempotent: false,
    };
  }

  async exportXlsx(principal: AuthenticatedPrincipal, subjectUserId?: string) {
    assertManage(principal);
    if (
      !principal.isAdministrator &&
      !principal.permissions.includes('documents:export')
    ) {
      throw forbidden(
        'Esta operação exige permissão de exportação documental.',
      );
    }
    if (subjectUserId) {
      const subject = await this.prisma.user.findUnique({
        where: {
          id_companyId: { id: subjectUserId, companyId: principal.companyId },
        },
        select: { id: true },
      });
      if (!subject) throw notFound('Usuário titular');
    }
    const submissions = await this.prisma.documentSubmission.findMany({
      where: {
        companyId: principal.companyId,
        ...(subjectUserId
          ? { requestItem: { request: { subjectUserId } } }
          : {}),
      },
      include: {
        validation: true,
        files: {
          where: { deletedAt: null },
          select: { id: true, fileName: true },
        },
        reviews: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { reviewedBy: { select: { id: true, name: true } } },
        },
        requestItem: {
          include: {
            request: {
              include: {
                subject: { select: { id: true, name: true, email: true } },
              },
            },
            documentType: { select: { code: true, name: true } },
          },
        },
      },
      orderBy: { submittedAt: 'desc' },
    });
    const workbook = new ExcelJS.Workbook();
    const summary = workbook.addWorksheet('Resumo');
    summary.columns = [
      { header: 'Solicitação', key: 'requestId', width: 38 },
      { header: 'Titular', key: 'subject', width: 32 },
      { header: 'E-mail', key: 'email', width: 32 },
      { header: 'Documento', key: 'documentType', width: 40 },
      { header: 'Versão', key: 'version', width: 10 },
      { header: 'Status', key: 'status', width: 24 },
      { header: 'Enviado em', key: 'submittedAt', width: 24 },
      { header: 'Dados confirmados (JSON)', key: 'confirmedData', width: 70 },
    ];
    const structured = workbook.addWorksheet('Dados estruturados');
    structured.columns = [
      { header: 'ID do usuário', key: 'subjectId', width: 38 },
      { header: 'Titular', key: 'subject', width: 32 },
      { header: 'E-mail', key: 'email', width: 32 },
      { header: 'Código do documento', key: 'documentCode', width: 28 },
      { header: 'Documento', key: 'documentType', width: 38 },
      { header: 'Campo', key: 'field', width: 28 },
      { header: 'Valor extraído/proposto', key: 'extracted', width: 42 },
      { header: 'Confiança', key: 'confidence', width: 14 },
      { header: 'Valor confirmado', key: 'confirmed', width: 42 },
      { header: 'Confirmado por', key: 'confirmedBy', width: 30 },
      { header: 'Data da confirmação', key: 'confirmedAt', width: 24 },
      { header: 'Envio de origem', key: 'submissionId', width: 38 },
      { header: 'Versão', key: 'version', width: 10 },
      { header: 'Arquivos de origem', key: 'fileIds', width: 60 },
    ];
    for (const submission of submissions) {
      summary.addRow({
        requestId: submission.requestItem.requestId,
        subject: submission.requestItem.request.subject.name,
        email: submission.requestItem.request.subject.email,
        documentType: submission.requestItem.documentType.name,
        version: submission.version,
        status: itemStatusFromPrisma[submission.status],
        submittedAt: submission.submittedAt.toISOString(),
        confirmedData: JSON.stringify(submission.confirmedData),
      });
      const extracted = jsonRecord(submission.extractedData);
      const confirmed = jsonRecord(submission.confirmedData);
      const fieldNames = new Set([
        ...Object.keys(extracted),
        ...Object.keys(confirmed),
      ]);
      for (const field of fieldNames) {
        const proposedRecord = jsonRecord(extracted[field]);
        const confirmedRecord = jsonRecord(confirmed[field]);
        structured.addRow({
          subjectId: submission.requestItem.request.subject.id,
          subject: submission.requestItem.request.subject.name,
          email: submission.requestItem.request.subject.email,
          documentCode: submission.requestItem.documentType.code,
          documentType: submission.requestItem.documentType.name,
          field,
          extracted: spreadsheetValue(proposedRecord.value ?? extracted[field]),
          confidence:
            typeof proposedRecord.confidence === 'number'
              ? proposedRecord.confidence
              : '',
          confirmed: spreadsheetValue(
            confirmedRecord.value ?? confirmed[field],
          ),
          confirmedBy: submission.reviews[0]?.reviewedBy.name ?? '',
          confirmedAt: spreadsheetValue(confirmedRecord.confirmedAt),
          submissionId: submission.id,
          version: submission.version,
          fileIds: submission.files.map((file) => file.id).join(', '),
        });
      }
    }
    summary.getRow(1).font = { bold: true };
    summary.autoFilter = { from: 'A1', to: 'H1' };
    structured.getRow(1).font = { bold: true };
    structured.autoFilter = { from: 'A1', to: 'N1' };
    const buffer = await workbook.xlsx.writeBuffer();
    await this.audit(
      principal,
      'document.export.xlsx',
      'company',
      principal.companyId,
      {
        rowCount: submissions.length,
        subjectUserId: subjectUserId ?? null,
      },
    );
    return Buffer.from(buffer);
  }

  async exportUserFiles(
    principal: AuthenticatedPrincipal,
    subjectUserId: string,
  ) {
    assertManage(principal);
    if (
      !principal.isAdministrator &&
      !principal.permissions.includes('documents:export')
    ) {
      throw forbidden(
        'Esta operação exige permissão de exportação documental.',
      );
    }
    const subject = await this.prisma.user.findUnique({
      where: {
        id_companyId: { id: subjectUserId, companyId: principal.companyId },
      },
      select: { id: true, name: true, email: true },
    });
    if (!subject) throw notFound('Usuário titular');
    const files = await this.prisma.documentFile.findMany({
      where: {
        companyId: principal.companyId,
        deletedAt: null,
        submission: { requestItem: { request: { subjectUserId } } },
      },
      include: {
        submission: {
          include: {
            requestItem: { include: { documentType: true, request: true } },
          },
        },
      },
      orderBy: [
        { submission: { requestItem: { position: 'asc' } } },
        { createdAt: 'asc' },
      ],
    });
    const zip = new JSZip();
    const manifest = files.map((file) => {
      const folder = `${safeArchiveName(file.submission.requestItem.documentType.code)}/v${file.submission.version}`;
      const archivePath = `${folder}/${file.id}_${safeArchiveName(file.fileName)}`;
      zip.file(archivePath, Buffer.from(file.content));
      return {
        archivePath,
        fileId: file.id,
        originalName: file.fileName,
        documentTypeCode: file.submission.requestItem.documentType.code,
        documentTypeName: file.submission.requestItem.documentType.name,
        submissionId: file.submissionId,
        version: file.submission.version,
        sha256: file.sha256,
        createdAt: file.createdAt.toISOString(),
      };
    });
    zip.file(
      'manifesto.json',
      JSON.stringify(
        { subject, generatedAt: new Date().toISOString(), files: manifest },
        null,
        2,
      ),
    );
    const content = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    });
    await this.audit(
      principal,
      'document.export.files',
      'user',
      subjectUserId,
      { fileCount: files.length },
    );
    return content;
  }

  private async getRequestById(
    principal: AuthenticatedPrincipal,
    requestId: string,
  ) {
    const row = await this.prisma.documentRequest.findUnique({
      where: {
        id_companyId: { id: requestId, companyId: principal.companyId },
      },
      include: requestDetailInclude,
    });
    if (!row) throw notFound('Solicitação documental');
    this.assertOwnOrManage(principal, row.subjectUserId);
    return presentRequest(row);
  }

  private assertOwnOrManage(
    principal: AuthenticatedPrincipal,
    subjectUserId: string,
  ): void {
    if (principal.id === subjectUserId) return;
    assertManage(principal);
  }

  private audit(
    principal: AuthenticatedPrincipal,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Readonly<Record<string, unknown>>,
  ) {
    return this.prisma.tenantAuditLog.create({
      data: {
        companyId: principal.companyId,
        actorUserId: principal.id,
        action,
        targetType,
        targetId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  private isUniqueError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}

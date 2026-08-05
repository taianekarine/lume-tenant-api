import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
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
  employeeDocumentRuleContext,
  eligibleDependentsForDocument,
  matchesEmployeeDocumentCondition,
} from '../../../domain/documents/employee-document-rules';
import type {
  MaritalStatus,
  MilitaryDocumentStatus,
  UserDependent,
} from '../../../domain/entities/user';
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
import { seedInitialDocumentCatalog } from '../../../infra/bootstrap/document-catalog.seed';
import {
  DOCUMENT_REVIEW_AGENT,
  type DocumentReviewAgent,
  type DocumentReviewResult,
} from '../../contracts/document-review-agent';

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
  WAIVED: 'waived',
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

function deterministicCommandId(
  batchCommandId: string,
  subjectUserId: string,
): string {
  const bytes = createHash('sha256')
    .update(`${batchCommandId}:${subjectUserId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function profileConditionAppliesToBatch(documentTypeCode: string): boolean {
  return (
    documentTypeCode.startsWith('child-') ||
    [
      'marriage-certificate',
      'spouse-identification',
      'military-certificate',
    ].includes(documentTypeCode)
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
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(DOCUMENT_REVIEW_AGENT)
    private readonly reviewAgent?: DocumentReviewAgent,
  ) {}

  async ensureInitialDocumentCatalog(
    principal: AuthenticatedPrincipal,
  ): Promise<{ checklistId: string }> {
    if (!hasPeopleOperationsScope(principal)) {
      throw forbidden(
        'Somente administradores, RH, Departamento Pessoal ou Gerência podem provisionar o catálogo documental.',
      );
    }
    let checklist = await this.prisma.documentChecklistTemplate.findFirst({
      where: {
        companyId: principal.companyId,
        code: 'employee-documents-dynamic',
        active: true,
      },
      orderBy: { version: 'desc' },
      select: {
        id: true,
        items: {
          where: {
            documentType: { code: 'child-identification' },
            active: true,
          },
          select: { id: true },
        },
      },
    });
    if (!checklist || checklist.items.length === 0) {
      await this.prisma.$transaction((transaction) =>
        seedInitialDocumentCatalog(
          transaction,
          principal.companyId,
          principal.id,
        ),
      );
      checklist = await this.prisma.documentChecklistTemplate.findFirst({
        where: {
          companyId: principal.companyId,
          code: 'employee-documents-dynamic',
          active: true,
        },
        orderBy: { version: 'desc' },
        select: {
          id: true,
          items: {
            where: {
              documentType: { code: 'child-identification' },
              active: true,
            },
            select: { id: true },
          },
        },
      });
    }
    if (!checklist) throw notFound('Checklist documental dinâmico');
    return { checklistId: checklist.id };
  }

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
              company: { connect: { id: principal.companyId } },
              documentType: {
                connect: {
                  id_companyId: {
                    id: item.documentTypeId,
                    companyId: principal.companyId,
                  },
                },
              },
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
          select: {
            id: true,
            isActive: true,
            jobTitle: true,
            maritalStatus: true,
            militaryDocumentStatus: true,
            dependents: true,
          },
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
      const dependents = Array.isArray(subject.dependents)
        ? (subject.dependents as unknown as UserDependent[])
        : [];
      const ruleContext = employeeDocumentRuleContext({
        jobTitle: subject.jobTitle,
        maritalStatus: subject.maritalStatus as MaritalStatus | null,
        militaryDocumentStatus:
          subject.militaryDocumentStatus as MilitaryDocumentStatus,
        dependents,
      });
      const applicableItems = checklist.items.filter((item) =>
        item.requirement === PrismaDocumentRequirement.CONDITIONAL
          ? matchesEmployeeDocumentCondition(
              jsonRecord(item.condition),
              ruleContext,
            )
          : true,
      );
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
            create: applicableItems.map((item) => ({
              company: {
                connect: { id: principal.companyId },
              },
              documentType: {
                connect: {
                  id_companyId: {
                    id: item.documentTypeId,
                    companyId: principal.companyId,
                  },
                },
              },
              requirement:
                item.documentType.code === 'military-certificate' &&
                ruleContext.militaryDocumentStatus === 'pending-confirmation'
                  ? PrismaDocumentRequirement.OPTIONAL
                  : item.requirement === PrismaDocumentRequirement.CONDITIONAL
                    ? PrismaDocumentRequirement.REQUIRED
                    : item.requirement,
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
                ...(item.documentType.code.startsWith('child-')
                  ? { dependents }
                  : {}),
                ...(item.documentType.code === 'military-certificate' &&
                ruleContext.militaryDocumentStatus === 'pending-confirmation'
                  ? {
                      personnelDecisionRequired: true,
                      instructions:
                        'Departamento Pessoal deve confirmar se o documento militar é aplicável.',
                    }
                  : {}),
                ...(item.documentType.code === 'cnh' && ruleContext.isDriver
                  ? {
                      driverRequirements: {
                        category: 'D',
                        earRequired: true,
                        validityRequired: true,
                      },
                    }
                  : {}),
                ...jsonRecord(item.configOverrides),
              } as unknown as Prisma.InputJsonValue,
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
            ruleContext,
          } as unknown as Prisma.InputJsonValue,
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

  async createBatchRequests(
    principal: AuthenticatedPrincipal,
    input: {
      commandId: string;
      subjectUserIds: string[];
      documentTypeIds: string[];
      context: DocumentRequestContext;
      deadline?: string;
      notes?: string;
    },
  ) {
    assertManage(principal);
    const { checklistId } = await this.ensureInitialDocumentCatalog(principal);
    const result = await this.prisma.$transaction(async (transaction) => {
      const [subjects, documentTypes, checklist] = await Promise.all([
        transaction.user.findMany({
          where: {
            companyId: principal.companyId,
            id: { in: input.subjectUserIds },
            isActive: true,
          },
          select: {
            id: true,
            jobTitle: true,
            maritalStatus: true,
            militaryDocumentStatus: true,
            dependents: true,
          },
        }),
        transaction.documentType.findMany({
          where: {
            companyId: principal.companyId,
            id: { in: input.documentTypeIds },
            active: true,
          },
        }),
        transaction.documentChecklistTemplate.findUnique({
          where: {
            id_companyId: { id: checklistId, companyId: principal.companyId },
          },
          include: {
            items: {
              where: { active: true },
              include: { documentType: { select: { code: true } } },
            },
          },
        }),
      ]);
      if (subjects.length !== input.subjectUserIds.length) {
        throw notFound('Um ou mais usuários titulares ativos');
      }
      if (documentTypes.length !== input.documentTypeIds.length) {
        throw notFound('Um ou mais tipos documentais ativos');
      }
      if (!checklist?.active) throw notFound('Checklist documental dinâmico');

      const subjectsById = new Map(
        subjects.map((subject) => [subject.id, subject]),
      );
      const typesById = new Map(documentTypes.map((type) => [type.id, type]));
      const checklistItemsByTypeId = new Map(
        checklist.items.map((item) => [item.documentTypeId, item]),
      );
      const requests: Array<{
        id: string;
        subjectUserId: string;
        itemCount: number;
        idempotent: boolean;
      }> = [];
      const skippedDocuments: Array<{
        subjectUserId: string;
        documentTypeId: string;
        reason: string;
      }> = [];

      for (const subjectUserId of input.subjectUserIds) {
        const subject = subjectsById.get(subjectUserId)!;
        const commandId = deterministicCommandId(
          input.commandId,
          subjectUserId,
        );
        const duplicate = await transaction.documentRequest.findUnique({
          where: {
            companyId_commandId: { companyId: principal.companyId, commandId },
          },
          select: { id: true, items: { select: { id: true } } },
        });
        if (duplicate) {
          requests.push({
            id: duplicate.id,
            subjectUserId,
            itemCount: duplicate.items.length,
            idempotent: true,
          });
          continue;
        }

        const dependents = Array.isArray(subject.dependents)
          ? (subject.dependents as unknown as UserDependent[])
          : [];
        const ruleContext = employeeDocumentRuleContext({
          jobTitle: subject.jobTitle,
          maritalStatus: subject.maritalStatus as MaritalStatus | null,
          militaryDocumentStatus:
            subject.militaryDocumentStatus as MilitaryDocumentStatus,
          dependents,
        });
        const applicableTypes = input.documentTypeIds.flatMap(
          (documentTypeId) => {
            const documentType = typesById.get(documentTypeId)!;
            const checklistItem = checklistItemsByTypeId.get(documentTypeId);
            const condition = checklistItem
              ? jsonRecord(checklistItem.condition)
              : {};
            if (
              checklistItem?.requirement ===
                PrismaDocumentRequirement.CONDITIONAL &&
              profileConditionAppliesToBatch(documentType.code) &&
              !matchesEmployeeDocumentCondition(condition, ruleContext)
            ) {
              skippedDocuments.push({
                subjectUserId,
                documentTypeId,
                reason:
                  'Não aplicável ao perfil ou aos dependentes deste usuário.',
              });
              return [];
            }
            return [{ documentType, checklistItem }];
          },
        );
        if (applicableTypes.length === 0) continue;

        const configSnapshotFor = (
          documentType: (typeof documentTypes)[number],
          checklistItem: (typeof checklist.items)[number] | undefined,
        ) => {
          const eligibleDependents = eligibleDependentsForDocument(
            documentType.code,
            dependents,
          );
          return {
            code: documentType.code,
            name: documentType.name,
            acceptedMimeTypes: documentType.acceptedMimeTypes,
            maxFileSizeBytes: documentType.maxFileSizeBytes,
            minFiles: documentType.minFiles,
            maxFiles: documentType.maxFiles,
            allowsMultiplePages: documentType.allowsMultiplePages,
            requiresFrontBack: documentType.requiresFrontBack,
            expires: documentType.expires,
            defaultValidityDays: documentType.defaultValidityDays,
            renewalLeadDays: documentType.renewalLeadDays,
            requiresOriginal: documentType.requiresOriginal,
            extractionSchema: documentType.extractionSchema,
            batchCommandId: input.commandId,
            selectedInBatch: true,
            ...(eligibleDependents.length
              ? { dependents: eligibleDependents }
              : {}),
            ...(documentType.code === 'cnh' && ruleContext.isDriver
              ? {
                  driverRequirements: {
                    category: 'D',
                    earRequired: true,
                    validityRequired: true,
                  },
                }
              : {}),
            ...jsonRecord(checklistItem?.configOverrides),
          } as unknown as Prisma.InputJsonValue;
        };

        const existingRequest = await transaction.documentRequest.findFirst({
          where: {
            companyId: principal.companyId,
            subjectUserId,
            status: { not: PrismaDocumentRequestStatus.CANCELLED },
          },
          orderBy: { createdAt: 'asc' },
          include: {
            items: {
              select: {
                id: true,
                documentTypeId: true,
                status: true,
                position: true,
              },
            },
          },
        });

        if (existingRequest) {
          const existingByType = new Map(
            existingRequest.items.map((item) => [item.documentTypeId, item]),
          );
          let nextPosition = existingRequest.items.reduce(
            (highest, item) => Math.max(highest, item.position),
            0,
          );
          let changed = false;

          for (const { documentType, checklistItem } of applicableTypes) {
            const current = existingByType.get(documentType.id);
            if (current) {
              if (
                current.status === PrismaDocumentItemStatus.APPROVED ||
                current.status === PrismaDocumentItemStatus.WAIVED ||
                current.status === PrismaDocumentItemStatus.CANCELLED
              ) {
                await transaction.documentRequestItem.update({
                  where: {
                    id_companyId: {
                      id: current.id,
                      companyId: principal.companyId,
                    },
                  },
                  data: {
                    status: PrismaDocumentItemStatus.PENDING_UPLOAD,
                    requirement: PrismaDocumentRequirement.REQUIRED,
                    dueAt: input.deadline ? new Date(input.deadline) : null,
                    instructions: checklistItem?.instructions ?? null,
                    configSnapshot: configSnapshotFor(
                      documentType,
                      checklistItem,
                    ),
                  },
                });
                await transaction.documentStatusHistory.create({
                  data: {
                    companyId: principal.companyId,
                    requestId: existingRequest.id,
                    requestItemId: current.id,
                    actorUserId: principal.id,
                    action: 'item.reopened-by-batch-request',
                    fromStatus: itemStatusFromPrisma[current.status],
                    toStatus: 'pending-upload',
                    reason: input.notes?.trim() || null,
                    metadata: { batchCommandId: input.commandId },
                  },
                });
                changed = true;
              }
              continue;
            }

            nextPosition += 1;
            await transaction.documentRequestItem.create({
              data: {
                companyId: principal.companyId,
                requestId: existingRequest.id,
                documentTypeId: documentType.id,
                requirement: PrismaDocumentRequirement.REQUIRED,
                position: nextPosition,
                instructions: checklistItem?.instructions ?? null,
                dueAt: input.deadline ? new Date(input.deadline) : null,
                configSnapshot: configSnapshotFor(documentType, checklistItem),
              },
            });
            changed = true;
          }

          const allItems = await transaction.documentRequestItem.findMany({
            where: {
              companyId: principal.companyId,
              requestId: existingRequest.id,
            },
            select: { status: true, requirement: true },
          });
          await transaction.documentRequest.update({
            where: {
              id_companyId: {
                id: existingRequest.id,
                companyId: principal.companyId,
              },
            },
            data: {
              context: requestContextToPrisma[input.context],
              deadline: input.deadline
                ? new Date(input.deadline)
                : existingRequest.deadline,
              notes: input.notes?.trim() || existingRequest.notes,
              status: requestStatusForItems(allItems),
              completedAt: null,
              ...(changed ? { version: { increment: 1 } } : {}),
            },
          });
          await transaction.documentStatusHistory.create({
            data: {
              companyId: principal.companyId,
              requestId: existingRequest.id,
              actorUserId: principal.id,
              action: changed
                ? 'request.batch-merged'
                : 'request.batch-already-covered',
              fromStatus: requestStatusFromPrisma[existingRequest.status],
              toStatus:
                requestStatusFromPrisma[requestStatusForItems(allItems)],
              metadata: {
                batchCommandId: input.commandId,
                selectedDocumentTypeIds: input.documentTypeIds,
              },
            },
          });
          requests.push({
            id: existingRequest.id,
            subjectUserId,
            itemCount: applicableTypes.length,
            idempotent: !changed,
          });
          continue;
        }

        const request = await transaction.documentRequest.create({
          data: {
            companyId: principal.companyId,
            subjectUserId,
            createdByUserId: principal.id,
            checklistId,
            context: requestContextToPrisma[input.context],
            department: DepartmentCode.PERSONNEL_DEPARTMENT,
            status: PrismaDocumentRequestStatus.PENDING_UPLOAD,
            deadline: input.deadline ? new Date(input.deadline) : null,
            notes: input.notes?.trim() || null,
            commandId,
            items: {
              create: applicableTypes.map(
                ({ documentType, checklistItem }, index) => {
                  return {
                    company: { connect: { id: principal.companyId } },
                    documentType: {
                      connect: {
                        id_companyId: {
                          id: documentType.id,
                          companyId: principal.companyId,
                        },
                      },
                    },
                    requirement: PrismaDocumentRequirement.REQUIRED,
                    position: index + 1,
                    instructions: checklistItem?.instructions ?? null,
                    dueAt: input.deadline ? new Date(input.deadline) : null,
                    configSnapshot: configSnapshotFor(
                      documentType,
                      checklistItem,
                    ),
                  };
                },
              ),
            },
          },
          select: { id: true, items: { select: { id: true } } },
        });
        await transaction.documentStatusHistory.create({
          data: {
            companyId: principal.companyId,
            requestId: request.id,
            actorUserId: principal.id,
            action: 'request.batch-created',
            toStatus: 'pending-upload',
            metadata: {
              batchCommandId: input.commandId,
              context: input.context,
              selectedDocumentTypeIds: input.documentTypeIds,
            },
          },
        });
        requests.push({
          id: request.id,
          subjectUserId,
          itemCount: request.items.length,
          idempotent: false,
        });
      }

      await transaction.tenantAuditLog.create({
        data: {
          companyId: principal.companyId,
          actorUserId: principal.id,
          action: 'document.request.batch-create',
          targetType: 'document-request-batch',
          targetId: input.commandId,
          metadata: {
            subjectCount: input.subjectUserIds.length,
            selectedDocumentCount: input.documentTypeIds.length,
            requestCount: requests.length,
            skippedDocumentCount: skippedDocuments.length,
          },
        },
      });
      return { requests, skippedDocuments };
    });
    return {
      ...result,
      createdCount: result.requests.filter((request) => !request.idempotent)
        .length,
      idempotentCount: result.requests.filter((request) => request.idempotent)
        .length,
    };
  }

  async createAdmissionRequest(
    principal: AuthenticatedPrincipal,
    input: {
      commandId: string;
      subjectUserId: string;
      checklistCode:
        | 'employee-documents-dynamic'
        | 'admission-general'
        | 'admission-administrative'
        | 'admission-driver';
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
    const checklist =
      input.checklistCode === 'employee-documents-dynamic'
        ? {
            id: (await this.ensureInitialDocumentCatalog(principal))
              .checklistId,
          }
        : await this.prisma.documentChecklistTemplate.findFirst({
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

  async synchronizeEmployeeDocuments(
    principal: AuthenticatedPrincipal,
    subjectUserId: string,
  ) {
    if (
      !principal.isAdministrator &&
      !principal.departments.some((department) =>
        ['personnel-department', 'human-resources'].includes(department),
      )
    ) {
      throw forbidden(
        'Somente administradores, RH e Departamento Pessoal podem recalcular documentos.',
      );
    }
    const [subject, checklist, request] = await Promise.all([
      this.prisma.user.findUnique({
        where: {
          id_companyId: { id: subjectUserId, companyId: principal.companyId },
        },
        select: {
          id: true,
          jobTitle: true,
          maritalStatus: true,
          militaryDocumentStatus: true,
          dependents: true,
        },
      }),
      this.prisma.documentChecklistTemplate.findFirst({
        where: {
          companyId: principal.companyId,
          code: 'employee-documents-dynamic',
          active: true,
        },
        orderBy: { version: 'desc' },
        include: {
          items: {
            where: { active: true },
            orderBy: { position: 'asc' },
            include: { documentType: true },
          },
        },
      }),
      this.prisma.documentRequest.findFirst({
        where: {
          companyId: principal.companyId,
          subjectUserId,
          status: { not: PrismaDocumentRequestStatus.CANCELLED },
        },
        orderBy: { createdAt: 'desc' },
        include: {
          items: {
            include: {
              documentType: true,
              submissions: { select: { id: true }, take: 1 },
            },
          },
        },
      }),
    ]);
    if (!subject) throw notFound('Usuário');
    if (!checklist) throw notFound('Checklist documental dinâmico');
    if (!request) {
      return this.createAdmissionRequest(principal, {
        commandId: randomUUID(),
        subjectUserId,
        checklistCode: 'employee-documents-dynamic',
      });
    }
    const dependents = Array.isArray(subject.dependents)
      ? (subject.dependents as unknown as UserDependent[])
      : [];
    const ruleContext = employeeDocumentRuleContext({
      jobTitle: subject.jobTitle,
      maritalStatus: subject.maritalStatus as MaritalStatus | null,
      militaryDocumentStatus:
        subject.militaryDocumentStatus as MilitaryDocumentStatus,
      dependents,
    });
    const applicable = checklist.items.filter((item) =>
      item.requirement === PrismaDocumentRequirement.CONDITIONAL
        ? matchesEmployeeDocumentCondition(
            jsonRecord(item.condition),
            ruleContext,
          )
        : true,
    );
    const applicableByCode = new Map(
      applicable.map((item) => [item.documentType.code, item]),
    );
    const currentByCode = new Map(
      request.items.map((item) => [item.documentType.code, item]),
    );
    await this.prisma.$transaction(async (transaction) => {
      for (const item of request.items) {
        const shouldApply = applicableByCode.has(item.documentType.code);
        const itemConfig = jsonRecord(item.configSnapshot);
        if (
          !shouldApply &&
          item.status === PrismaDocumentItemStatus.PENDING_UPLOAD &&
          item.submissions.length === 0
        ) {
          await transaction.documentRequestItem.update({
            where: {
              id_companyId: { id: item.id, companyId: principal.companyId },
            },
            data: { status: PrismaDocumentItemStatus.CANCELLED },
          });
        } else if (
          shouldApply &&
          item.status === PrismaDocumentItemStatus.CANCELLED &&
          item.submissions.length === 0
        ) {
          await transaction.documentRequestItem.update({
            where: {
              id_companyId: { id: item.id, companyId: principal.companyId },
            },
            data: { status: PrismaDocumentItemStatus.PENDING_UPLOAD },
          });
        } else if (
          shouldApply &&
          item.documentType.code === 'military-certificate' &&
          itemConfig.manualPolicy === undefined
        ) {
          await transaction.documentRequestItem.update({
            where: {
              id_companyId: { id: item.id, companyId: principal.companyId },
            },
            data: {
              requirement:
                ruleContext.militaryDocumentStatus === 'pending-confirmation'
                  ? PrismaDocumentRequirement.OPTIONAL
                  : PrismaDocumentRequirement.REQUIRED,
              configSnapshot: {
                ...itemConfig,
                personnelDecisionRequired:
                  ruleContext.militaryDocumentStatus === 'pending-confirmation',
              },
            },
          });
        }
      }
      let position = Math.max(0, ...request.items.map((item) => item.position));
      for (const item of applicable) {
        if (currentByCode.has(item.documentType.code)) continue;
        position += 1;
        await transaction.documentRequestItem.create({
          data: {
            companyId: principal.companyId,
            requestId: request.id,
            documentTypeId: item.documentTypeId,
            requirement:
              item.documentType.code === 'military-certificate' &&
              ruleContext.militaryDocumentStatus === 'pending-confirmation'
                ? PrismaDocumentRequirement.OPTIONAL
                : item.requirement === PrismaDocumentRequirement.CONDITIONAL
                  ? PrismaDocumentRequirement.REQUIRED
                  : item.requirement,
            position,
            instructions: item.instructions,
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
              ...(item.documentType.code.startsWith('child-')
                ? { dependents }
                : {}),
              ...(item.documentType.code === 'military-certificate' &&
              ruleContext.militaryDocumentStatus === 'pending-confirmation'
                ? {
                    personnelDecisionRequired: true,
                    instructions:
                      'Departamento Pessoal deve confirmar se o documento militar é aplicável.',
                  }
                : {}),
              ...(item.documentType.code === 'cnh' && ruleContext.isDriver
                ? {
                    driverRequirements: {
                      category: 'D',
                      earRequired: true,
                      validityRequired: true,
                    },
                  }
                : {}),
              ...jsonRecord(item.configOverrides),
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }
      const allItems = await transaction.documentRequestItem.findMany({
        where: { companyId: principal.companyId, requestId: request.id },
        select: { status: true, requirement: true },
      });
      await transaction.documentRequest.update({
        where: {
          id_companyId: { id: request.id, companyId: principal.companyId },
        },
        data: {
          status: requestStatusForItems(allItems),
          version: { increment: 1 },
        },
      });
      await transaction.tenantAuditLog.create({
        data: {
          companyId: principal.companyId,
          actorUserId: principal.id,
          action: 'document.request.synchronize-profile',
          targetType: 'document-request',
          targetId: request.id,
          metadata: {
            subjectUserId,
            ruleContext,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });
    return { request: await this.getRequestById(principal, request.id) };
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
            (item) =>
              item.status === PrismaDocumentItemStatus.APPROVED ||
              item.status === PrismaDocumentItemStatus.WAIVED,
          ).length,
          pending: row.items.filter(
            (item) =>
              item.status !== PrismaDocumentItemStatus.APPROVED &&
              item.status !== PrismaDocumentItemStatus.WAIVED,
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

  async addRequestItem(
    principal: AuthenticatedPrincipal,
    requestId: string,
    input: {
      documentTypeId: string;
      requirement: 'required' | 'optional';
      instructions?: string;
      dueAt?: string;
      reason: string;
    },
  ) {
    assertManage(principal);
    const [request, documentType, duplicate] = await Promise.all([
      this.prisma.documentRequest.findUnique({
        where: {
          id_companyId: { id: requestId, companyId: principal.companyId },
        },
        select: { id: true },
      }),
      this.prisma.documentType.findUnique({
        where: {
          id_companyId: {
            id: input.documentTypeId,
            companyId: principal.companyId,
          },
        },
      }),
      this.prisma.documentRequestItem.findFirst({
        where: {
          companyId: principal.companyId,
          requestId,
          documentTypeId: input.documentTypeId,
        },
        select: { id: true },
      }),
    ]);
    if (!request) throw notFound('Solicitação documental');
    if (!documentType || !documentType.active)
      throw notFound('Tipo documental ativo');
    if (duplicate) {
      throw conflict(
        'Este tipo documental já existe na solicitação. Altere a exigência do item existente.',
      );
    }
    await this.prisma.$transaction(async (transaction) => {
      const last = await transaction.documentRequestItem.aggregate({
        where: { companyId: principal.companyId, requestId },
        _max: { position: true },
      });
      const item = await transaction.documentRequestItem.create({
        data: {
          companyId: principal.companyId,
          requestId,
          documentTypeId: documentType.id,
          requirement: requirementsToPrisma[input.requirement],
          position: (last._max.position ?? 0) + 1,
          instructions: input.instructions?.trim() || null,
          dueAt: input.dueAt ? new Date(input.dueAt) : null,
          configSnapshot: {
            code: documentType.code,
            name: documentType.name,
            acceptedMimeTypes: documentType.acceptedMimeTypes,
            maxFileSizeBytes: documentType.maxFileSizeBytes,
            minFiles: documentType.minFiles,
            maxFiles: documentType.maxFiles,
            allowsMultiplePages: documentType.allowsMultiplePages,
            requiresFrontBack: documentType.requiresFrontBack,
            expires: documentType.expires,
            defaultValidityDays: documentType.defaultValidityDays,
            renewalLeadDays: documentType.renewalLeadDays,
            requiresOriginal: documentType.requiresOriginal,
            extractionSchema: documentType.extractionSchema,
            manuallyAdded: true,
          },
        },
      });
      await transaction.documentStatusHistory.create({
        data: {
          companyId: principal.companyId,
          requestId,
          requestItemId: item.id,
          actorUserId: principal.id,
          action: 'item.manually-added',
          toStatus: 'pending-upload',
          reason: input.reason.trim(),
          metadata: { requirement: input.requirement },
        },
      });
      const items = await transaction.documentRequestItem.findMany({
        where: { companyId: principal.companyId, requestId },
        select: { status: true, requirement: true },
      });
      await transaction.documentRequest.update({
        where: {
          id_companyId: { id: requestId, companyId: principal.companyId },
        },
        data: {
          status: requestStatusForItems(items),
          version: { increment: 1 },
        },
      });
    });
    return { request: await this.getRequestById(principal, requestId) };
  }

  async setRequestItemPolicy(
    principal: AuthenticatedPrincipal,
    requestItemId: string,
    input: {
      policy: 'required' | 'optional' | 'waived';
      reason: string;
    },
  ) {
    assertManage(principal);
    const item = await this.prisma.documentRequestItem.findUnique({
      where: {
        id_companyId: { id: requestItemId, companyId: principal.companyId },
      },
      select: {
        id: true,
        requestId: true,
        status: true,
        requirement: true,
        configSnapshot: true,
      },
    });
    if (!item) throw notFound('Item documental');
    const status =
      input.policy === 'waived'
        ? PrismaDocumentItemStatus.WAIVED
        : item.status === PrismaDocumentItemStatus.WAIVED ||
            item.status === PrismaDocumentItemStatus.CANCELLED
          ? PrismaDocumentItemStatus.PENDING_UPLOAD
          : item.status;
    const requirement =
      input.policy === 'required'
        ? PrismaDocumentRequirement.REQUIRED
        : PrismaDocumentRequirement.OPTIONAL;
    await this.prisma.$transaction(async (transaction) => {
      await transaction.documentRequestItem.update({
        where: {
          id_companyId: { id: item.id, companyId: principal.companyId },
        },
        data: {
          status,
          requirement,
          configSnapshot: {
            ...jsonRecord(item.configSnapshot),
            manualPolicy: input.policy,
          },
        },
      });
      await transaction.documentStatusHistory.create({
        data: {
          companyId: principal.companyId,
          requestId: item.requestId,
          requestItemId: item.id,
          actorUserId: principal.id,
          action: 'item.policy-changed',
          fromStatus: itemStatusFromPrisma[item.status],
          toStatus: itemStatusFromPrisma[status],
          reason: input.reason.trim(),
          metadata: {
            fromRequirement: requirementsFromPrisma[item.requirement],
            policy: input.policy,
          },
        },
      });
      const items = await transaction.documentRequestItem.findMany({
        where: { companyId: principal.companyId, requestId: item.requestId },
        select: { status: true, requirement: true },
      });
      await transaction.documentRequest.update({
        where: {
          id_companyId: {
            id: item.requestId,
            companyId: principal.companyId,
          },
        },
        data: {
          status: requestStatusForItems(items),
          version: { increment: 1 },
        },
      });
    });
    return { request: await this.getRequestById(principal, item.requestId) };
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
        'pending-human-review',
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
      if (currentStatus === 'pending-human-review') {
        await transaction.documentSubmission.updateMany({
          where: {
            companyId: principal.companyId,
            requestItemId: item.id,
            version: item.currentVersion,
            status: PrismaDocumentItemStatus.PENDING_HUMAN_REVIEW,
          },
          data: { status: PrismaDocumentItemStatus.CANCELLED },
        });
      }
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
    const extractionSchema = jsonRecord(config.extractionSchema);
    const extractionFields = Array.isArray(extractionSchema.fields)
      ? extractionSchema.fields.flatMap((field) => {
          const record = jsonRecord(field);
          return typeof record.key === 'string' &&
            typeof record.label === 'string'
            ? [
                {
                  key: record.key,
                  label: record.label,
                  type:
                    typeof record.type === 'string' ? record.type : undefined,
                  multiple: record.multiple === true,
                },
              ]
            : [];
        })
      : [];
    const local = localStructuralValidation({
      files: submission.files.map((file) => ({
        side: sidesFromPrisma[file.side],
        pageNumber: file.pageNumber,
        mimeType: file.mimeType,
      })),
      policy,
      documentTypeCode: submission.requestItem.documentType.code,
    });
    const result: DocumentReviewResult = this.reviewAgent
      ? await this.reviewAgent.review({
          files: submission.files.map((file) => ({
            fileName: file.fileName,
            mimeType: file.mimeType,
            content: Buffer.from(file.content),
            side: sidesFromPrisma[file.side],
            pageNumber: file.pageNumber,
          })),
          expectedDocumentTypeCode: submission.requestItem.documentType.code,
          extractionFields,
          rules: config,
          context: {
            requestContext: contextFromPrisma(
              submission.requestItem.request.context,
            ),
          },
          profileVersion: 1,
          safetyIdentifier: createHash('sha256')
            .update(
              `${principal.companyId}:${submission.requestItem.request.subjectUserId}`,
            )
            .digest('hex'),
        })
      : {
          classification: {
            expectedType: submission.requestItem.documentType.code,
            detectedType: submission.requestItem.documentType.code,
            confidence: 0,
          },
          quality: {
            legible: false,
            complete: local.alerts.length === 0,
            issues: local.alerts,
          },
          fields: [],
          alerts: local.alerts,
          requiresHumanReview: true,
          summary: local.summary,
          provider: local.provider,
          modelVersion: local.modelVersion,
          attempt: 1,
        };
    const extractedAt = new Date().toISOString();
    const extractedFields = Object.fromEntries(
      result.fields.map((field) => [
        field.key,
        {
          value: field.normalizedValue,
          rawValue: field.rawValue,
          confidence: field.confidence,
          sourceFile: field.sourceFile,
          page: field.page,
          extractedAt,
          validationStatus: 'pending-human-review',
          profileVersion: 1,
        },
      ]),
    );

    const validation = await this.prisma.$transaction(async (transaction) => {
      await transaction.documentSubmission.update({
        where: {
          id_companyId: { id: submission.id, companyId: principal.companyId },
        },
        data: {
          status: PrismaDocumentItemStatus.PENDING_HUMAN_REVIEW,
          extractedData: extractedFields,
        },
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
          suggestedDocumentTypeCode: result.classification.detectedType,
          result: {
            classification: result.classification,
            quality: result.quality,
            requiresHumanReview: true,
          },
          alerts: result.alerts,
          extractedFields,
          overallConfidence: result.classification.confidence,
          summary: result.summary,
          provider: result.provider,
          modelVersion: result.modelVersion,
          attempt: result.attempt,
          startedAt: new Date(),
          completedAt: new Date(),
        },
        update: {
          status: DocumentValidationStatus.COMPLETED,
          alerts: result.alerts,
          result: {
            classification: result.classification,
            quality: result.quality,
            requiresHumanReview: true,
          },
          extractedFields,
          overallConfidence: result.classification.confidence,
          summary: result.summary,
          provider: result.provider,
          modelVersion: result.modelVersion,
          attempt: result.attempt,
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

  async deleteSubmission(
    principal: AuthenticatedPrincipal,
    submissionId: string,
    input: { reason?: string },
  ) {
    const submission = await this.prisma.documentSubmission.findUnique({
      where: {
        id_companyId: { id: submissionId, companyId: principal.companyId },
      },
      include: {
        files: { where: { deletedAt: null }, select: { id: true } },
        requestItem: { include: { request: true } },
      },
    });
    if (!submission) throw notFound('Envio documental');
    this.assertOwnOrManage(
      principal,
      submission.requestItem.request.subjectUserId,
    );
    if (submission.version !== submission.requestItem.currentVersion) {
      throw conflict('Somente o envio atual pode ser removido.');
    }
    const canManage =
      hasPeopleOperationsScope(principal) &&
      (principal.isAdministrator ||
        principal.permissions.includes('documents:manage'));
    const current = itemStatusFromPrisma[submission.status];
    if (current === 'approved' && !canManage) {
      throw forbidden(
        'Documento aprovado só pode ser removido por quem gerencia documentos.',
      );
    }
    if (current === 'approved' && !input.reason?.trim()) {
      throw validationError(
        'Informe o motivo para remover um documento aprovado.',
      );
    }
    if (['cancelled', 'waived'].includes(current)) {
      throw conflict('Este envio já foi removido ou dispensado.');
    }

    await this.prisma.$transaction(async (transaction) => {
      const deletedAt = new Date();
      await transaction.documentFile.updateMany({
        where: {
          companyId: principal.companyId,
          submissionId: submission.id,
          deletedAt: null,
        },
        data: { deletedAt },
      });
      await transaction.documentSubmission.update({
        where: {
          id_companyId: { id: submission.id, companyId: principal.companyId },
        },
        data: { status: PrismaDocumentItemStatus.CANCELLED },
      });
      await transaction.documentRequestItem.update({
        where: {
          id_companyId: {
            id: submission.requestItemId,
            companyId: principal.companyId,
          },
        },
        data: {
          status: PrismaDocumentItemStatus.PENDING_UPLOAD,
          validUntil: null,
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
          completedAt: null,
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
          action: 'submission.removed',
          fromStatus: current,
          toStatus: 'pending-upload',
          reason: input.reason?.trim() || 'Arquivo substituído pelo titular.',
          metadata: {
            version: submission.version,
            fileIds: submission.files.map((file) => file.id),
          },
        },
      });
      await transaction.tenantAuditLog.create({
        data: {
          companyId: principal.companyId,
          actorUserId: principal.id,
          action: 'document.submission.remove',
          targetType: 'document-submission',
          targetId: submission.id,
          metadata: {
            requestId: submission.requestItem.requestId,
            previousStatus: current,
            approvedRemoval: current === 'approved',
            reason: input.reason?.trim() || null,
          },
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
    if (!subjectUserId) {
      throw validationError(
        'A exportação documental deve ser realizada individualmente por funcionário.',
      );
    }
    const subject = await this.prisma.user.findUnique({
      where: {
        id_companyId: { id: subjectUserId, companyId: principal.companyId },
      },
      select: {
        id: true,
        name: true,
        email: true,
        cpfNormalized: true,
        jobTitle: true,
        maritalStatus: true,
        militaryDocumentStatus: true,
        dependents: true,
      },
    });
    if (!subject) throw notFound('Usuário titular');
    const submissions = await this.prisma.documentSubmission.findMany({
      where: {
        companyId: principal.companyId,
        requestItem: { request: { subjectUserId } },
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
    const [items, history] = await Promise.all([
      this.prisma.documentRequestItem.findMany({
        where: { companyId: principal.companyId, request: { subjectUserId } },
        include: {
          documentType: { select: { code: true, name: true } },
          submissions: { orderBy: { version: 'desc' }, take: 1 },
        },
        orderBy: [{ request: { createdAt: 'desc' } }, { position: 'asc' }],
      }),
      this.prisma.documentStatusHistory.findMany({
        where: {
          companyId: principal.companyId,
          request: { subjectUserId },
        },
        include: { actor: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const workbook = new ExcelJS.Workbook();
    const employee = workbook.addWorksheet('Dados do funcionário');
    employee.columns = [
      { header: 'Campo', key: 'field', width: 36 },
      { header: 'Valor validado', key: 'value', width: 60 },
      { header: 'Documento de origem', key: 'source', width: 42 },
    ];
    for (const row of [
      { field: 'Nome', value: subject.name, source: 'Cadastro' },
      { field: 'E-mail', value: subject.email, source: 'Cadastro' },
      { field: 'CPF', value: subject.cpfNormalized ?? '', source: 'Cadastro' },
      {
        field: 'Cargo ou função',
        value: subject.jobTitle ?? '',
        source: 'Cadastro',
      },
      {
        field: 'Situação civil',
        value: subject.maritalStatus ?? 'não informada',
        source: 'Cadastro',
      },
      {
        field: 'Documentação militar',
        value: subject.militaryDocumentStatus,
        source: 'Cadastro',
      },
    ]) {
      employee.addRow(row);
    }
    const documents = workbook.addWorksheet('Documentos');
    documents.columns = [
      { header: 'Código', key: 'code', width: 28 },
      { header: 'Documento', key: 'name', width: 42 },
      { header: 'Status', key: 'status', width: 24 },
      { header: 'Obrigatoriedade', key: 'requirement', width: 20 },
      { header: 'Validade', key: 'validUntil', width: 22 },
      { header: 'Versão atual', key: 'version', width: 14 },
      { header: 'Solicitação', key: 'requestId', width: 38 },
    ];
    for (const item of items) {
      documents.addRow({
        code: item.documentType.code,
        name: item.documentType.name,
        status: itemStatusFromPrisma[item.status],
        requirement: requirementsFromPrisma[item.requirement],
        validUntil: item.validUntil?.toISOString() ?? '',
        version: item.submissions[0]?.version ?? 0,
        requestId: item.requestId,
      });
    }
    const dependentSheet = workbook.addWorksheet('Dependentes');
    dependentSheet.columns = [
      { header: 'Nome', key: 'name', width: 38 },
      { header: 'Data de nascimento', key: 'birthDate', width: 22 },
      { header: 'Vínculo', key: 'relationship', width: 24 },
    ];
    const dependents = Array.isArray(subject.dependents)
      ? (subject.dependents as Array<Record<string, unknown>>)
      : [];
    for (const dependent of dependents) {
      dependentSheet.addRow({
        name: spreadsheetValue(dependent.name),
        birthDate: spreadsheetValue(dependent.birthDate),
        relationship: spreadsheetValue(dependent.relationship),
      });
    }
    const historySheet = workbook.addWorksheet('Histórico');
    historySheet.columns = [
      { header: 'Data', key: 'date', width: 24 },
      { header: 'Ação', key: 'action', width: 34 },
      { header: 'Status anterior', key: 'from', width: 24 },
      { header: 'Novo status', key: 'to', width: 24 },
      { header: 'Motivo', key: 'reason', width: 48 },
      { header: 'Responsável', key: 'actor', width: 32 },
      { header: 'Solicitação', key: 'requestId', width: 38 },
    ];
    for (const entry of history) {
      historySheet.addRow({
        date: entry.createdAt.toISOString(),
        action: entry.action,
        from: entry.fromStatus ?? '',
        to: entry.toStatus,
        reason: entry.reason ?? '',
        actor: entry.actor?.name ?? 'Sistema',
        requestId: entry.requestId ?? '',
      });
    }
    for (const submission of submissions) {
      const confirmed = jsonRecord(submission.confirmedData);
      for (const field of Object.keys(confirmed)) {
        const confirmedRecord = jsonRecord(confirmed[field]);
        employee.addRow({
          field,
          value: spreadsheetValue(confirmedRecord.value ?? confirmed[field]),
          source: `${submission.requestItem.documentType.name} · v${submission.version}`,
        });
      }
    }
    for (const sheet of workbook.worksheets) {
      sheet.getRow(1).font = { bold: true };
      sheet.autoFilter = {
        from: 'A1',
        to: `${String.fromCharCode(64 + sheet.columnCount)}1`,
      };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
    }
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

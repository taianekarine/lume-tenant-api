import {
  INITIAL_DOCUMENT_CHECKLISTS,
  INITIAL_DOCUMENT_TYPES,
} from '../../domain/documents/initial-document-catalog';
import {
  DocumentRequestContext,
  DocumentRequirement,
  type Prisma,
} from '../database/prisma/generated/client';

const contexts = {
  admission: DocumentRequestContext.ADMISSION,
  'document-update': DocumentRequestContext.DOCUMENT_UPDATE,
  'document-renewal': DocumentRequestContext.DOCUMENT_RENEWAL,
  regularization: DocumentRequestContext.REGULARIZATION,
  offboarding: DocumentRequestContext.OFFBOARDING,
  other: DocumentRequestContext.OTHER,
} as const;

const requirements = {
  required: DocumentRequirement.REQUIRED,
  optional: DocumentRequirement.OPTIONAL,
  conditional: DocumentRequirement.CONDITIONAL,
} as const;

export async function seedInitialDocumentCatalog(
  transaction: Prisma.TransactionClient,
  companyId: string,
  actorUserId: string,
): Promise<void> {
  const typeIds = new Map<string, string>();

  for (const definition of INITIAL_DOCUMENT_TYPES) {
    const documentType = await transaction.documentType.upsert({
      where: { companyId_code: { companyId, code: definition.code } },
      create: {
        companyId,
        code: definition.code,
        name: definition.name,
        expires: definition.expires ?? false,
        renewalLeadDays: definition.renewalLeadDays,
        requiresFrontBack: definition.requiresFrontBack ?? false,
        allowsMultiplePages: definition.allowsMultiplePages ?? false,
        maxFiles: definition.maxFiles ?? (definition.requiresFrontBack ? 2 : 1),
        extractionSchema: {
          fields: definition.extractionFields ?? [],
        },
      },
      update: {},
      select: { id: true },
    });
    typeIds.set(definition.code, documentType.id);
  }

  for (const definition of INITIAL_DOCUMENT_CHECKLISTS) {
    const checklist = await transaction.documentChecklistTemplate.upsert({
      where: {
        companyId_code_version: {
          companyId,
          code: definition.code,
          version: 1,
        },
      },
      create: {
        companyId,
        code: definition.code,
        name: definition.name,
        context: contexts[definition.context],
        version: 1,
        createdByUserId: actorUserId,
      },
      update: {},
      select: { id: true },
    });

    for (const [index, item] of definition.items.entries()) {
      const documentTypeId = typeIds.get(item.documentTypeCode);
      if (!documentTypeId) continue;
      await transaction.documentChecklistItem.upsert({
        where: {
          companyId_checklistId_documentTypeId: {
            companyId,
            checklistId: checklist.id,
            documentTypeId,
          },
        },
        create: {
          companyId,
          checklistId: checklist.id,
          documentTypeId,
          requirement: requirements[item.requirement ?? 'required'],
          position: index + 1,
          instructions: item.instructions,
          condition: (item.condition ?? {}) as Prisma.InputJsonValue,
          configOverrides: definition.requiresOriginals
            ? { requiresOriginal: true }
            : {},
        },
        update: {},
      });
    }
  }
}

import { Injectable } from '@nestjs/common';

import {
  DataExchangeRepository,
  type DataExchangeArtifact,
  type DataExchangeArtifactContent,
  type StoreDataExchangeArtifactInput,
  type StoredDataExchangeArtifact,
} from '../../../application/contracts/data-exchange.repository';
import { AppError, forbidden, notFound } from '../../../core/errors/app-error';
import type { DataExchangeFormat } from '../../../domain/data-exchange/data-exchange-capabilities';
import {
  DataExchangeArtifactKind,
  type Prisma,
} from '../prisma/generated/client';
import { PrismaService } from '../prisma/prisma.service';

function isPrismaUniqueError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

function metadata(value: Prisma.JsonValue): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function present(row: {
  id: string;
  companyId: string;
  uploadedByUserId: string;
  sourceArtifactId: string | null;
  kind: DataExchangeArtifactKind;
  commandId: string;
  fileName: string;
  mimeType: string;
  extension: string;
  format: string;
  sizeBytes: number;
  sha256: string;
  metadata: Prisma.JsonValue;
  createdAt: Date;
  expiresAt: Date;
}): DataExchangeArtifact {
  return {
    id: row.id,
    companyId: row.companyId,
    uploadedByUserId: row.uploadedByUserId,
    sourceArtifactId: row.sourceArtifactId,
    kind:
      row.kind === DataExchangeArtifactKind.UPLOAD ? 'upload' : 'conversion',
    commandId: row.commandId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    extension: row.extension,
    format: row.format as DataExchangeFormat,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    metadata: metadata(row.metadata),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

@Injectable()
export class PrismaDataExchangeRepository extends DataExchangeRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async store(
    input: StoreDataExchangeArtifactInput,
  ): Promise<StoredDataExchangeArtifact> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${`${input.companyId}:data-exchange:${input.commandId}`})
          )
        `;
        const duplicate = await transaction.dataExchangeArtifact.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.companyId,
              commandId: input.commandId,
            },
          },
        });
        if (duplicate) {
          if (duplicate.expiresAt <= new Date()) {
            throw new AppError(
              'CONFLICT',
              'O commandId pertence a uma operação expirada. Gere um novo commandId.',
            );
          }
          if (duplicate.requestFingerprint !== input.requestFingerprint) {
            throw new AppError(
              'CONFLICT',
              'commandId já foi usado para outro arquivo ou conversão.',
            );
          }
          return { artifact: present(duplicate), idempotent: true };
        }

        const actor = await transaction.user.findUnique({
          where: {
            id_companyId: {
              id: input.actorUserId,
              companyId: input.companyId,
            },
          },
          select: { id: true, isActive: true },
        });
        if (!actor?.isActive) {
          throw forbidden('O usuário não pertence ao tenant ou está inativo.');
        }

        if (input.sourceArtifactId) {
          const source = await transaction.dataExchangeArtifact.findUnique({
            where: {
              id_companyId: {
                id: input.sourceArtifactId,
                companyId: input.companyId,
              },
            },
            select: { id: true, expiresAt: true },
          });
          if (!source || source.expiresAt <= new Date()) {
            throw notFound('Arquivo temporário de origem');
          }
        }

        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${`${input.companyId}:data-exchange:quota`})
          )
        `;
        const usage = await transaction.dataExchangeArtifact.aggregate({
          where: {
            companyId: input.companyId,
            expiresAt: { gt: new Date() },
          },
          _sum: { sizeBytes: true },
        });
        const currentBytes = usage._sum.sizeBytes ?? 0;
        if (currentBytes + input.sizeBytes > input.maximumTenantBytes) {
          throw new AppError(
            'VALIDATION_ERROR',
            'A cota temporária de arquivos deste tenant foi atingida. Remova ou aguarde a expiração de arquivos antes de tentar novamente.',
            {
              currentBytes,
              incomingBytes: input.sizeBytes,
              maximumTenantBytes: input.maximumTenantBytes,
            },
          );
        }

        const artifact = await transaction.dataExchangeArtifact.create({
          data: {
            companyId: input.companyId,
            uploadedByUserId: input.actorUserId,
            sourceArtifactId: input.sourceArtifactId ?? null,
            kind:
              input.kind === 'upload'
                ? DataExchangeArtifactKind.UPLOAD
                : DataExchangeArtifactKind.CONVERSION,
            commandId: input.commandId,
            requestFingerprint: input.requestFingerprint,
            fileName: input.fileName,
            mimeType: input.mimeType,
            extension: input.extension,
            format: input.format,
            sizeBytes: input.sizeBytes,
            sha256: input.sha256,
            content: Uint8Array.from(input.content),
            metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
            expiresAt: input.expiresAt,
          },
        });
        await transaction.tenantAuditLog.create({
          data: {
            companyId: input.companyId,
            actorUserId: input.actorUserId,
            action:
              input.kind === 'upload'
                ? 'data-exchange.artifact.upload'
                : 'data-exchange.artifact.convert',
            targetType: 'data-exchange-artifact',
            targetId: artifact.id,
            metadata: {
              sourceArtifactId: input.sourceArtifactId ?? null,
              fileName: artifact.fileName,
              mimeType: artifact.mimeType,
              format: artifact.format,
              sizeBytes: artifact.sizeBytes,
              sha256: artifact.sha256,
              expiresAt: artifact.expiresAt.toISOString(),
            },
          },
        });
        return { artifact: present(artifact), idempotent: false };
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        const duplicate = await this.prisma.dataExchangeArtifact.findUnique({
          where: {
            companyId_commandId: {
              companyId: input.companyId,
              commandId: input.commandId,
            },
          },
        });
        if (duplicate?.requestFingerprint === input.requestFingerprint) {
          return { artifact: present(duplicate), idempotent: true };
        }
      }
      throw error;
    }
  }

  async find(
    companyId: string,
    artifactId: string,
  ): Promise<DataExchangeArtifact | null> {
    const row = await this.prisma.dataExchangeArtifact.findFirst({
      where: {
        id: artifactId,
        companyId,
        expiresAt: { gt: new Date() },
      },
    });
    return row ? present(row) : null;
  }

  async findContent(
    companyId: string,
    artifactId: string,
  ): Promise<DataExchangeArtifactContent | null> {
    const row = await this.prisma.dataExchangeArtifact.findFirst({
      where: {
        id: artifactId,
        companyId,
        expiresAt: { gt: new Date() },
      },
    });
    return row
      ? {
          ...present(row),
          content: Buffer.from(row.content),
        }
      : null;
  }
}

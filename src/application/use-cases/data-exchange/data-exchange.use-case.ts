import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  DataExchangeRepository,
  type StoreDataExchangeArtifactInput,
} from '../../contracts/data-exchange.repository';
import { notFound, validationError } from '../../../core/errors/app-error';
import {
  dataExchangeCapabilities,
  type DataExchangeFileInput,
  type DataExchangeFormat,
  validateDataExchangeFile,
} from '../../../domain/data-exchange/data-exchange-capabilities';
import { DataExchangeConverter } from '../../../infra/data-exchange/data-exchange-converter';

export interface UploadDataExchangeArtifactInput extends DataExchangeFileInput {
  companyId: string;
  actorUserId: string;
  commandId: string;
  purpose?: string | null;
}

export interface ConvertDataExchangeArtifactInput {
  companyId: string;
  actorUserId: string;
  artifactId: string;
  commandId: string;
  targetFormat: DataExchangeFormat;
  sheetName?: string | null;
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function replaceExtension(fileName: string, extension: string): string {
  const base = fileName.replace(/\.[^.]+$/, '').slice(0, 230) || 'arquivo';
  return `${base}.${extension}`;
}

@Injectable()
export class DataExchangeUseCase {
  private readonly maximumBytes: number;
  private readonly maximumTenantBytes: number;
  private readonly retentionDays: number;

  constructor(
    private readonly repository: DataExchangeRepository,
    private readonly converter: DataExchangeConverter,
    config: ConfigService,
  ) {
    this.maximumBytes =
      config.get<number>('DATA_EXCHANGE_MAX_FILE_BYTES') ?? 25 * 1024 * 1024;
    this.maximumTenantBytes =
      config.get<number>('DATA_EXCHANGE_MAX_TENANT_BYTES') ?? 250 * 1024 * 1024;
    this.retentionDays =
      config.get<number>('DATA_EXCHANGE_RETENTION_DAYS') ?? 30;
  }

  capabilities() {
    return dataExchangeCapabilities(this.maximumBytes);
  }

  async upload(input: UploadDataExchangeArtifactInput) {
    const validated = validateDataExchangeFile(input, this.maximumBytes);
    await this.converter.validate(validated.format, input.content);
    const requestFingerprint = fingerprint({
      operation: 'upload',
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      commandId: input.commandId,
      purpose: input.purpose?.trim() || null,
      fileName: validated.fileName,
      mimeType: validated.mimeType,
      sizeBytes: validated.sizeBytes,
      sha256: validated.sha256,
      format: validated.format,
    });
    return this.repository.store({
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      kind: 'upload',
      commandId: input.commandId,
      requestFingerprint,
      ...validated,
      content: Buffer.from(input.content),
      metadata: { purpose: input.purpose?.trim() || null },
      expiresAt: this.expiresAt(),
      maximumTenantBytes: this.maximumTenantBytes,
    });
  }

  async get(companyId: string, artifactId: string) {
    const artifact = await this.repository.find(companyId, artifactId);
    if (!artifact) throw notFound('Arquivo temporário');
    return { artifact };
  }

  async getContent(companyId: string, artifactId: string) {
    const artifact = await this.repository.findContent(companyId, artifactId);
    if (!artifact) throw notFound('Arquivo temporário');
    return artifact;
  }

  async convert(input: ConvertDataExchangeArtifactInput) {
    const source = await this.repository.findContent(
      input.companyId,
      input.artifactId,
    );
    if (!source) throw notFound('Arquivo temporário');

    if (source.sourceArtifactId) {
      throw validationError(
        'Use o arquivo originalmente enviado como origem; conversões encadeadas não são permitidas.',
      );
    }

    const converted = await this.converter.convert(
      source.format,
      input.targetFormat,
      source.content,
      { sheetName: input.sheetName },
    );
    const validated = validateDataExchangeFile(
      {
        originalName: replaceExtension(source.fileName, converted.extension),
        mimeType: converted.mimeType,
        sizeBytes: converted.content.byteLength,
        content: converted.content,
      },
      this.maximumBytes,
    );
    const requestFingerprint = fingerprint({
      operation: 'conversion',
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      artifactId: source.id,
      sourceSha256: source.sha256,
      commandId: input.commandId,
      targetFormat: input.targetFormat,
      sheetName: input.sheetName?.trim() || null,
    });
    const storeInput: StoreDataExchangeArtifactInput = {
      companyId: input.companyId,
      actorUserId: input.actorUserId,
      sourceArtifactId: source.id,
      kind: 'conversion',
      commandId: input.commandId,
      requestFingerprint,
      ...validated,
      content: converted.content,
      metadata: {
        sourceArtifactId: source.id,
        sourceFormat: source.format,
        targetFormat: converted.format,
      },
      expiresAt: this.expiresAt(),
      maximumTenantBytes: this.maximumTenantBytes,
    };
    return this.repository.store(storeInput);
  }

  private expiresAt(): Date {
    return new Date(Date.now() + this.retentionDays * 86_400_000);
  }
}

import { ConfigService } from '@nestjs/config';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import {
  DataExchangeRepository,
  type DataExchangeArtifact,
  type DataExchangeArtifactContent,
  type StoreDataExchangeArtifactInput,
} from '../../contracts/data-exchange.repository';
import { DataExchangeConverter } from '../../../infra/data-exchange/data-exchange-converter';
import { DataExchangeUseCase } from './data-exchange.use-case';

class MemoryDataExchangeRepository extends DataExchangeRepository {
  readonly items = new Map<string, DataExchangeArtifactContent>();

  async store(input: StoreDataExchangeArtifactInput) {
    const existing = Array.from(this.items.values()).find(
      (item) =>
        item.companyId === input.companyId &&
        item.commandId === input.commandId,
    );
    if (existing) return { artifact: existing, idempotent: true };
    const artifact: DataExchangeArtifactContent = {
      id: `00000000-0000-4000-8000-${String(this.items.size + 1).padStart(12, '0')}`,
      companyId: input.companyId,
      uploadedByUserId: input.actorUserId,
      sourceArtifactId: input.sourceArtifactId ?? null,
      kind: input.kind,
      commandId: input.commandId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      extension: input.extension,
      format: input.format,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
      expiresAt: input.expiresAt,
    };
    this.items.set(artifact.id, artifact);
    return { artifact, idempotent: false };
  }

  async find(
    companyId: string,
    artifactId: string,
  ): Promise<DataExchangeArtifact | null> {
    const item = this.items.get(artifactId);
    return item?.companyId === companyId ? item : null;
  }

  async findContent(
    companyId: string,
    artifactId: string,
  ): Promise<DataExchangeArtifactContent | null> {
    const item = this.items.get(artifactId);
    return item?.companyId === companyId ? item : null;
  }
}

const companyId = '00000000-0000-4000-8000-000000000001';
const actorUserId = '00000000-0000-4000-8000-000000000002';

describe('DataExchangeUseCase', () => {
  it('valida estruturalmente o upload e cria uma conversão rastreável', async () => {
    const repository = new MemoryDataExchangeRepository();
    const useCase = new DataExchangeUseCase(
      repository,
      new DataExchangeConverter(),
      new ConfigService({
        DATA_EXCHANGE_MAX_FILE_BYTES: 2 * 1024 * 1024,
        DATA_EXCHANGE_RETENTION_DAYS: 7,
      }),
    );
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Dados').addRow(['cliente', 'rota']);
    const content = Buffer.from(await workbook.xlsx.writeBuffer());

    const uploaded = await useCase.upload({
      companyId,
      actorUserId,
      commandId: '00000000-0000-4000-8000-000000000003',
      purpose: 'teste',
      originalName: 'dados.xlsx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      sizeBytes: content.byteLength,
      content,
    });
    const converted = await useCase.convert({
      companyId,
      actorUserId,
      artifactId: uploaded.artifact.id,
      commandId: '00000000-0000-4000-8000-000000000004',
      targetFormat: 'csv',
    });

    expect(uploaded.artifact).toMatchObject({
      format: 'xlsx',
      kind: 'upload',
    });
    expect(converted.artifact).toMatchObject({
      format: 'csv',
      kind: 'conversion',
      sourceArtifactId: uploaded.artifact.id,
    });
    expect(converted.artifact.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('não persiste XLSX inválido', async () => {
    const repository = new MemoryDataExchangeRepository();
    const useCase = new DataExchangeUseCase(
      repository,
      new DataExchangeConverter(),
      new ConfigService({ DATA_EXCHANGE_MAX_FILE_BYTES: 1024 }),
    );
    const content = Buffer.from('PK\u0003\u0004broken');
    await expect(
      useCase.upload({
        companyId,
        actorUserId,
        commandId: '00000000-0000-4000-8000-000000000005',
        originalName: 'dados.xlsx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: content.byteLength,
        content,
      }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE_FORMAT' });
    expect(repository.items.size).toBe(0);
  });
});

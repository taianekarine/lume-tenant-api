import type { DataExchangeFormat } from '../../domain/data-exchange/data-exchange-capabilities';

export type DataExchangeArtifactKind = 'upload' | 'conversion';

export interface DataExchangeArtifact {
  id: string;
  companyId: string;
  uploadedByUserId: string;
  sourceArtifactId: string | null;
  kind: DataExchangeArtifactKind;
  commandId: string;
  fileName: string;
  mimeType: string;
  extension: string;
  format: DataExchangeFormat;
  sizeBytes: number;
  sha256: string;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: Date;
  expiresAt: Date;
}

export interface DataExchangeArtifactContent extends DataExchangeArtifact {
  content: Buffer;
}

export interface StoreDataExchangeArtifactInput {
  companyId: string;
  actorUserId: string;
  sourceArtifactId?: string | null;
  kind: DataExchangeArtifactKind;
  commandId: string;
  requestFingerprint: string;
  fileName: string;
  mimeType: string;
  extension: string;
  format: DataExchangeFormat;
  sizeBytes: number;
  sha256: string;
  content: Buffer;
  metadata?: Readonly<Record<string, unknown>>;
  expiresAt: Date;
  maximumTenantBytes: number;
}

export interface StoredDataExchangeArtifact {
  artifact: DataExchangeArtifact;
  idempotent: boolean;
}

export abstract class DataExchangeRepository {
  abstract store(
    input: StoreDataExchangeArtifactInput,
  ): Promise<StoredDataExchangeArtifact>;
  abstract find(
    companyId: string,
    artifactId: string,
  ): Promise<DataExchangeArtifact | null>;
  abstract findContent(
    companyId: string,
    artifactId: string,
  ): Promise<DataExchangeArtifactContent | null>;
}

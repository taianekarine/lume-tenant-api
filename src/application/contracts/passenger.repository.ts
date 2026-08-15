import type {
  PassengerData,
  PassengerDocumentInput,
  PassengerIssueInput,
  PassengerProps,
  PassengerRegistrationStatus,
  PassengerStatus,
  RoutingDataOrigin,
} from '../../domain/routing/passenger';

export interface PassengerDocumentRecord extends PassengerDocumentInput {
  id: string;
  origin: RoutingDataOrigin;
  createdAt: Date;
  updatedAt: Date;
}

export interface PassengerIssueRecord extends PassengerIssueInput {
  id: string;
  status: 'open' | 'resolved';
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PassengerAggregate {
  passenger: PassengerProps;
  documents: PassengerDocumentRecord[];
  issues: PassengerIssueRecord[];
}

export interface PassengerListQuery {
  page: number;
  pageSize: number;
  routingCompanyId?: string;
  search?: string;
  status?: PassengerStatus;
  registrationStatus?: PassengerRegistrationStatus;
}

export interface PassengerListResult {
  items: PassengerAggregate[];
  total: number;
}

export interface PassengerHistoryRecord {
  id: string;
  passengerId: string;
  actorUserId: string | null;
  commandId: string;
  action: string;
  beforeSnapshot: Readonly<Record<string, unknown>> | null;
  afterSnapshot: Readonly<Record<string, unknown>>;
  reason: string | null;
  createdAt: Date;
}

export interface PassengerImportProblem {
  field: string;
  reason: string;
  resolutionAction: string;
}

export type PassengerImportAction =
  'created' | 'updated' | 'kept' | 'conflict' | 'pending';

export interface PassengerImportBatchRecord {
  id: string;
  companyId: string;
  actorUserId: string;
  commandId: string;
  routeId: string | null;
  sourceFileName: string;
  sourceSha256: string;
  status: 'processing' | 'completed' | 'review-required' | 'failed';
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  keptCount: number;
  pendingCount: number;
  conflictCount: number;
  requiresRerouting: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PassengerImportRecord {
  id: string;
  rowNumber: number;
  routingCompanyId: string | null;
  passengerId: string | null;
  action: PassengerImportAction;
  payload: Readonly<Record<string, unknown>>;
  problems: PassengerImportProblem[];
  createdAt: Date;
}

export interface PassengerImportBatchAggregate {
  batch: PassengerImportBatchRecord;
  records: PassengerImportRecord[];
}

export abstract class PassengerRepository {
  abstract create(input: {
    passenger: PassengerProps;
    documents: PassengerDocumentInput[];
    issues: PassengerIssueInput[];
    actorUserId: string;
    commandId: string;
    action?: string;
    reason?: string;
  }): Promise<PassengerAggregate>;
  abstract update(input: {
    companyId: string;
    passengerId: string;
    data: PassengerData;
    documents?: PassengerDocumentInput[];
    issues: PassengerIssueInput[];
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    action?: string;
    reason?: string;
  }): Promise<PassengerAggregate | null>;
  abstract changeStatus(input: {
    companyId: string;
    passengerId: string;
    status: PassengerStatus;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    reason?: string;
  }): Promise<PassengerAggregate | null>;
  abstract find(
    companyId: string,
    passengerId: string,
  ): Promise<PassengerAggregate | null>;
  abstract list(
    companyId: string,
    query: PassengerListQuery,
  ): Promise<PassengerListResult>;
  abstract findByExternalReference(
    companyId: string,
    routingCompanyId: string,
    externalReference: string,
  ): Promise<PassengerAggregate | null>;
  abstract findByFingerprint(
    companyId: string,
    routingCompanyId: string,
    identityFingerprint: string,
  ): Promise<PassengerAggregate[]>;
  abstract history(
    companyId: string,
    passengerId: string,
  ): Promise<PassengerHistoryRecord[]>;
  abstract beginImport(input: {
    companyId: string;
    actorUserId: string;
    commandId: string;
    routeId?: string | null;
    sourceFileName: string;
    sourceSha256: string;
  }): Promise<{ batch: PassengerImportBatchRecord; idempotent: boolean }>;
  abstract saveImportRecord(input: {
    companyId: string;
    batchId: string;
    rowNumber: number;
    routingCompanyId?: string | null;
    passengerId?: string | null;
    action: PassengerImportAction;
    payload: Readonly<Record<string, unknown>>;
    problems: PassengerImportProblem[];
  }): Promise<void>;
  abstract completeImport(input: {
    companyId: string;
    batchId: string;
    totalRows: number;
    createdCount: number;
    updatedCount: number;
    keptCount: number;
    pendingCount: number;
    conflictCount: number;
    requiresRerouting: boolean;
  }): Promise<PassengerImportBatchAggregate>;
  abstract getImport(
    companyId: string,
    batchId: string,
  ): Promise<PassengerImportBatchAggregate | null>;
}

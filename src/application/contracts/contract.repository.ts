import type {
  ContractData,
  ContractProps,
  ContractStatus,
} from '../../domain/routing/contract';

export interface ContractListQuery {
  page: number;
  pageSize: number;
  routingCompanyId?: string;
  status?: ContractStatus;
  search?: string;
}

export interface ContractListResult {
  items: ContractProps[];
  total: number;
}

export interface ContractHistoryRecord {
  id: string;
  contractId: string;
  actorUserId: string;
  commandId: string;
  action: string;
  beforeSnapshot: Readonly<Record<string, unknown>> | null;
  afterSnapshot: Readonly<Record<string, unknown>>;
  reason: string | null;
  createdAt: Date;
}

export abstract class ContractRepository {
  abstract create(input: {
    contract: ContractProps;
    actorUserId: string;
    commandId: string;
  }): Promise<ContractProps>;
  abstract list(
    companyId: string,
    query: ContractListQuery,
  ): Promise<ContractListResult>;
  abstract find(
    companyId: string,
    contractId: string,
  ): Promise<ContractProps | null>;
  abstract update(input: {
    companyId: string;
    contractId: string;
    data: ContractData;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    reason?: string;
  }): Promise<ContractProps | null>;
  abstract history(
    companyId: string,
    contractId: string,
  ): Promise<ContractHistoryRecord[]>;
}

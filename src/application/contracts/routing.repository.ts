import type {
  RoutingCompanyProps,
  RoutingCompanyStatus,
} from '../../domain/routing/routing-company';

export interface RoutingCompanyListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: RoutingCompanyStatus;
}

export interface RoutingCompanyListResult {
  items: RoutingCompanyProps[];
  total: number;
}

export interface RoutingCompanyHistoryRecord {
  id: string;
  routingCompanyId: string;
  actorUserId: string | null;
  commandId: string;
  action: string;
  beforeSnapshot: Readonly<Record<string, unknown>> | null;
  afterSnapshot: Readonly<Record<string, unknown>>;
  createdAt: Date;
}

export interface UpdateRoutingCompanyPersistenceInput {
  legalName?: string;
  tradeName?: string | null;
  costCenter?: string | null;
  status?: RoutingCompanyStatus;
  expectedVersion: number;
}

export abstract class RoutingRepository {
  abstract createCompany(
    input: RoutingCompanyProps,
    commandId: string,
  ): Promise<RoutingCompanyProps>;
  abstract listCompanies(
    companyId: string,
    query: RoutingCompanyListQuery,
  ): Promise<RoutingCompanyListResult>;
  abstract findCompany(
    companyId: string,
    routingCompanyId: string,
  ): Promise<RoutingCompanyProps | null>;
  abstract findCompanyByTaxId(
    companyId: string,
    taxId: string,
  ): Promise<RoutingCompanyProps | null>;
  abstract listCompanyHistory(
    companyId: string,
    routingCompanyId: string,
  ): Promise<RoutingCompanyHistoryRecord[]>;
  abstract updateCompany(
    companyId: string,
    routingCompanyId: string,
    input: UpdateRoutingCompanyPersistenceInput & {
      actorUserId: string;
      commandId: string;
    },
  ): Promise<RoutingCompanyProps | null>;
}

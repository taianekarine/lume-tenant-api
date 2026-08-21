import type {
  RoutingClientType,
  RoutingCompanyProps,
  RoutingCompanyStatus,
  RoutingPhone,
} from '../../domain/routing/routing-company';

export interface RoutingCompanyListQuery {
  page: number;
  pageSize: number;
  search?: string;
  status?: RoutingCompanyStatus;
  clientType?: RoutingClientType;
  sort?: 'name' | 'status' | 'avic';
}

export interface RoutingCompanyListResult {
  items: RoutingCompanyProps[];
  total: number;
}

export interface RoutingCompanyHistoryRecord {
  id: string;
  routingCompanyId: string;
  actorUserId: string | null;
  actorName: string | null;
  commandId: string;
  action: string;
  beforeSnapshot: Readonly<Record<string, unknown>> | null;
  afterSnapshot: Readonly<Record<string, unknown>>;
  createdAt: Date;
}

export interface UpdateRoutingCompanyPersistenceInput {
  taxId?: string;
  legalName?: string;
  tradeName?: string | null;
  costCenter?: string | null;
  status?: RoutingCompanyStatus;
  clientType?: RoutingClientType;
  avicExternalId?: string | null;
  individualName?: string | null;
  cpf?: string | null;
  individualEmail?: string | null;
  individualWhatsapp?: string | null;
  individualPhones?: RoutingPhone[];
  cnpj?: string | null;
  legalEmail?: string | null;
  legalWhatsapp?: string | null;
  legalPhones?: RoutingPhone[];
  expectedVersion: number;
}

export interface RoutingCompanyCommentRecord {
  id: string;
  routingCompanyId: string;
  comment: string;
  createdByUserId: string;
  updatedByUserId: string;
  authorName: string;
  createdAt: Date;
  updatedAt: Date;
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
  abstract findCompanyByUniqueValue(
    companyId: string,
    field: 'cpf' | 'cnpj' | 'avicExternalId',
    value: string,
    exceptId?: string,
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
  abstract listCompanyComments(
    companyId: string,
    routingCompanyId: string,
  ): Promise<RoutingCompanyCommentRecord[]>;
  abstract createCompanyComment(input: {
    companyId: string;
    routingCompanyId: string;
    actorUserId: string;
    commandId: string;
    comment: string;
  }): Promise<RoutingCompanyCommentRecord>;
  abstract updateCompanyComment(input: {
    companyId: string;
    routingCompanyId: string;
    commentId: string;
    actorUserId: string;
    commandId: string;
    comment: string;
  }): Promise<RoutingCompanyCommentRecord | null>;
  abstract deleteCompanyComment(input: {
    companyId: string;
    routingCompanyId: string;
    commentId: string;
    actorUserId: string;
    commandId: string;
  }): Promise<boolean>;
}

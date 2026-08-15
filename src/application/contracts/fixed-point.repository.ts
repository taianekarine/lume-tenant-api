import type {
  RoutingFixedPointProps,
  RoutingFixedPointStatus,
} from '../../domain/routing/fixed-point';

export interface FixedPointListQuery {
  page: number;
  pageSize: number;
  search?: string;
  routingCompanyId?: string;
  routeId?: string;
  status?: RoutingFixedPointStatus;
}

export abstract class FixedPointRepository {
  abstract create(
    point: RoutingFixedPointProps,
    commandId: string,
  ): Promise<RoutingFixedPointProps>;
  abstract list(
    companyId: string,
    query: FixedPointListQuery,
  ): Promise<{ items: RoutingFixedPointProps[]; total: number }>;
  abstract find(
    companyId: string,
    fixedPointId: string,
  ): Promise<RoutingFixedPointProps | null>;
  abstract findByCode(
    companyId: string,
    code: string,
  ): Promise<RoutingFixedPointProps | null>;
}

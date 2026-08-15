import type {
  RouteAggregate,
  RouteData,
  RouteNavigationLink,
  RoutePlan,
  RouteProps,
  RouteStatus,
} from '../../domain/routing/route';

export interface RouteListQuery {
  page: number;
  pageSize: number;
  routingCompanyId?: string;
  search?: string;
  status?: RouteStatus;
}

export interface RouteListResult {
  items: RouteAggregate[];
  total: number;
}

export interface RouteHistoryRecord {
  id: string;
  routeId: string;
  actorUserId: string;
  commandId: string;
  action: string;
  beforeSnapshot: Readonly<Record<string, unknown>> | null;
  afterSnapshot: Readonly<Record<string, unknown>>;
  reason: string | null;
  createdAt: Date;
}

export interface RouteVersionRecord {
  id: string;
  routeId: string;
  version: number;
  planVersion: number;
  snapshot: Readonly<Record<string, unknown>>;
  createdAt: Date;
}

export abstract class RouteRepository {
  abstract create(input: {
    route: RouteProps;
    actorUserId: string;
    commandId: string;
  }): Promise<RouteAggregate>;

  abstract list(
    companyId: string,
    query: RouteListQuery,
  ): Promise<RouteListResult>;

  abstract find(
    companyId: string,
    routeId: string,
  ): Promise<RouteAggregate | null>;

  abstract updateBase(input: {
    companyId: string;
    routeId: string;
    data: RouteData;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    reason?: string;
  }): Promise<RouteAggregate | null>;

  abstract savePlan(input: {
    companyId: string;
    routeId: string;
    plan: RoutePlan;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    action: 'ROUTE_CALCULATED' | 'ROUTE_RECALCULATED' | 'ROUTE_MANUALLY_EDITED';
    reason?: string;
  }): Promise<RouteAggregate | null>;

  abstract transition(input: {
    companyId: string;
    routeId: string;
    status: RouteStatus;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    action: string;
    reason?: string;
  }): Promise<RouteAggregate | null>;

  abstract approve(input: {
    companyId: string;
    routeId: string;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
    notes?: string;
    navigationLinks: RouteNavigationLink[];
  }): Promise<RouteAggregate | null>;

  abstract publish(input: {
    companyId: string;
    routeId: string;
    actorUserId: string;
    commandId: string;
    expectedVersion: number;
  }): Promise<RouteAggregate | null>;

  abstract history(
    companyId: string,
    routeId: string,
  ): Promise<RouteHistoryRecord[]>;

  abstract version(
    companyId: string,
    routeId: string,
    version: number,
  ): Promise<RouteVersionRecord | null>;
}

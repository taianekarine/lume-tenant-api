import {
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import {
  createRoutingFixedPoint,
  type RoutingFixedPointProps,
} from '../../../domain/routing/fixed-point';
import type { RouteAddress } from '../../../domain/routing/route';
import { FixedPointRepository } from '../../contracts/fixed-point.repository';
import type { FixedPointListQuery } from '../../contracts/fixed-point.repository';
import { RoutingRepository } from '../../contracts/routing.repository';
import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';

export function presentFixedPoint(point: RoutingFixedPointProps) {
  return {
    ...point,
    createdAt: point.createdAt.toISOString(),
    updatedAt: point.updatedAt.toISOString(),
  };
}

export class FixedPointsUseCase {
  constructor(
    private readonly points: FixedPointRepository,
    private readonly companies: RoutingRepository,
  ) {}

  async create(
    current: AuthenticatedPrincipal,
    input: {
      commandId: string;
      name: string;
      routingCompanyId?: string | null;
      address: Omit<RouteAddress, 'label'>;
    },
  ) {
    const routingCompanyId =
      current.routingCompanyId ?? input.routingCompanyId ?? null;
    if (routingCompanyId) {
      const company = await this.companies.findCompany(
        current.companyId,
        routingCompanyId,
      );
      if (!company || company.status !== 'active') {
        throw validationError(
          'Selecione um cliente ativo para o ponto exclusivo.',
        );
      }
      if (
        current.routingCompanyId &&
        current.routingCompanyId !== routingCompanyId
      ) {
        throw forbidden('O cliente informado nao pertence ao seu acesso.');
      }
    }
    const point = createRoutingFixedPoint({
      companyId: current.companyId,
      routingCompanyId,
      name: input.name,
      address: input.address,
      actorUserId: current.id,
    });
    return presentFixedPoint(await this.points.create(point, input.commandId));
  }

  async list(current: AuthenticatedPrincipal, query: FixedPointListQuery) {
    const result = await this.points.list(current.companyId, {
      ...query,
      ...(current.routingCompanyId
        ? { routingCompanyId: current.routingCompanyId }
        : {}),
    });
    return { ...result, items: result.items.map(presentFixedPoint) };
  }

  async get(current: AuthenticatedPrincipal, fixedPointId: string) {
    const point = await this.points.find(current.companyId, fixedPointId);
    if (!point) throw notFound('Ponto fixo');
    if (
      current.routingCompanyId &&
      point.routingCompanyId &&
      point.routingCompanyId !== current.routingCompanyId
    ) {
      throw forbidden('O ponto fixo nao pertence ao seu acesso.');
    }
    return point;
  }
}

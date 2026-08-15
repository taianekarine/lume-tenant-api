import { createHash } from 'node:crypto';

import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import { isPassengerRoutingEligible } from '../../../domain/routing/passenger';
import {
  assertRouteTransition,
  buildGoogleMapsLinks,
  createRoute,
  missingRequiredDocuments,
  normalizeRouteData,
  type RouteData,
  type RoutePassengerAssignment,
  type RoutePlan,
  type RoutePoint,
  type RouteStatus,
} from '../../../domain/routing/route';
import { isContractEffective } from '../../../domain/routing/contract';
import { RoutingAgentService } from '../../../infra/routing/routing-agent.service';
import { ContractRepository } from '../../contracts/contract.repository';
import { PassengerRepository } from '../../contracts/passenger.repository';
import type { PassengerAggregate } from '../../contracts/passenger.repository';
import { RouteRepository } from '../../contracts/route.repository';
import type { RouteListQuery } from '../../contracts/route.repository';
import { RoutingRepository } from '../../contracts/routing.repository';
import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';

function deterministicUuid(seed: string): string {
  const hash = createHash('sha256').update(seed).digest('hex').split('');
  hash[12] = '4';
  hash[16] = ['8', '9', 'a', 'b'][Number.parseInt(hash[16], 16) % 4];
  const value = hash.join('').slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function dateCode(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

function codeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toUpperCase();
}

export function presentRoute(
  aggregate: Awaited<ReturnType<RouteRepository['find']>>,
) {
  if (!aggregate) return null;
  return {
    ...aggregate,
    route: {
      ...aggregate.route,
      validFrom: aggregate.route.validFrom.toISOString().slice(0, 10),
      validUntil:
        aggregate.route.validUntil?.toISOString().slice(0, 10) ?? null,
      publishedAt: aggregate.route.publishedAt?.toISOString() ?? null,
      createdAt: aggregate.route.createdAt.toISOString(),
      updatedAt: aggregate.route.updatedAt.toISOString(),
    },
  };
}

export class RoutesUseCase {
  constructor(
    private readonly routes: RouteRepository,
    private readonly contracts: ContractRepository,
    private readonly passengers: PassengerRepository,
    private readonly agent: RoutingAgentService,
    private readonly companies: RoutingRepository,
  ) {}

  private assertScope(
    current: AuthenticatedPrincipal,
    routingCompanyId: string,
  ) {
    if (
      current.routingCompanyId &&
      current.routingCompanyId !== routingCompanyId
    ) {
      throw forbidden('A rota informada nao pertence ao seu acesso.');
    }
  }

  private async requireRoute(current: AuthenticatedPrincipal, routeId: string) {
    const route = await this.routes.find(current.companyId, routeId);
    if (!route) throw notFound('Rota');
    this.assertScope(current, route.route.routingCompanyId);
    return route;
  }

  async generateFromContract(
    current: AuthenticatedPrincipal,
    contractId: string,
    input: { commandId: string; serviceDate: Date; shiftId?: string },
  ) {
    const contract = await this.contracts.find(current.companyId, contractId);
    if (!contract) throw notFound('Contrato');
    this.assertScope(current, contract.routingCompanyId);
    if (!isContractEffective(contract, input.serviceDate)) {
      throw validationError(
        'O contrato deve estar ativo e vigente na data da operacao.',
      );
    }

    const shifts = contract.shifts.filter((shift) => {
      if (input.shiftId && shift.id !== input.shiftId) return false;
      return (
        shift.activeWeekdays.length === 0 ||
        shift.activeWeekdays.includes(input.serviceDate.getUTCDay())
      );
    });
    if (shifts.length === 0) {
      throw validationError('Nenhum turno do contrato esta ativo nessa data.');
    }

    const allPassengers = await this.passengers.list(current.companyId, {
      page: 1,
      pageSize: 10_000,
      routingCompanyId: contract.routingCompanyId,
    });
    const generated = [];
    for (const shift of shifts) {
      // O horario contratual governa a rota. O horario do colaborador pode ser
      // uma referencia individual de embarque e nao deve exclui-lo do turno.
      const matching = allPassengers.items.filter(
        (aggregate) =>
          aggregate.passenger.shift?.toLocaleLowerCase('pt-BR') ===
          shift.name.toLocaleLowerCase('pt-BR'),
      );
      if (matching.length === 0) continue;

      const routable: PassengerAggregate[] = [];
      const pending: PassengerAggregate[] = [];
      for (const passenger of matching) {
        const missingDocuments = contract.requiresDocumentation
          ? missingRequiredDocuments(
              contract.requiredDocumentTypeCodes,
              passenger.documents,
            )
          : [];
        if (
          isPassengerRoutingEligible(passenger.passenger) &&
          missingDocuments.length === 0
        ) {
          routable.push(passenger);
        } else {
          pending.push(passenger);
        }
      }

      const vehicleCount =
        shift.vehicleCount ?? contract.contractedVehicleCount;
      const capacity =
        shift.vehicleCapacity ?? contract.predictedVehicleCapacity;
      for (let index = 0; index < vehicleCount; index += 1) {
        const isLastVehicle = index === vehicleCount - 1;
        const group = routable.slice(index * capacity, (index + 1) * capacity);
        if (isLastVehicle) {
          group.push(...routable.slice(vehicleCount * capacity), ...pending);
        }
        if (group.length === 0) continue;

        const routeCommandId = deterministicUuid(
          `${input.commandId}|${shift.id}|${index + 1}|route`,
        );
        const code = `${contract.code}-${codeText(shift.name)}-${dateCode(input.serviceDate)}-${String(index + 1).padStart(2, '0')}`;
        const route = createRoute(current.companyId, current.id, {
          routingCompanyId: contract.routingCompanyId,
          contractId: contract.id,
          code,
          name: `${contract.name} - ${shift.name} - Rota ${index + 1}`,
          shift: shift.name,
          requiredArrivalTime: shift.requiredArrivalTime,
          type: contract.routeType,
          requiresDocumentation: contract.requiresDocumentation,
          requiredDocumentTypeCodes: contract.requiredDocumentTypeCodes,
          origin: contract.origin,
          destination: contract.destination,
          predictedVehicleReference: contract.predictedVehicleReference,
          predictedVehicleName: contract.predictedVehicleName,
          predictedVehicleCapacity: capacity,
          maxWalkingDistanceMeters: contract.maxWalkingDistanceMeters,
          validFrom: input.serviceDate,
          validUntil: input.serviceDate,
          notes: `Rota sugerida automaticamente a partir do contrato ${contract.code}.`,
        });
        const created = await this.routes.create({
          route,
          actorUserId: current.id,
          commandId: routeCommandId,
        });
        const plan = this.agent.calculate(created.route, group);
        const planned = await this.routes.savePlan({
          companyId: current.companyId,
          routeId: created.route.id,
          plan,
          actorUserId: current.id,
          commandId: deterministicUuid(
            `${input.commandId}|${shift.id}|${index + 1}|plan`,
          ),
          expectedVersion: created.route.version,
          action: 'ROUTE_CALCULATED',
          reason: `Gerada pelo contrato ${contract.code}.`,
        });
        if (!planned) {
          throw conflict('A rota foi alterada durante a roteirizacao.');
        }
        generated.push(presentRoute(planned));
      }
    }
    if (generated.length === 0) {
      throw validationError(
        'Nenhum colaborador corresponde aos turnos e horarios do contrato nessa data.',
      );
    }
    return {
      contractId,
      serviceDate: input.serviceDate.toISOString().slice(0, 10),
      routes: generated,
    };
  }

  async list(current: AuthenticatedPrincipal, query: RouteListQuery) {
    const result = await this.routes.list(current.companyId, {
      ...query,
      ...(current.routingCompanyId
        ? { routingCompanyId: current.routingCompanyId }
        : {}),
    });
    return { ...result, items: result.items.map(presentRoute) };
  }

  async get(current: AuthenticatedPrincipal, routeId: string) {
    return presentRoute(await this.requireRoute(current, routeId));
  }

  async updateBase(
    current: AuthenticatedPrincipal,
    routeId: string,
    input: Partial<Omit<RouteData, 'routingCompanyId' | 'contractId'>> & {
      commandId: string;
      expectedVersion: number;
      reason?: string;
    },
  ) {
    const previous = await this.requireRoute(current, routeId);
    const data = normalizeRouteData({
      routingCompanyId: previous.route.routingCompanyId,
      contractId: previous.route.contractId,
      code: input.code ?? previous.route.code,
      name: input.name ?? previous.route.name,
      shift: input.shift ?? previous.route.shift,
      requiredArrivalTime:
        input.requiredArrivalTime ?? previous.route.requiredArrivalTime,
      type: input.type ?? previous.route.type,
      requiresDocumentation:
        input.requiresDocumentation ?? previous.route.requiresDocumentation,
      requiredDocumentTypeCodes:
        input.requiredDocumentTypeCodes ??
        previous.route.requiredDocumentTypeCodes,
      origin: input.origin ?? previous.route.origin,
      destination: input.destination ?? previous.route.destination,
      predictedVehicleReference:
        input.predictedVehicleReference === undefined
          ? previous.route.predictedVehicleReference
          : input.predictedVehicleReference,
      predictedVehicleName:
        input.predictedVehicleName ?? previous.route.predictedVehicleName,
      predictedVehicleCapacity:
        input.predictedVehicleCapacity ??
        previous.route.predictedVehicleCapacity,
      maxWalkingDistanceMeters:
        input.maxWalkingDistanceMeters ??
        previous.route.maxWalkingDistanceMeters,
      validFrom: input.validFrom ?? previous.route.validFrom,
      validUntil:
        input.validUntil === undefined
          ? previous.route.validUntil
          : input.validUntil,
      notes: input.notes === undefined ? previous.route.notes : input.notes,
    });
    const updated = await this.routes.updateBase({
      companyId: current.companyId,
      routeId,
      data,
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
    });
    if (!updated) {
      throw conflict(
        'A rota foi alterada por outro usuario. Recarregue e tente novamente.',
      );
    }
    return presentRoute(updated);
  }

  async recalculate(
    current: AuthenticatedPrincipal,
    routeId: string,
    input: { commandId: string; expectedVersion: number; reason?: string },
  ) {
    const currentRoute = await this.requireRoute(current, routeId);
    const assignedPassengers = (
      await Promise.all(
        currentRoute.assignments.map((assignment) =>
          this.passengers.find(current.companyId, assignment.passengerId),
        ),
      )
    ).filter(
      (passenger): passenger is PassengerAggregate => passenger !== null,
    );
    const candidates =
      assignedPassengers.length > 0
        ? assignedPassengers
        : (
            await this.passengers.list(current.companyId, {
              page: 1,
              pageSize: 10_000,
              routingCompanyId: currentRoute.route.routingCompanyId,
            })
          ).items;
    const plan = this.agent.calculate(currentRoute.route, candidates);
    const updated = await this.routes.savePlan({
      companyId: current.companyId,
      routeId,
      plan,
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
      action: 'ROUTE_RECALCULATED',
      reason: input.reason,
    });
    if (!updated) throw conflict('A rota foi alterada durante o recalculo.');
    return presentRoute(updated);
  }

  async editPlan(
    current: AuthenticatedPrincipal,
    routeId: string,
    input: {
      commandId: string;
      expectedVersion: number;
      points: RoutePoint[];
      assignments: RoutePassengerAssignment[];
      reason: string;
    },
  ) {
    const currentRoute = await this.requireRoute(current, routeId);
    const pointIds = new Set(input.points.map((point) => point.id));
    if (pointIds.size !== input.points.length) {
      throw validationError('Existem pontos duplicados na edicao da rota.');
    }
    const passengerIds = new Set<string>();
    for (const assignment of input.assignments) {
      if (passengerIds.has(assignment.passengerId)) {
        throw validationError('Um colaborador foi informado mais de uma vez.');
      }
      passengerIds.add(assignment.passengerId);
      if (assignment.pointId && !pointIds.has(assignment.pointId)) {
        throw validationError(
          'Um colaborador referencia um ponto inexistente.',
        );
      }
      const passenger = await this.passengers.find(
        current.companyId,
        assignment.passengerId,
      );
      if (
        !passenger ||
        passenger.passenger.routingCompanyId !==
          currentRoute.route.routingCompanyId
      ) {
        throw validationError('Um colaborador nao pertence a empresa da rota.');
      }
    }
    const plan: RoutePlan = this.agent.summarizeManual(
      currentRoute.route,
      input.points,
      input.assignments,
    );
    const updated = await this.routes.savePlan({
      companyId: current.companyId,
      routeId,
      plan,
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
      action: 'ROUTE_MANUALLY_EDITED',
      reason: input.reason,
    });
    if (!updated) throw conflict('A rota foi alterada durante a edicao.');
    return presentRoute(updated);
  }

  async transition(
    current: AuthenticatedPrincipal,
    routeId: string,
    input: {
      commandId: string;
      expectedVersion: number;
      status: RouteStatus;
      reason?: string;
    },
  ) {
    const currentRoute = await this.requireRoute(current, routeId);
    assertRouteTransition(currentRoute.route.status, input.status);
    const updated = await this.routes.transition({
      companyId: current.companyId,
      routeId,
      status: input.status,
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
      action: `ROUTE_${input.status.toUpperCase().replaceAll('-', '_')}`,
      reason: input.reason,
    });
    if (!updated) throw conflict('A rota foi alterada durante a transicao.');
    return presentRoute(updated);
  }

  async approve(
    current: AuthenticatedPrincipal,
    routeId: string,
    input: {
      commandId: string;
      expectedVersion: number;
      notes?: string;
    },
  ) {
    const currentRoute = await this.requireRoute(current, routeId);
    assertRouteTransition(currentRoute.route.status, 'approved');
    const blockers = currentRoute.assignments.filter(
      (assignment) => assignment.status !== 'assigned',
    );
    if (blockers.length > 0) {
      throw validationError(
        'Regularize passageiros pendentes ou excedentes antes da aprovacao.',
      );
    }
    if (currentRoute.assignments.length === 0) {
      throw validationError('Uma rota sem passageiros nao pode ser aprovada.');
    }
    for (const assignment of currentRoute.assignments) {
      const passenger = await this.passengers.find(
        current.companyId,
        assignment.passengerId,
      );
      if (!passenger)
        throw validationError('Colaborador da rota nao encontrado.');
      const missing = currentRoute.route.requiresDocumentation
        ? missingRequiredDocuments(
            currentRoute.route.requiredDocumentTypeCodes,
            passenger.documents,
          )
        : [];
      if (missing.length > 0) {
        throw validationError(
          `${passenger.passenger.fullName}: dados documentais pendentes (${missing.join(', ')}).`,
        );
      }
    }
    const navigationLinks = buildGoogleMapsLinks(
      currentRoute.route.version + 1,
      currentRoute.route.origin,
      currentRoute.points,
      currentRoute.route.destination,
    );
    const approved = await this.routes.approve({
      companyId: current.companyId,
      routeId,
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
      notes: input.notes,
      navigationLinks,
    });
    if (!approved) throw conflict('A rota foi alterada durante a aprovacao.');
    return presentRoute(approved);
  }

  async publish(
    current: AuthenticatedPrincipal,
    routeId: string,
    input: { commandId: string; expectedVersion: number },
  ) {
    const currentRoute = await this.requireRoute(current, routeId);
    assertRouteTransition(currentRoute.route.status, 'published');
    if (currentRoute.route.approvedVersion === null) {
      throw validationError('A rota deve possuir uma versao aprovada.');
    }
    const published = await this.routes.publish({
      companyId: current.companyId,
      routeId,
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
    });
    if (!published) throw conflict('A rota foi alterada durante a publicacao.');
    return presentRoute(published);
  }

  async history(current: AuthenticatedPrincipal, routeId: string) {
    await this.requireRoute(current, routeId);
    const history = await this.routes.history(current.companyId, routeId);
    return history.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    }));
  }

  async approvedVersion(current: AuthenticatedPrincipal, routeId: string) {
    const route = await this.requireRoute(current, routeId);
    if (route.route.approvedVersion === null) {
      throw validationError('A rota ainda nao possui uma versao aprovada.');
    }
    const version = await this.routes.version(
      current.companyId,
      routeId,
      route.route.approvedVersion,
    );
    if (!version) throw notFound('Versao aprovada da rota');
    return version;
  }

  async approvedExportContext(
    current: AuthenticatedPrincipal,
    routeId: string,
  ) {
    const route = await this.requireRoute(current, routeId);
    const version = await this.approvedVersion(current, routeId);
    const contract = await this.contracts.find(
      current.companyId,
      route.route.contractId,
    );
    const routingCompany = await this.companies.findCompany(
      current.companyId,
      route.route.routingCompanyId,
    );
    if (!contract || !routingCompany) {
      throw validationError(
        'A empresa ou o contrato da versao aprovada nao foi encontrado.',
      );
    }
    return { snapshot: version.snapshot, contract, routingCompany };
  }
}

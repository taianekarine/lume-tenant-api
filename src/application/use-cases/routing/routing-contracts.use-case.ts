import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import {
  CONTRACT_PERIODICITIES,
  CONTRACT_STATUSES,
  createContract,
  normalizeContractData,
  type ContractData,
} from '../../../domain/routing/contract';
import { ContractRepository } from '../../contracts/contract.repository';
import type { ContractListQuery } from '../../contracts/contract.repository';
import { FixedPointRepository } from '../../contracts/fixed-point.repository';
import { RoutingRepository } from '../../contracts/routing.repository';
import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';

export function presentContract(contract: ReturnType<typeof createContract>) {
  return {
    ...contract,
    validFrom: contract.validFrom.toISOString().slice(0, 10),
    validUntil: contract.validUntil?.toISOString().slice(0, 10) ?? null,
    createdAt: contract.createdAt.toISOString(),
    updatedAt: contract.updatedAt.toISOString(),
  };
}

export class RoutingContractsUseCase {
  constructor(
    private readonly contracts: ContractRepository,
    private readonly companies: RoutingRepository,
    private readonly points: FixedPointRepository,
  ) {}

  private async resolveFixedPoints(
    current: AuthenticatedPrincipal,
    input: ContractData,
  ): Promise<ContractData> {
    const resolve = async (id: string | null, label: string) => {
      if (!id) return null;
      const point = await this.points.find(current.companyId, id);
      if (!point || point.status !== 'active') {
        throw validationError(`Selecione um ponto fixo ativo para ${label}.`);
      }
      if (
        point.routingCompanyId &&
        point.routingCompanyId !== input.routingCompanyId
      ) {
        throw validationError(
          `O ponto fixo de ${label} e exclusivo de outro cliente.`,
        );
      }
      return point;
    };
    const origin = await resolve(input.originFixedPointId, 'a saida');
    const destination = await resolve(
      input.destinationFixedPointId,
      'o destino',
    );
    return normalizeContractData({
      ...input,
      origin: origin?.address ?? input.origin,
      destination: destination?.address ?? input.destination,
    });
  }

  private async assertCompanyScope(
    current: AuthenticatedPrincipal,
    routingCompanyId: string,
  ) {
    if (
      current.routingCompanyId &&
      current.routingCompanyId !== routingCompanyId
    ) {
      throw forbidden('A empresa informada nao pertence ao seu acesso.');
    }
    const company = await this.companies.findCompany(
      current.companyId,
      routingCompanyId,
    );
    if (!company || company.status !== 'active') {
      throw validationError('Selecione uma empresa cliente ativa.');
    }
  }

  async create(
    current: AuthenticatedPrincipal,
    input: ContractData & { commandId: string },
  ) {
    await this.assertCompanyScope(current, input.routingCompanyId);
    const data = await this.resolveFixedPoints(current, input);
    const contract = createContract(current.companyId, current.id, data);
    const created = await this.contracts.create({
      contract,
      actorUserId: current.id,
      commandId: input.commandId,
    });
    return presentContract(created);
  }

  async list(current: AuthenticatedPrincipal, query: ContractListQuery) {
    const result = await this.contracts.list(current.companyId, {
      ...query,
      ...(current.routingCompanyId
        ? { routingCompanyId: current.routingCompanyId }
        : {}),
    });
    return { ...result, items: result.items.map(presentContract) };
  }

  async get(current: AuthenticatedPrincipal, contractId: string) {
    const contract = await this.contracts.find(current.companyId, contractId);
    if (!contract) throw notFound('Contrato');
    if (
      current.routingCompanyId &&
      contract.routingCompanyId !== current.routingCompanyId
    ) {
      throw forbidden('O contrato informado nao pertence ao seu acesso.');
    }
    return contract;
  }

  async update(
    current: AuthenticatedPrincipal,
    contractId: string,
    input: Partial<ContractData> & {
      expectedVersion: number;
      commandId: string;
      reason?: string;
    },
  ) {
    const previous = await this.get(current, contractId);
    const data = normalizeContractData({
      routingCompanyId: input.routingCompanyId ?? previous.routingCompanyId,
      originFixedPointId:
        input.originFixedPointId === undefined
          ? previous.originFixedPointId
          : input.originFixedPointId,
      destinationFixedPointId:
        input.destinationFixedPointId === undefined
          ? previous.destinationFixedPointId
          : input.destinationFixedPointId,
      code: input.code ?? previous.code,
      name: input.name ?? previous.name,
      operationType: input.operationType ?? previous.operationType,
      routeType: input.routeType ?? previous.routeType,
      status: input.status ?? previous.status,
      periodicity: input.periodicity ?? previous.periodicity,
      contractedVehicleCount:
        input.contractedVehicleCount ?? previous.contractedVehicleCount,
      predictedVehicleName:
        input.predictedVehicleName ?? previous.predictedVehicleName,
      predictedVehicleReference:
        input.predictedVehicleReference === undefined
          ? previous.predictedVehicleReference
          : input.predictedVehicleReference,
      predictedVehicleCapacity:
        input.predictedVehicleCapacity ?? previous.predictedVehicleCapacity,
      contractedKm:
        input.contractedKm === undefined
          ? previous.contractedKm
          : input.contractedKm,
      plannedKm:
        input.plannedKm === undefined ? previous.plannedKm : input.plannedKm,
      maxWalkingDistanceMeters:
        input.maxWalkingDistanceMeters ?? previous.maxWalkingDistanceMeters,
      requiresDocumentation:
        input.requiresDocumentation ?? previous.requiresDocumentation,
      requiredDocumentTypeCodes:
        input.requiredDocumentTypeCodes ?? previous.requiredDocumentTypeCodes,
      unitName: input.unitName ?? previous.unitName,
      origin: input.origin ?? previous.origin,
      destination: input.destination ?? previous.destination,
      validFrom: input.validFrom ?? previous.validFrom,
      validUntil:
        input.validUntil === undefined ? previous.validUntil : input.validUntil,
      notes: input.notes === undefined ? previous.notes : input.notes,
      costCenters: input.costCenters ?? previous.costCenters,
      shifts: input.shifts ?? previous.shifts,
    });
    await this.assertCompanyScope(current, data.routingCompanyId);
    const resolvedData = await this.resolveFixedPoints(current, data);
    const updated = await this.contracts.update({
      companyId: current.companyId,
      contractId,
      data: resolvedData,
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
      reason: input.reason,
    });
    if (!updated) {
      throw conflict(
        'O contrato foi alterado por outro usuario. Recarregue e tente novamente.',
      );
    }
    return presentContract(updated);
  }

  async history(current: AuthenticatedPrincipal, contractId: string) {
    await this.get(current, contractId);
    const history = await this.contracts.history(current.companyId, contractId);
    return history.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    }));
  }

  validateFilters(query: ContractListQuery) {
    if (query.status && !CONTRACT_STATUSES.includes(query.status)) {
      throw validationError('Informe um status de contrato valido.');
    }
  }

  validatePeriodicity(value: string) {
    if (!CONTRACT_PERIODICITIES.includes(value as never)) {
      throw validationError('Informe uma periodicidade valida.');
    }
  }
}

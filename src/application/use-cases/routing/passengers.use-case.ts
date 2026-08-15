import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import type {
  PassengerAggregate,
  PassengerListQuery,
} from '../../contracts/passenger.repository';
import { PassengerRepository } from '../../contracts/passenger.repository';
import { RoutingRepository } from '../../contracts/routing.repository';
import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';
import {
  PASSENGER_STATUSES,
  createPassenger,
  normalizePassengerData,
  validatePassengerData,
  type PassengerData,
  type PassengerDocumentInput,
  type PassengerStatus,
} from '../../../domain/routing/passenger';

export function presentPassenger(aggregate: PassengerAggregate) {
  const { passenger } = aggregate;
  return {
    ...passenger,
    createdAt: passenger.createdAt.toISOString(),
    updatedAt: passenger.updatedAt.toISOString(),
    routingEligible:
      passenger.status === 'active' && passenger.registrationStatus === 'ready',
    documents: aggregate.documents.map((document) => ({
      ...document,
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    })),
    issues: aggregate.issues.map((issue) => ({
      ...issue,
      resolvedAt: issue.resolvedAt?.toISOString() ?? null,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
    })),
  };
}

function validateDocuments(
  documents: PassengerDocumentInput[] = [],
): PassengerDocumentInput[] {
  const seen = new Set<string>();
  return documents.map((document) => {
    const code = document.documentTypeCode.trim().toLocaleLowerCase('pt-BR');
    if (!/^[a-z][a-z0-9-]{2,79}$/.test(code)) {
      throw validationError(
        'Informe codigos documentais configuraveis validos.',
      );
    }
    if (seen.has(code)) {
      throw validationError(
        `O dado documental ${code} foi informado em duplicidade.`,
      );
    }
    seen.add(code);
    return { documentTypeCode: code, data: document.data };
  });
}

export type PassengerMutationInput = Omit<
  PassengerData,
  'predefinedBoardingOrigin'
> & {
  predefinedBoardingOrigin?: 'company' | 'operations' | null;
  documents?: PassengerDocumentInput[];
};

export class PassengersUseCase {
  constructor(
    private readonly passengers: PassengerRepository,
    private readonly routing: RoutingRepository,
  ) {}

  private async requireActiveRoutingCompany(
    companyId: string,
    routingCompanyId: string,
  ) {
    const company = await this.routing.findCompany(companyId, routingCompanyId);
    if (!company || company.status !== 'active') {
      throw validationError('Selecione uma empresa cliente ativa.');
    }
    return company;
  }

  async create(
    current: AuthenticatedPrincipal,
    input: PassengerMutationInput & { commandId: string },
  ) {
    if (
      current.routingCompanyId &&
      current.routingCompanyId !== input.routingCompanyId
    ) {
      throw forbidden('A empresa informada nao pertence ao seu acesso.');
    }
    await this.requireActiveRoutingCompany(
      current.companyId,
      input.routingCompanyId,
    );
    const data = normalizePassengerData(input);
    const passenger = createPassenger(current.companyId, current.id, data);
    const issues = validatePassengerData(data);
    const created = await this.passengers.create({
      passenger,
      documents: validateDocuments(input.documents),
      issues,
      actorUserId: current.id,
      commandId: input.commandId,
    });
    return presentPassenger(created);
  }

  async list(current: AuthenticatedPrincipal, query: PassengerListQuery) {
    const result = await this.passengers.list(current.companyId, {
      ...query,
      ...(current.routingCompanyId
        ? { routingCompanyId: current.routingCompanyId }
        : {}),
    });
    return { ...result, items: result.items.map(presentPassenger) };
  }

  async get(current: AuthenticatedPrincipal, passengerId: string) {
    const passenger = await this.passengers.find(
      current.companyId,
      passengerId,
    );
    if (!passenger) throw notFound('Colaborador');
    if (
      current.routingCompanyId &&
      passenger.passenger.routingCompanyId !== current.routingCompanyId
    ) {
      throw forbidden('O colaborador informado nao pertence ao seu acesso.');
    }
    return presentPassenger(passenger);
  }

  async update(
    current: AuthenticatedPrincipal,
    passengerId: string,
    input: Partial<PassengerMutationInput> & {
      commandId: string;
      expectedVersion: number;
    },
  ) {
    const currentPassenger = await this.passengers.find(
      current.companyId,
      passengerId,
    );
    if (!currentPassenger) throw notFound('Colaborador');
    if (
      current.routingCompanyId &&
      currentPassenger.passenger.routingCompanyId !== current.routingCompanyId
    ) {
      throw forbidden('O colaborador informado nao pertence ao seu acesso.');
    }
    const previous = currentPassenger.passenger;
    const data = normalizePassengerData({
      routingCompanyId: previous.routingCompanyId,
      externalReference:
        input.externalReference === undefined
          ? previous.externalReference
          : input.externalReference,
      fullName: input.fullName ?? previous.fullName,
      shift: input.shift === undefined ? previous.shift : input.shift,
      requiredArrivalTime:
        input.requiredArrivalTime === undefined
          ? previous.requiredArrivalTime
          : input.requiredArrivalTime,
      sector: input.sector === undefined ? previous.sector : input.sector,
      accessibilityRequired:
        input.accessibilityRequired ?? previous.accessibilityRequired,
      accessibilityNotes:
        input.accessibilityNotes === undefined
          ? previous.accessibilityNotes
          : input.accessibilityNotes,
      residenceStreet:
        input.residenceStreet === undefined
          ? previous.residenceStreet
          : input.residenceStreet,
      residenceNumber:
        input.residenceNumber === undefined
          ? previous.residenceNumber
          : input.residenceNumber,
      residenceComplement:
        input.residenceComplement === undefined
          ? previous.residenceComplement
          : input.residenceComplement,
      residenceDistrict:
        input.residenceDistrict === undefined
          ? previous.residenceDistrict
          : input.residenceDistrict,
      residencePostalCode:
        input.residencePostalCode === undefined
          ? previous.residencePostalCode
          : input.residencePostalCode,
      residenceCity:
        input.residenceCity === undefined
          ? previous.residenceCity
          : input.residenceCity,
      residenceState:
        input.residenceState === undefined
          ? previous.residenceState
          : input.residenceState,
      residenceLatitude:
        input.residenceLatitude === undefined
          ? previous.residenceLatitude
          : input.residenceLatitude,
      residenceLongitude:
        input.residenceLongitude === undefined
          ? previous.residenceLongitude
          : input.residenceLongitude,
      predefinedBoardingLabel:
        input.predefinedBoardingLabel === undefined
          ? previous.predefinedBoardingLabel
          : input.predefinedBoardingLabel,
      predefinedBoardingStreet:
        input.predefinedBoardingStreet === undefined
          ? previous.predefinedBoardingStreet
          : input.predefinedBoardingStreet,
      predefinedBoardingNumber:
        input.predefinedBoardingNumber === undefined
          ? previous.predefinedBoardingNumber
          : input.predefinedBoardingNumber,
      predefinedBoardingComplement:
        input.predefinedBoardingComplement === undefined
          ? previous.predefinedBoardingComplement
          : input.predefinedBoardingComplement,
      predefinedBoardingDistrict:
        input.predefinedBoardingDistrict === undefined
          ? previous.predefinedBoardingDistrict
          : input.predefinedBoardingDistrict,
      predefinedBoardingPostalCode:
        input.predefinedBoardingPostalCode === undefined
          ? previous.predefinedBoardingPostalCode
          : input.predefinedBoardingPostalCode,
      predefinedBoardingCity:
        input.predefinedBoardingCity === undefined
          ? previous.predefinedBoardingCity
          : input.predefinedBoardingCity,
      predefinedBoardingState:
        input.predefinedBoardingState === undefined
          ? previous.predefinedBoardingState
          : input.predefinedBoardingState,
      predefinedBoardingLatitude:
        input.predefinedBoardingLatitude === undefined
          ? previous.predefinedBoardingLatitude
          : input.predefinedBoardingLatitude,
      predefinedBoardingLongitude:
        input.predefinedBoardingLongitude === undefined
          ? previous.predefinedBoardingLongitude
          : input.predefinedBoardingLongitude,
      predefinedBoardingOrigin:
        input.predefinedBoardingOrigin === undefined
          ? previous.predefinedBoardingOrigin
          : input.predefinedBoardingOrigin,
    });
    const updated = await this.passengers.update({
      companyId: current.companyId,
      passengerId,
      data,
      documents:
        input.documents === undefined
          ? undefined
          : validateDocuments(input.documents),
      issues: validatePassengerData(data),
      actorUserId: current.id,
      commandId: input.commandId,
      expectedVersion: input.expectedVersion,
    });
    if (!updated) {
      throw conflict(
        'O colaborador foi alterado por outro usuario. Recarregue e tente novamente.',
      );
    }
    return presentPassenger(updated);
  }

  async changeStatus(
    current: AuthenticatedPrincipal,
    passengerId: string,
    input: {
      commandId: string;
      expectedVersion: number;
      status: PassengerStatus;
      reason?: string;
    },
  ) {
    if (!PASSENGER_STATUSES.includes(input.status)) {
      throw validationError('Informe uma situacao valida para o colaborador.');
    }
    if (input.status !== 'active' && !input.reason?.trim()) {
      throw validationError('Informe o motivo da alteracao de situacao.');
    }
    const currentPassenger = await this.passengers.find(
      current.companyId,
      passengerId,
    );
    if (!currentPassenger) throw notFound('Colaborador');
    if (
      current.routingCompanyId &&
      currentPassenger.passenger.routingCompanyId !== current.routingCompanyId
    ) {
      throw forbidden('O colaborador informado nao pertence ao seu acesso.');
    }
    const updated = await this.passengers.changeStatus({
      companyId: current.companyId,
      passengerId,
      actorUserId: current.id,
      ...input,
      reason: input.reason?.trim(),
    });
    if (!updated) {
      throw conflict(
        'O colaborador foi alterado por outro usuario. Recarregue e tente novamente.',
      );
    }
    return presentPassenger(updated);
  }

  async history(current: AuthenticatedPrincipal, passengerId: string) {
    await this.get(current, passengerId);
    const entries = await this.passengers.history(
      current.companyId,
      passengerId,
    );
    return entries.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    }));
  }
}

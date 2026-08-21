import {
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import {
  ROUTING_CLIENT_STATUSES,
  createRoutingCompany,
  normalizeRoutingCompanyInput,
  type RoutingClientType,
  type RoutingCompanyInput,
  type RoutingCompanyProps,
  type RoutingClientStatus,
} from '../../../domain/routing/routing-company';
import { RoutingRepository } from '../../contracts/routing.repository';
import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';

function presentCompany(company: RoutingCompanyProps) {
  return {
    ...company,
    avicLastSyncedAt: company.avicLastSyncedAt?.toISOString() ?? null,
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString(),
  };
}

export class RoutingCompaniesUseCase {
  constructor(private readonly routing: RoutingRepository) {}

  private async assertUnique(
    companyId: string,
    values: {
      cpf?: string | null;
      cnpj?: string | null;
      avicExternalId?: string | null;
    },
    exceptId?: string,
  ) {
    const checks = [
      ['cpf', values.cpf, 'Já existe um cliente cadastrado com este CPF.'],
      ['cnpj', values.cnpj, 'Já existe um cliente cadastrado com este CNPJ.'],
      [
        'avicExternalId',
        values.avicExternalId,
        'Já existe um cliente com este Código AVIC.',
      ],
    ] as const;
    for (const [field, value, message] of checks) {
      if (
        value &&
        (await this.routing.findCompanyByUniqueValue(
          companyId,
          field,
          value,
          exceptId,
        ))
      )
        throw conflict(message);
    }
  }

  async create(
    current: AuthenticatedPrincipal,
    input: RoutingCompanyInput & { commandId: string },
  ) {
    if (current.routingCompanyId)
      throw forbidden(
        'Usuários de clientes não podem cadastrar outro cliente.',
      );
    const normalized = normalizeRoutingCompanyInput(input);
    await this.assertUnique(current.companyId, normalized);
    const company = createRoutingCompany({
      ...input,
      companyId: current.companyId,
      actorUserId: current.id,
    });
    return presentCompany(
      await this.routing.createCompany(company, input.commandId),
    );
  }

  async list(
    current: AuthenticatedPrincipal,
    query: {
      page: number;
      pageSize: number;
      search?: string;
      status?: RoutingClientStatus;
      clientType?: RoutingClientType;
      sort?: 'name' | 'status' | 'avic';
    },
  ) {
    if (current.routingCompanyId) {
      const company = await this.routing.findCompany(
        current.companyId,
        current.routingCompanyId,
      );
      return {
        items: company ? [presentCompany(company)] : [],
        total: company ? 1 : 0,
      };
    }
    const result = await this.routing.listCompanies(current.companyId, query);
    return { ...result, items: result.items.map(presentCompany) };
  }

  async get(current: AuthenticatedPrincipal, routingCompanyId: string) {
    if (
      current.routingCompanyId &&
      current.routingCompanyId !== routingCompanyId
    )
      throw forbidden('O cliente informado não pertence ao seu acesso.');
    const company = await this.routing.findCompany(
      current.companyId,
      routingCompanyId,
    );
    if (!company) throw notFound('Cliente');
    return presentCompany(company);
  }

  async update(
    current: AuthenticatedPrincipal,
    routingCompanyId: string,
    input: RoutingCompanyInput & { commandId: string; expectedVersion: number },
  ) {
    await this.get(current, routingCompanyId);
    if (!ROUTING_CLIENT_STATUSES.includes(input.status ?? 'active'))
      throw validationError('Informe uma situação válida para o cliente.');
    const normalized = normalizeRoutingCompanyInput(input);
    await this.assertUnique(current.companyId, normalized, routingCompanyId);
    const displayName =
      normalized.clientType === 'pf'
        ? normalized.individualName ||
          normalized.individualWhatsapp ||
          'Cliente pessoa física'
        : normalized.legalName!;
    const activeTaxId =
      normalized.clientType === 'pf' ? normalized.cpf : normalized.cnpj;
    const updated = await this.routing.updateCompany(
      current.companyId,
      routingCompanyId,
      {
        ...normalized,
        taxId:
          activeTaxId ?? `pf${routingCompanyId.replace(/-/g, '').slice(0, 12)}`,
        legalName: normalized.legalName ?? displayName,
        actorUserId: current.id,
        commandId: input.commandId,
        expectedVersion: input.expectedVersion,
      },
    );
    if (!updated)
      throw conflict(
        'O cliente foi alterado por outro usuário. Recarregue os dados e tente novamente.',
      );
    return presentCompany(updated);
  }

  async history(current: AuthenticatedPrincipal, routingCompanyId: string) {
    await this.get(current, routingCompanyId);
    return (
      await this.routing.listCompanyHistory(current.companyId, routingCompanyId)
    ).map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() }));
  }

  async comments(current: AuthenticatedPrincipal, routingCompanyId: string) {
    await this.get(current, routingCompanyId);
    return (
      await this.routing.listCompanyComments(
        current.companyId,
        routingCompanyId,
      )
    ).map((item) => ({
      ...item,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    }));
  }

  async addComment(
    current: AuthenticatedPrincipal,
    routingCompanyId: string,
    input: { commandId: string; comment: string },
  ) {
    await this.get(current, routingCompanyId);
    const comment = input.comment.trim();
    if (!comment) throw validationError('Informe o comentário.');
    return this.routing.createCompanyComment({
      companyId: current.companyId,
      routingCompanyId,
      actorUserId: current.id,
      commandId: input.commandId,
      comment,
    });
  }

  async updateComment(
    current: AuthenticatedPrincipal,
    routingCompanyId: string,
    commentId: string,
    input: { commandId: string; comment: string },
  ) {
    await this.get(current, routingCompanyId);
    const comment = input.comment.trim();
    if (!comment) throw validationError('Informe o comentário.');
    const updated = await this.routing.updateCompanyComment({
      companyId: current.companyId,
      routingCompanyId,
      commentId,
      actorUserId: current.id,
      commandId: input.commandId,
      comment,
    });
    if (!updated) throw notFound('Comentário');
    return updated;
  }

  async removeComment(
    current: AuthenticatedPrincipal,
    routingCompanyId: string,
    commentId: string,
    commandId: string,
  ) {
    await this.get(current, routingCompanyId);
    if (
      !(await this.routing.deleteCompanyComment({
        companyId: current.companyId,
        routingCompanyId,
        commentId,
        actorUserId: current.id,
        commandId,
      }))
    )
      throw notFound('Comentário');
    return { removed: true as const };
  }
}

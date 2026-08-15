import {
  AppError,
  conflict,
  forbidden,
  notFound,
  validationError,
} from '../../../core/errors/app-error';
import {
  ROUTING_COMPANY_STATUSES,
  createRoutingCompany,
  normalizeRoutingClientTaxId,
  type RoutingCompanyProps,
  type RoutingCompanyStatus,
} from '../../../domain/routing/routing-company';
import { RoutingRepository } from '../../contracts/routing.repository';
import type { AuthenticatedPrincipal } from '../../presenters/user.presenter';
import { PasswordHasher } from '../../contracts/cryptography';
import { UsersRepository } from '../../contracts/repositories';

function presentCompany(company: RoutingCompanyProps) {
  return {
    ...company,
    avicLastSyncedAt: company.avicLastSyncedAt?.toISOString() ?? null,
    createdAt: company.createdAt.toISOString(),
    updatedAt: company.updatedAt.toISOString(),
  };
}

export class RoutingCompaniesUseCase {
  constructor(
    private readonly routing: RoutingRepository,
    private readonly users: UsersRepository,
    private readonly passwordHasher: PasswordHasher,
  ) {}

  async create(
    current: AuthenticatedPrincipal,
    input: {
      commandId: string;
      taxId: string;
      legalName: string;
      tradeName?: string;
      costCenter?: string;
    },
  ) {
    if (current.routingCompanyId) {
      throw forbidden(
        'Usuarios de clientes nao podem cadastrar outra empresa.',
      );
    }
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
      status?: RoutingCompanyStatus;
    },
  ) {
    if (current.routingCompanyId) {
      const company = await this.routing.findCompany(
        current.companyId,
        current.routingCompanyId,
      );
      if (!company) return { items: [], total: 0 };
      const search = query.search?.trim().toLocaleLowerCase('pt-BR');
      const matchesSearch =
        !search ||
        [
          company.legalName,
          company.tradeName,
          company.taxId,
          company.costCenter,
        ]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase('pt-BR').includes(search));
      const matchesStatus = !query.status || query.status === company.status;
      return {
        items: matchesSearch && matchesStatus ? [presentCompany(company)] : [],
        total: matchesSearch && matchesStatus ? 1 : 0,
      };
    }
    const result = await this.routing.listCompanies(current.companyId, query);
    return { ...result, items: result.items.map(presentCompany) };
  }

  async get(current: AuthenticatedPrincipal, routingCompanyId: string) {
    if (
      current.routingCompanyId &&
      current.routingCompanyId !== routingCompanyId
    ) {
      throw forbidden('A empresa informada nao pertence ao seu acesso.');
    }
    const company = await this.routing.findCompany(
      current.companyId,
      routingCompanyId,
    );
    if (!company) throw notFound('Empresa cliente');
    return presentCompany(company);
  }

  async update(
    current: AuthenticatedPrincipal,
    routingCompanyId: string,
    input: {
      commandId: string;
      expectedVersion: number;
      taxId?: string;
      legalName?: string;
      tradeName?: string | null;
      costCenter?: string | null;
      status?: RoutingCompanyStatus;
    },
  ) {
    if (
      current.routingCompanyId &&
      current.routingCompanyId !== routingCompanyId
    ) {
      throw forbidden('A empresa informada nao pertence ao seu acesso.');
    }
    if (input.legalName !== undefined && !input.legalName.trim()) {
      throw validationError('Informe a razao social.');
    }
    if (
      input.status !== undefined &&
      !ROUTING_COMPANY_STATUSES.includes(input.status)
    ) {
      throw validationError('Informe um status valido para a empresa cliente.');
    }
    const currentCompany = await this.routing.findCompany(
      current.companyId,
      routingCompanyId,
    );
    if (!currentCompany) throw notFound('Empresa cliente');
    const updated = await this.routing.updateCompany(
      current.companyId,
      routingCompanyId,
      {
        ...input,
        actorUserId: current.id,
        taxId:
          input.taxId === undefined
            ? undefined
            : normalizeRoutingClientTaxId(input.taxId),
        legalName: input.legalName?.trim(),
        tradeName:
          input.tradeName === undefined
            ? undefined
            : input.tradeName?.trim() || null,
        costCenter:
          input.costCenter === undefined
            ? undefined
            : input.costCenter?.trim() || null,
      },
    );
    if (!updated) {
      throw conflict(
        'A empresa cliente foi alterada por outro usuario. Recarregue os dados e tente novamente.',
      );
    }
    return presentCompany(updated);
  }

  async delete(
    current: AuthenticatedPrincipal,
    routingCompanyId: string,
    input: { commandId: string; password: string },
  ) {
    if (current.routingCompanyId) {
      throw forbidden('Usuarios cliente nao podem excluir o proprio cliente.');
    }
    const actor = await this.users.findById(current.companyId, current.id);
    if (!actor) throw notFound('Usuario');
    const matches = await this.passwordHasher.compare(
      input.password,
      actor.user.props.passwordHash,
    );
    if (!matches) {
      throw new AppError(
        'INVALID_CREDENTIALS',
        'A senha atual informada esta incorreta.',
      );
    }
    void input.commandId;
    const result = await this.routing.deleteCompany(
      current.companyId,
      routingCompanyId,
    );
    if (result === 'not-found') throw notFound('Cliente');
    if (result === 'in-use') {
      throw conflict(
        'Este cliente possui usuarios, contratos, colaboradores, rotas ou pontos exclusivos. Desative-o para preservar o historico.',
      );
    }
    return { deleted: true as const };
  }

  async history(current: AuthenticatedPrincipal, routingCompanyId: string) {
    await this.get(current, routingCompanyId);
    const entries = await this.routing.listCompanyHistory(
      current.companyId,
      routingCompanyId,
    );
    return entries.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    }));
  }
}

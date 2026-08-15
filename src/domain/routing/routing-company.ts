import { randomUUID } from 'node:crypto';

import { validationError } from '../../core/errors/app-error';
import {
  isValidCnpj,
  isValidCpf,
} from '../../shared/utils/brazilian-documents';
import { normalizeTaxId } from '../../shared/utils/normalization';

export const ROUTING_COMPANY_STATUSES = [
  'active',
  'inactive',
  'suspended',
] as const;

export type RoutingCompanyStatus = (typeof ROUTING_COMPANY_STATUSES)[number];

export interface RoutingCompanyProps {
  id: string;
  companyId: string;
  taxId: string;
  legalName: string;
  tradeName: string | null;
  costCenter: string | null;
  status: RoutingCompanyStatus;
  avicExternalId: string | null;
  avicLastSyncedAt: Date | null;
  version: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function normalizeRoutingClientTaxId(value: string): string {
  const taxId = normalizeTaxId(value);
  if (!isValidCpf(taxId) && !isValidCnpj(taxId)) {
    throw validationError('Informe um CPF ou CNPJ valido para o cliente.');
  }
  return taxId;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw validationError(`Informe ${label}.`);
  return normalized;
}

export function createRoutingCompany(input: {
  companyId: string;
  taxId: string;
  legalName: string;
  tradeName?: string;
  costCenter?: string;
  actorUserId?: string;
}): RoutingCompanyProps {
  const taxId = normalizeRoutingClientTaxId(input.taxId);
  const now = new Date();
  return {
    id: randomUUID(),
    companyId: input.companyId,
    taxId,
    legalName: requiredText(input.legalName, 'o nome ou a razao social'),
    tradeName: input.tradeName?.trim() || null,
    costCenter: input.costCenter?.trim() || null,
    status: 'active',
    avicExternalId: null,
    avicLastSyncedAt: null,
    version: 1,
    createdByUserId: input.actorUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

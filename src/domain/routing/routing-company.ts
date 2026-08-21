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
export const ROUTING_CLIENT_STATUSES = ['active', 'inactive'] as const;
export const ROUTING_CLIENT_TYPES = ['pf', 'pj'] as const;
export type RoutingCompanyStatus = (typeof ROUTING_COMPANY_STATUSES)[number];
export type RoutingClientStatus = (typeof ROUTING_CLIENT_STATUSES)[number];
export type RoutingClientType = (typeof ROUTING_CLIENT_TYPES)[number];

export interface RoutingPhone {
  number: string;
  description?: string | null;
}

export interface RoutingCompanyProps {
  id: string;
  companyId: string;
  taxId: string;
  legalName: string;
  tradeName: string | null;
  costCenter: string | null;
  clientType: RoutingClientType;
  individualName: string | null;
  cpf: string | null;
  individualEmail: string | null;
  individualWhatsapp: string | null;
  individualPhones: RoutingPhone[];
  cnpj: string | null;
  legalEmail: string | null;
  legalWhatsapp: string | null;
  legalPhones: RoutingPhone[];
  status: RoutingCompanyStatus;
  avicExternalId: string | null;
  avicLastSyncedAt: Date | null;
  version: number;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RoutingCompanyInput {
  clientType: RoutingClientType;
  status?: RoutingClientStatus;
  avicExternalId?: string | null;
  individualName?: string | null;
  cpf?: string | null;
  individualEmail?: string | null;
  individualWhatsapp?: string | null;
  individualPhones?: RoutingPhone[];
  legalName?: string | null;
  tradeName?: string | null;
  cnpj?: string | null;
  legalEmail?: string | null;
  legalWhatsapp?: string | null;
  legalPhones?: RoutingPhone[];
  costCenter?: string | null;
}

export function normalizeRoutingClientTaxId(value: string): string {
  const taxId = normalizeTaxId(value);
  if (!isValidCpf(taxId) && !isValidCnpj(taxId)) {
    throw validationError('Informe um CPF ou CNPJ válido para o cliente.');
  }
  return taxId;
}

export function normalizeRoutingPhone(
  value: string,
  required = false,
  validate = true,
): string | null {
  const digits = value.replace(/\D/g, '');
  if (!digits) {
    if (required) throw validationError('Informe o WhatsApp.');
    return null;
  }
  const normalized = digits.startsWith('55') ? digits : `55${digits}`;
  if (validate && !/^55\d{10,11}$/.test(normalized)) {
    throw validationError('Informe um número de WhatsApp válido.');
  }
  return normalized;
}

function optionalEmail(value?: string | null, validate = true): string | null {
  const email = value?.trim().toLocaleLowerCase('pt-BR') || null;
  if (validate && email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw validationError('Informe um e-mail válido.');
  }
  return email;
}

function normalizePhones(
  values?: RoutingPhone[],
  validate = true,
): RoutingPhone[] {
  return (values ?? []).flatMap((item) => {
    const number = normalizeRoutingPhone(item.number, false, validate);
    if (!number) {
      if (validate) throw validationError('Informe o número do telefone.');
      return [];
    }
    return [{ number, description: item.description?.trim() || null }];
  });
}

export function normalizeRoutingCompanyInput(input: RoutingCompanyInput) {
  if (!ROUTING_CLIENT_TYPES.includes(input.clientType)) {
    throw validationError('Selecione o tipo de cliente.');
  }
  if (input.status && !ROUTING_CLIENT_STATUSES.includes(input.status)) {
    throw validationError('Selecione uma situação válida para o cliente.');
  }
  const validateIndividual = input.clientType === 'pf';
  const validateLegal = input.clientType === 'pj';
  const cpf = normalizeTaxId(input.cpf ?? '') || null;
  const cnpj = normalizeTaxId(input.cnpj ?? '') || null;
  if (validateIndividual && cpf && !isValidCpf(cpf))
    throw validationError('CPF inválido.');
  if (validateLegal && cnpj && !isValidCnpj(cnpj))
    throw validationError('CNPJ inválido.');
  const legalName = input.legalName?.trim() || null;
  if (input.clientType === 'pj' && !legalName)
    throw validationError('Informe a razão social.');
  if (input.clientType === 'pj' && !cnpj)
    throw validationError('Informe o CNPJ.');
  return {
    clientType: input.clientType,
    status: input.status ?? 'active',
    avicExternalId: input.avicExternalId?.trim() || null,
    individualName: input.individualName?.trim() || null,
    cpf,
    individualEmail: optionalEmail(input.individualEmail, validateIndividual),
    individualWhatsapp: normalizeRoutingPhone(
      input.individualWhatsapp ?? '',
      validateIndividual,
      validateIndividual,
    ),
    individualPhones: normalizePhones(
      input.individualPhones,
      validateIndividual,
    ),
    legalName,
    tradeName: input.tradeName?.trim() || null,
    cnpj,
    legalEmail: optionalEmail(input.legalEmail, validateLegal),
    legalWhatsapp: normalizeRoutingPhone(
      input.legalWhatsapp ?? '',
      false,
      validateLegal,
    ),
    legalPhones: normalizePhones(input.legalPhones, validateLegal),
    costCenter: input.costCenter?.trim() || null,
  };
}

export function createRoutingCompany(
  input: RoutingCompanyInput & { companyId: string; actorUserId?: string },
): RoutingCompanyProps {
  const normalized = normalizeRoutingCompanyInput(input);
  const id = randomUUID();
  const displayName =
    normalized.clientType === 'pf'
      ? normalized.individualName ||
        normalized.individualWhatsapp ||
        'Cliente pessoa física'
      : normalized.legalName!;
  const activeTaxId =
    normalized.clientType === 'pf'
      ? (normalized.cpf ?? `pf${id.replace(/-/g, '').slice(0, 12)}`)
      : normalized.cnpj!;
  const now = new Date();
  return {
    id,
    companyId: input.companyId,
    taxId: activeTaxId,
    ...normalized,
    legalName: normalized.legalName ?? displayName,
    avicLastSyncedAt: null,
    version: 1,
    createdByUserId: input.actorUserId ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

import { validationError } from '../../core/errors/app-error';
import { isValidCnpj } from '../../shared/utils/brazilian-documents';
import { normalizeTaxId } from '../../shared/utils/normalization';

export type CompanyStatus = 'ACTIVE' | 'SUSPENDED';

export interface CompanyProps {
  id: string;
  legalName: string;
  tradeName: string | null;
  taxId: string;
  status: CompanyStatus;
  createdAt: Date;
  updatedAt: Date;
}

export class Company {
  private constructor(public readonly props: CompanyProps) {}

  static create(input: {
    id: string;
    legalName: string;
    tradeName?: string;
    taxId: string;
  }): Company {
    const taxId = normalizeTaxId(input.taxId);
    if (!isValidCnpj(taxId)) {
      throw validationError('Informe um CNPJ válido para a empresa.');
    }
    const now = new Date();
    return new Company({
      id: input.id,
      legalName: input.legalName.trim(),
      tradeName: input.tradeName?.trim() || null,
      taxId,
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: CompanyProps): Company {
    return new Company(props);
  }

  get id(): string {
    return this.props.id;
  }
}

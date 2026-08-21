import { Inject, Injectable, Optional } from '@nestjs/common';

import { onlyDigits } from '../../shared/utils/normalization';

export interface PostalCodeLookupResult {
  street: string;
  district: string;
  city: string;
  state: string;
}

type Fetcher = typeof fetch;

export const POSTAL_CODE_FETCHER = Symbol('POSTAL_CODE_FETCHER');

@Injectable()
export class PostalCodeLookupService {
  private readonly fetcher: Fetcher;
  private readonly cache = new Map<
    string,
    Promise<PostalCodeLookupResult | null>
  >();

  constructor(
    @Optional()
    @Inject(POSTAL_CODE_FETCHER)
    fetcher?: Fetcher,
  ) {
    this.fetcher = fetcher ?? fetch;
  }

  lookup(value: string): Promise<PostalCodeLookupResult | null> {
    const postalCode = onlyDigits(value);
    if (postalCode.length !== 8) return Promise.resolve(null);
    const cached = this.cache.get(postalCode);
    if (cached) return cached;
    const request = this.request(postalCode);
    this.cache.set(postalCode, request);
    return request;
  }

  private async request(
    postalCode: string,
  ): Promise<PostalCodeLookupResult | null> {
    try {
      const response = await this.fetcher(
        `https://viacep.com.br/ws/${postalCode}/json/`,
        {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(4_000),
        },
      );
      if (!response.ok) return null;
      const result = (await response.json()) as {
        erro?: boolean;
        logradouro?: string;
        bairro?: string;
        localidade?: string;
        uf?: string;
      };
      if (
        result.erro ||
        !result.logradouro?.trim() ||
        !result.bairro?.trim() ||
        !result.localidade?.trim() ||
        !result.uf?.trim()
      ) {
        return null;
      }
      return {
        street: result.logradouro.trim(),
        district: result.bairro.trim(),
        city: result.localidade.trim(),
        state: result.uf.trim().toUpperCase(),
      };
    } catch {
      return null;
    }
  }
}

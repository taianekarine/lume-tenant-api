import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { PostalCodeLookupService } from './postal-code-lookup.service';

describe('PostalCodeLookupService', () => {
  it('resolves through the Nest container without a custom fetcher', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [PostalCodeLookupService],
    }).compile();

    expect(moduleRef.get(PostalCodeLookupService)).toBeInstanceOf(
      PostalCodeLookupService,
    );
    await moduleRef.close();
  });

  it('uses ViaCEP once and reuses the normalized postal code result', async () => {
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            logradouro: 'Praça da Sé',
            bairro: 'Sé',
            localidade: 'São Paulo',
            uf: 'sp',
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;
    const service = new PostalCodeLookupService(fetcher);

    const first = await service.lookup('01001-000');
    const second = await service.lookup('01001000');

    expect(first).toEqual({
      street: 'Praça da Sé',
      district: 'Sé',
      city: 'São Paulo',
      state: 'SP',
    });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      'https://viacep.com.br/ws/01001000/json/',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('returns null for malformed or unknown postal codes', async () => {
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ erro: true }), { status: 200 }),
      ),
    ) as unknown as typeof fetch;
    const service = new PostalCodeLookupService(fetcher);

    await expect(service.lookup('123')).resolves.toBeNull();
    await expect(service.lookup('99999999')).resolves.toBeNull();
  });
});

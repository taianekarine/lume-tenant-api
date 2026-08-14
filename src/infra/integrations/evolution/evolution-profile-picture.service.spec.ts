import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EvolutionProfilePictureService,
  extractEvolutionProfilePictureUrl,
} from './evolution-profile-picture.service';

describe('EvolutionProfilePictureService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('extrai somente URLs HTTP seguras dos formatos conhecidos', () => {
    expect(
      extractEvolutionProfilePictureUrl({
        data: { profilePictureUrl: 'https://cdn.example.test/customer.jpg' },
      }),
    ).toBe('https://cdn.example.test/customer.jpg');
    expect(
      extractEvolutionProfilePictureUrl({ picture: 'file:///segredo' }),
    ).toBeUndefined();
  });

  it('consulta a Evolution e reutiliza o resultado em cache', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        profilePictureUrl: 'https://cdn.example.test/customer.jpg',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const service = new EvolutionProfilePictureService(
      new ConfigService({
        EVOLUTION_BASE_URL: 'https://evolution.example.test/',
        EVOLUTION_API_KEY: 'secret',
        EVOLUTION_PROFILE_PICTURE_TIMEOUT_MS: 5_000,
      }),
    );

    await expect(service.get('principal', '5534999999999')).resolves.toBe(
      'https://cdn.example.test/customer.jpg',
    );
    await expect(service.get('principal', '5534999999999')).resolves.toBe(
      'https://cdn.example.test/customer.jpg',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://evolution.example.test/chat/fetchProfilePictureUrl/principal',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ number: '5534999999999' }),
      }),
    );
  });

  it('não interrompe o webhook quando a foto não pode ser consultada', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
    );
    const service = new EvolutionProfilePictureService(
      new ConfigService({
        EVOLUTION_BASE_URL: 'https://evolution.example.test',
        EVOLUTION_API_KEY: 'secret',
      }),
    );

    await expect(
      service.get('principal', '5534999999999'),
    ).resolves.toBeUndefined();
  });
});

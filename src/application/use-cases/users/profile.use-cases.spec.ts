import { describe, expect, it } from 'vitest';

import { Company } from '../../../domain/entities/company';
import { User } from '../../../domain/entities/user';
import {
  InMemoryStore,
  InMemoryUsersRepository,
} from '../../../../test/fakes/in-memory';
import { UpdateProfilePictureUseCase } from './profile.use-cases';

function pngHeader(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function setup() {
  const store = new InMemoryStore();
  const company = Company.create({
    id: '00000000-0000-4000-8000-000000000010',
    legalName: 'Empresa Teste',
    taxId: '11222333000181',
  });
  const user = User.create({
    companyId: company.id,
    name: 'Ana Souza',
    username: 'ana.souza',
    usernameNormalized: 'ana.souza',
    email: 'ana@example.test',
    emailNormalized: 'ana@example.test',
    cpfNormalized: null,
    passwordHash: 'hashed:SenhaInicial@2026',
    departments: ['commercial'],
  });
  store.companies.push(company);
  store.users.push(user);
  return {
    store,
    user,
    useCase: new UpdateProfilePictureUseCase(
      new InMemoryUsersRepository(store),
    ),
  };
}

describe('UpdateProfilePictureUseCase', () => {
  it('accepts a structurally valid image within byte and dimension limits', async () => {
    const { useCase, user } = setup();

    await expect(
      useCase.execute({
        companyId: user.companyId,
        userId: user.id,
        dataUrl: dataUrl('image/png', pngHeader(128, 2048)),
      }),
    ).resolves.toMatchObject({
      id: user.id,
      profilePictureDataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    });
  });

  it('rejects forged MIME types and dimensions outside 128–2048 px', async () => {
    const { useCase, user } = setup();
    const base = { companyId: user.companyId, userId: user.id };

    await expect(
      useCase.execute({
        ...base,
        dataUrl: dataUrl('image/jpeg', pngHeader(128, 128)),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      useCase.execute({
        ...base,
        dataUrl: dataUrl('image/png', pngHeader(127, 128)),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      useCase.execute({
        ...base,
        dataUrl: dataUrl('image/png', pngHeader(128, 2049)),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects decoded images larger than 512 KB', async () => {
    const { useCase, user } = setup();

    await expect(
      useCase.execute({
        companyId: user.companyId,
        userId: user.id,
        dataUrl: dataUrl('image/png', new Uint8Array(512 * 1024 + 1)),
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'A foto de perfil deve possuir no máximo 512 KB.',
    });
  });
});

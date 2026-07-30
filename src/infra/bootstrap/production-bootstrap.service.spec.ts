import { describe, expect, it } from 'vitest';

import { FakePasswordHasher } from '../../../test/fakes/in-memory';
import { stillUsesBootstrapPassword } from './production-bootstrap.service';

describe('production bootstrap password policy', () => {
  it('requires first access only while the stored hash still matches the bootstrap password', async () => {
    const passwordHasher = new FakePasswordHasher();
    const initialPassword = 'SenhaInicial@2026';

    await expect(
      stillUsesBootstrapPassword(
        passwordHasher,
        initialPassword,
        await passwordHasher.hash(initialPassword),
      ),
    ).resolves.toBe(true);
    await expect(
      stillUsesBootstrapPassword(
        passwordHasher,
        initialPassword,
        await passwordHasher.hash('SenhaJaAlterada@2026'),
      ),
    ).resolves.toBe(false);
    await expect(
      stillUsesBootstrapPassword(
        passwordHasher,
        '',
        await passwordHasher.hash(initialPassword),
      ),
    ).resolves.toBe(false);
  });
});

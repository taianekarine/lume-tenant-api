import { generateKeyPairSync, sign } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { OfflineLicensePayload } from '../../application/contracts/cryptography';
import { Ed25519OfflineLicenseVerifier } from './ed25519-offline-license-verifier';

function fixture(overrides: Partial<OfflineLicensePayload> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const payload: OfflineLicensePayload = {
    version: 1,
    licenseId: '00000000-0000-4000-8000-000000000001',
    installationId: '00000000-0000-4000-8000-000000000002',
    tenantId: '00000000-0000-4000-8000-000000000003',
    plan: 'standard',
    features: ['users'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    graceUntil: '2027-02-01T00:00:00.000Z',
    ...overrides,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(encoded), privateKey).toString(
    'base64url',
  );
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  return new ConfigService({
    INSTALLATION_ID: payload.installationId,
    LICENSE_PUBLIC_KEY_BASE64: Buffer.from(publicPem).toString('base64'),
    LICENSE_DOCUMENT: `${encoded}.${signature}`,
  });
}

describe('Ed25519OfflineLicenseVerifier', () => {
  it('validates the document without contacting the control plane', () => {
    const verifier = new Ed25519OfflineLicenseVerifier(fixture());
    expect(verifier.status(new Date('2026-06-01'))).toMatchObject({
      state: 'active',
      payload: { plan: 'standard' },
    });
    expect(verifier.status(new Date('2027-01-15')).state).toBe('grace');
  });

  it('rejects operation after the local grace period', () => {
    const verifier = new Ed25519OfflineLicenseVerifier(fixture());
    expect(() => verifier.status(new Date('2027-03-01'))).toThrow(
      'período de tolerância',
    );
  });

  it('rejects a document bound to another installation', () => {
    const config = fixture();
    config.set('INSTALLATION_ID', '00000000-0000-4000-8000-000000000099');
    expect(() => new Ed25519OfflineLicenseVerifier(config)).toThrow(
      'outra instalação',
    );
  });
});

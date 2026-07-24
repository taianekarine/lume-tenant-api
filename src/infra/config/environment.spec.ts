import { describe, expect, it } from 'vitest';

import { validateEnvironment } from './environment';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://lume:lume@localhost:5432/lume_tenant',
  JWT_ACCESS_SECRET: 'tenant-secret-with-at-least-32-characters',
  INSTALLATION_ID: '00000000-0000-4000-8000-000000000002',
  LICENSE_PUBLIC_KEY_BASE64: 'a'.repeat(64),
  LICENSE_DOCUMENT: 'payload.signature-with-enough-characters',
};

describe('validateEnvironment', () => {
  it('normalizes defaults required by an autonomous tenant', () => {
    expect(validateEnvironment(validEnvironment)).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3333,
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_DAYS: 7,
      JWT_REFRESH_REMEMBER_TTL_DAYS: 30,
      INSTALLATION_ID: validEnvironment.INSTALLATION_ID,
      SWAGGER_ENABLED: true,
    });
  });

  it('rejects a non-PostgreSQL database', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        DATABASE_URL: 'mysql://localhost/database',
      }),
    ).toThrow('PostgreSQL');
  });

  it('requires the local installation identity and signed license', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        INSTALLATION_ID: '',
      }),
    ).toThrow('INSTALLATION_ID');
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        LICENSE_DOCUMENT: '',
      }),
    ).toThrow('LICENSE_DOCUMENT');
  });

  it('rejects a short tenant JWT secret', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        JWT_ACCESS_SECRET: 'short',
      }),
    ).toThrow('JWT_ACCESS_SECRET');
  });

  it('rejects wildcard CORS in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        CORS_ORIGINS: '*',
      }),
    ).toThrow('CORS_ORIGINS');
  });

  it('parses explicit production switches', () => {
    expect(
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.com',
        SWAGGER_ENABLED: 'false',
        TRUST_PROXY_HOPS: '1',
      }),
    ).toMatchObject({
      SWAGGER_ENABLED: false,
      TRUST_PROXY_HOPS: 1,
    });
  });
});

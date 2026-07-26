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

  it('requires WhatsApp credentials only when the module is enabled', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        WHATSAPP_ENABLED: 'true',
      }),
    ).toThrow('EVOLUTION_WEBHOOK_SECRET');

    expect(
      validateEnvironment({
        ...validEnvironment,
        WHATSAPP_ENABLED: 'true',
        WHATSAPP_CHANNEL_ID: '00000000-0000-4000-8000-000000000221',
        WHATSAPP_CHANNEL_NAME: 'WhatsApp principal',
        WHATSAPP_PHONE_NUMBER: '5511999999999',
        EVOLUTION_PROVIDER_NAME: 'Evolution API',
        EVOLUTION_BASE_URL: 'https://evolution.example.test',
        EVOLUTION_INSTANCE_NAME: 'lume',
        EVOLUTION_API_KEY: 'evolution-key-with-16-characters',
        EVOLUTION_WEBHOOK_SECRET: 'evolution-secret-with-32-characters',
        N8N_SERVICE_KEY_ID: '00000000-0000-4000-8000-000000000222',
        N8N_SERVICE_SECRET: 'n8n-service-secret-with-32-characters',
        N8N_DISPATCH_ENABLED: 'false',
      }),
    ).toMatchObject({
      WHATSAPP_ENABLED: true,
      N8N_DISPATCH_ENABLED: false,
      WHATSAPP_RETENTION_DAYS: 365,
      INTEGRATION_RETENTION_DAYS: 90,
    });
  });

  it('exige HTTPS do n8n em produção salvo opt-in para rede privada', () => {
    const productionWhatsApp = {
      ...validEnvironment,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.com',
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_CHANNEL_ID: '00000000-0000-4000-8000-000000000221',
      WHATSAPP_CHANNEL_NAME: 'WhatsApp principal',
      WHATSAPP_PHONE_NUMBER: '5511999999999',
      EVOLUTION_PROVIDER_NAME: 'Evolution API',
      EVOLUTION_BASE_URL: 'https://evolution.example.test',
      EVOLUTION_INSTANCE_NAME: 'lume',
      EVOLUTION_API_KEY: 'evolution-key-with-16-characters',
      EVOLUTION_WEBHOOK_SECRET: 'evolution-secret-with-32-characters',
      N8N_SERVICE_KEY_ID: '00000000-0000-4000-8000-000000000222',
      N8N_SERVICE_SECRET: 'n8n-service-secret-with-32-characters',
      N8N_DISPATCH_ENABLED: 'true',
      N8N_OUTBOUND_SECRET: 'n8n-outbound-secret-with-32-characters',
    };
    expect(() =>
      validateEnvironment({
        ...productionWhatsApp,
        N8N_WEBHOOK_URL: 'http://n8n:5678/webhook/lume',
      }),
    ).toThrow('HTTPS');
    expect(
      validateEnvironment({
        ...productionWhatsApp,
        N8N_WEBHOOK_URL: 'http://n8n:5678/webhook/lume',
        N8N_ALLOW_INSECURE_PRIVATE_URL: 'true',
      }),
    ).toMatchObject({
      N8N_ALLOW_INSECURE_PRIVATE_URL: true,
      N8N_WEBHOOK_URL: 'http://n8n:5678/webhook/lume',
    });
    expect(() =>
      validateEnvironment({
        ...productionWhatsApp,
        N8N_WEBHOOK_URL: 'http://public.example.com/webhook/lume',
        N8N_ALLOW_INSECURE_PRIVATE_URL: 'true',
      }),
    ).toThrow('host privado');
  });
});

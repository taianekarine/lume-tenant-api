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
const productionEmailEnvironment = {
  EMAIL_DELIVERY_ENABLED: 'true',
  RESEND_API_KEY: 're_test_key_with_enough_characters',
  RESEND_FROM_EMAIL: 'no-reply@example.test',
  RESEND_FROM_NAME: 'Lume',
};

describe('validateEnvironment', () => {
  it('normalizes defaults required by an autonomous tenant', () => {
    expect(validateEnvironment(validEnvironment)).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3333,
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_DAYS: 7,
      JWT_REFRESH_REMEMBER_TTL_DAYS: 30,
      HTTP_MAX_JSON_BODY_BYTES: 1_048_576,
      PASSWORD_RESET_MIN_RESPONSE_MS: 750,
      INSTALLATION_ID: validEnvironment.INSTALLATION_ID,
      SWAGGER_ENABLED: true,
      SUPPORT_RECIPIENT_EMAIL: 'devops@mileniumturismo.com.br',
      SUPPORT_CC_EMAIL:
        'taiane.karine@mileniumturismo.com.br,taianekas.dev@outlook.com',
    });
  });

  it('normalizes and validates multiple support copy recipients', () => {
    expect(
      validateEnvironment({
        ...validEnvironment,
        SUPPORT_RECIPIENT_EMAIL: 'support@example.com',
        SUPPORT_CC_EMAIL:
          'first@example.com, second@example.com, FIRST@example.com',
      }),
    ).toMatchObject({
      SUPPORT_RECIPIENT_EMAIL: 'support@example.com',
      SUPPORT_CC_EMAIL: 'first@example.com,second@example.com',
    });

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        SUPPORT_CC_EMAIL: 'valid@example.com, invalid-address',
      }),
    ).toThrow('SUPPORT_CC_EMAIL');
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
        ...productionEmailEnvironment,
        SWAGGER_ENABLED: 'false',
        TRUST_PROXY_HOPS: '1',
      }),
    ).toMatchObject({
      SWAGGER_ENABLED: false,
      TRUST_PROXY_HOPS: 1,
    });
  });

  it('requires safe Resend settings when e-mail delivery is enabled', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        EMAIL_DELIVERY_ENABLED: 'true',
      }),
    ).toThrow('RESEND_API_KEY');

    expect(
      validateEnvironment({
        ...validEnvironment,
        EMAIL_DELIVERY_ENABLED: 'true',
        RESEND_API_KEY: 're_test_key_with_enough_characters',
        RESEND_FROM_EMAIL: 'no-reply@example.test',
        RESEND_FROM_NAME: 'Lume',
      }),
    ).toMatchObject({
      EMAIL_DELIVERY_ENABLED: true,
      RESEND_API_URL: 'https://api.resend.com',
      RESEND_FROM_EMAIL: 'no-reply@example.test',
      RESEND_REQUEST_TIMEOUT_MS: 10_000,
      RESEND_MAX_ATTEMPTS: 2,
      RESEND_RETRY_DELAY_MS: 150,
    });
  });

  it('requires e-mail delivery in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.com',
        EMAIL_DELIVERY_ENABLED: 'false',
      }),
    ).toThrow('EMAIL_DELIVERY_ENABLED deve ser true');
  });

  it('rejects the Resend sandbox sender in production', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.com',
        ...productionEmailEnvironment,
        RESEND_FROM_EMAIL: 'onboarding@resend.dev',
      }),
    ).toThrow('domínio verificado no Resend');
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
      ...productionEmailEnvironment,
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

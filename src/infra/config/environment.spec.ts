import { resolve } from 'node:path';

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
const validWhatsAppEnvironment = {
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_CHANNEL_ID: '00000000-0000-4000-8000-000000000221',
  WHATSAPP_CHANNEL_NAME: 'WhatsApp principal',
  WHATSAPP_PHONE_NUMBER: '5511999999999',
  EVOLUTION_PROVIDER_NAME: 'Evolution API',
  EVOLUTION_BASE_URL: 'https://evolution.example.test',
  EVOLUTION_INSTANCE_NAME: 'lume',
  EVOLUTION_API_KEY: 'evolution-key-with-16-characters',
  EVOLUTION_WEBHOOK_SECRET: 'evolution-secret-with-32-characters',
  WHATSAPP_AI_OPENAI_API_KEY: 'openai-key-with-at-least-20-characters',
  MILENIUM_DIRECTOR_PHONE: '5534999999900',
  MILENIUM_DEPARTMENT_PURCHASES_PHONE: '5534999999901',
  MILENIUM_DEPARTMENT_CONTROLLING_PHONE: '5534999999902',
  MILENIUM_DEPARTMENT_DP_PHONE: '5534999999903',
  MILENIUM_DEPARTMENT_FINANCE_PHONE: '5534999999904',
  MILENIUM_DEPARTMENT_MANAGEMENT_PHONE: '5534999999905',
  MILENIUM_DEPARTMENT_MAINTENANCE_PHONE: '5534999999906',
  MILENIUM_DEPARTMENT_MONITORING_PHONE: '5534999999907',
  MILENIUM_DEPARTMENT_OPERATIONAL_PHONE: '5534999999908',
};
const apiProviderEnvironment = validWhatsAppEnvironment;
const absoluteWhatsappMediaStoragePath = resolve('var', 'whatsapp-media-test');

describe('validateEnvironment', () => {
  it('normalizes defaults required by an autonomous tenant', () => {
    expect(validateEnvironment(validEnvironment)).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3333,
      DATABASE_TRANSACTION_MAX_WAIT_MS: 15_000,
      DATABASE_TRANSACTION_TIMEOUT_MS: 60_000,
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_DAYS: 7,
      JWT_REFRESH_REMEMBER_TTL_DAYS: 30,
      HTTP_MAX_JSON_BODY_BYTES: 1_048_576,
      WHATSAPP_PANEL_MAX_ATTACHMENT_BYTES: 104_857_600,
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

  it('rejects invalid database transaction limits', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        DATABASE_TRANSACTION_MAX_WAIT_MS: '0',
      }),
    ).toThrow('DATABASE_TRANSACTION_MAX_WAIT_MS');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        DATABASE_TRANSACTION_TIMEOUT_MS: '-1',
      }),
    ).toThrow('DATABASE_TRANSACTION_TIMEOUT_MS');
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
    ).toThrow('WHATSAPP_AI_PROVIDER_ORDER');

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
        WHATSAPP_AI_OPENAI_API_KEY: 'openai-key-with-at-least-20-characters',
        MILENIUM_DIRECTOR_PHONE: '5534999999900',
        MILENIUM_DEPARTMENT_PURCHASES_PHONE: '5534999999901',
        MILENIUM_DEPARTMENT_CONTROLLING_PHONE: '5534999999902',
        MILENIUM_DEPARTMENT_DP_PHONE: '5534999999903',
        MILENIUM_DEPARTMENT_FINANCE_PHONE: '5534999999904',
        MILENIUM_DEPARTMENT_MANAGEMENT_PHONE: '5534999999905',
        MILENIUM_DEPARTMENT_MAINTENANCE_PHONE: '5534999999906',
        MILENIUM_DEPARTMENT_MONITORING_PHONE: '5534999999907',
        MILENIUM_DEPARTMENT_OPERATIONAL_PHONE: '5534999999908',
      }),
    ).toMatchObject({
      WHATSAPP_ENABLED: true,
      WHATSAPP_MEDIA_STORAGE_DRIVER: 'filesystem',
      WHATSAPP_RETENTION_DAYS: 365,
      INTEGRATION_RETENTION_DAYS: 90,
    });
  });

  it('ativa somente a automação própria da API quando o WhatsApp está habilitado', () => {
    expect(
      validateEnvironment({
        ...validEnvironment,
        ...validWhatsAppEnvironment,
      }),
    ).toMatchObject({
      WHATSAPP_AI_PROVIDER_ORDER: 'openai,cerebras,gemini,groq',
      WHATSAPP_API_EXECUTION_TIMEOUT_MS: 480_000,
      EVOLUTION_SEND_TEXT_TIMEOUT_MS: 10_000,
      EVOLUTION_SEND_MEDIA_TIMEOUT_MS: 30_000,
    });
  });

  it('rejeita configuração incompleta da automação própria', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        ...apiProviderEnvironment,
        WHATSAPP_AI_OPENAI_API_KEY: '',
      }),
    ).toThrow('chave de ao menos um provedor');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        ...apiProviderEnvironment,
        MILENIUM_DIRECTOR_PHONE: '',
      }),
    ).toThrow('Diretoria e os oito departamentos');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        ...apiProviderEnvironment,
        WHATSAPP_API_EXECUTION_TIMEOUT_MS: '120000',
      }),
    ).toThrow('deve ser ao menos');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        ...apiProviderEnvironment,
        WHATSAPP_API_DEPARTMENT_COLLECTION_MS: '300001',
      }),
    ).toThrow('no máximo 300000');
  });

  it('requires the OpenAI key only when document review is enabled and limits retries', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        DOCUMENT_REVIEW_ENABLED: 'true',
        DOCUMENT_REVIEW_PROVIDER: 'openai',
      }),
    ).toThrow('OPENAI_API_KEY');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        OPENAI_DOCUMENT_MAX_ATTEMPTS: '4',
      }),
    ).toThrow('no máximo 3');
  });

  it('exige HTTPS da Evolution em produção', () => {
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
      WHATSAPP_MEDIA_STORAGE_PATH: absoluteWhatsappMediaStoragePath,
      WHATSAPP_AI_OPENAI_API_KEY: 'openai-key-with-at-least-20-characters',
      MILENIUM_DIRECTOR_PHONE: '5534999999900',
      MILENIUM_DEPARTMENT_PURCHASES_PHONE: '5534999999901',
      MILENIUM_DEPARTMENT_CONTROLLING_PHONE: '5534999999902',
      MILENIUM_DEPARTMENT_DP_PHONE: '5534999999903',
      MILENIUM_DEPARTMENT_FINANCE_PHONE: '5534999999904',
      MILENIUM_DEPARTMENT_MANAGEMENT_PHONE: '5534999999905',
      MILENIUM_DEPARTMENT_MAINTENANCE_PHONE: '5534999999906',
      MILENIUM_DEPARTMENT_MONITORING_PHONE: '5534999999907',
      MILENIUM_DEPARTMENT_OPERATIONAL_PHONE: '5534999999908',
    };
    expect(() =>
      validateEnvironment({
        ...productionWhatsApp,
        EVOLUTION_BASE_URL: 'http://public.example.com',
      }),
    ).toThrow('HTTPS');
    expect(
      validateEnvironment({
        ...productionWhatsApp,
        EVOLUTION_BASE_URL: 'https://evolution.example.test',
      }),
    ).toMatchObject({
      EVOLUTION_BASE_URL: 'https://evolution.example.test',
    });
  });

  it('exige armazenamento persistente absoluto para WhatsApp em produção', () => {
    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        NODE_ENV: 'production',
        CORS_ORIGINS: 'https://app.example.com',
        ...productionEmailEnvironment,
        ...validWhatsAppEnvironment,
      }),
    ).toThrow('WHATSAPP_MEDIA_STORAGE_PATH');

    expect(() =>
      validateEnvironment({
        ...validEnvironment,
        ...validWhatsAppEnvironment,
        WHATSAPP_MEDIA_STORAGE_PATH: './temporario',
      }),
    ).toThrow('caminho absoluto');
  });
});

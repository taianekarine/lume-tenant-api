import { isAbsolute, resolve } from 'node:path';

type RawEnvironment = Record<string, unknown>;

function requiredString(
  config: RawEnvironment,
  key: string,
  minimumLength = 1,
): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim().length < minimumLength) {
    throw new Error(
      `${key} deve possuir ao menos ${minimumLength} caracteres.`,
    );
  }
  return value.trim();
}

function positiveInteger(
  config: RawEnvironment,
  key: string,
  fallback: number,
): number {
  const value = Number(config[key] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} deve ser um número inteiro positivo.`);
  }
  return value;
}

function nonNegativeInteger(
  config: RawEnvironment,
  key: string,
  fallback: number,
): number {
  const value = Number(config[key] ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} deve ser um número inteiro não negativo.`);
  }
  return value;
}

function booleanValue(
  config: RawEnvironment,
  key: string,
  fallback: boolean,
): boolean {
  const value = config[key] ?? fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${key} deve ser true ou false.`);
}

function optionalString(
  config: RawEnvironment,
  key: string,
  fallback = '',
): string {
  const value = config[key] ?? fallback;
  if (typeof value !== 'string') {
    throw new Error(`${key} deve ser uma string.`);
  }
  return value.trim();
}

function commaSeparatedValues(
  config: RawEnvironment,
  key: string,
  fallback: string,
): string[] {
  const values = optionalString(config, key, fallback)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new Error(
      `${key} deve possuir valores únicos separados por vírgula.`,
    );
  }
  return values;
}

function emailAddress(
  config: RawEnvironment,
  key: string,
  required: boolean,
): string {
  const value = optionalString(config, key);
  if (!value && !required) return '';
  if (
    !value ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  ) {
    throw new Error(`${key} deve ser um e-mail válido.`);
  }
  return value;
}

function emailAddressList(
  config: RawEnvironment,
  key: string,
  required: boolean,
): string[] {
  const value = optionalString(config, key);
  if (!value && !required) return [];
  const addresses = value
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  if (
    addresses.length === 0 ||
    addresses.some(
      (address) =>
        address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address),
    )
  ) {
    throw new Error(
      `${key} deve conter uma lista de e-mails válidos separada por vírgulas.`,
    );
  }
  const seen = new Set<string>();
  return addresses.filter((address) => {
    const normalized = address.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function httpUrl(
  config: RawEnvironment,
  key: string,
  required: boolean,
): string {
  const value = optionalString(config, key);
  if (!value && !required) return '';
  if (!value) throw new Error(`${key} é obrigatório.`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} deve ser uma URL válida.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${key} deve usar HTTP ou HTTPS.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function uuidString(
  config: RawEnvironment,
  key: string,
  required: boolean,
): string {
  const value = optionalString(config, key);
  if (!value && !required) return '';
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`${key} deve ser um UUID válido.`);
  }
  return value;
}

export function parseCorsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function validateEnvironment(config: RawEnvironment): RawEnvironment {
  const rawNodeEnv = config.NODE_ENV ?? 'development';
  if (typeof rawNodeEnv !== 'string') {
    throw new Error('NODE_ENV deve ser uma string.');
  }
  const nodeEnv = rawNodeEnv;
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV deve ser development, test ou production.');
  }
  const databaseUrl = requiredString(config, 'DATABASE_URL');
  if (!['postgresql:', 'postgres:'].includes(new URL(databaseUrl).protocol)) {
    throw new Error('DATABASE_URL deve apontar para PostgreSQL.');
  }
  const bcryptRounds = positiveInteger(config, 'BCRYPT_ROUNDS', 12);
  if (bcryptRounds < 10 || bcryptRounds > 15) {
    throw new Error('BCRYPT_ROUNDS deve estar entre 10 e 15.');
  }
  const rawCors = config.CORS_ORIGINS ?? 'http://localhost:3000';
  if (typeof rawCors !== 'string') {
    throw new Error('CORS_ORIGINS deve ser uma string.');
  }
  const cors = rawCors;
  if (
    nodeEnv === 'production' &&
    (parseCorsOrigins(cors).length === 0 || cors.includes('*'))
  ) {
    throw new Error('CORS_ORIGINS deve ser explícito em produção.');
  }
  const jwtSecret = requiredString(config, 'JWT_ACCESS_SECRET', 32);
  if (
    nodeEnv === 'production' &&
    jwtSecret.toLowerCase().includes('replace-with')
  ) {
    throw new Error('Substitua JWT_ACCESS_SECRET em produção.');
  }
  const whatsappEnabled = booleanValue(config, 'WHATSAPP_ENABLED', false);
  const whatsappMediaStorageDriver = optionalString(
    config,
    'WHATSAPP_MEDIA_STORAGE_DRIVER',
    'filesystem',
  ).toLowerCase();
  if (whatsappMediaStorageDriver !== 'filesystem') {
    throw new Error(
      'WHATSAPP_MEDIA_STORAGE_DRIVER aceita somente filesystem nesta versão.',
    );
  }
  const configuredWhatsappMediaStoragePath = optionalString(
    config,
    'WHATSAPP_MEDIA_STORAGE_PATH',
  );
  if (
    nodeEnv === 'production' &&
    whatsappEnabled &&
    !configuredWhatsappMediaStoragePath
  ) {
    throw new Error(
      'WHATSAPP_MEDIA_STORAGE_PATH é obrigatório em produção quando o WhatsApp está habilitado.',
    );
  }
  if (
    configuredWhatsappMediaStoragePath &&
    !isAbsolute(configuredWhatsappMediaStoragePath)
  ) {
    throw new Error(
      'WHATSAPP_MEDIA_STORAGE_PATH deve ser um caminho absoluto.',
    );
  }
  const whatsappMediaStoragePath = resolve(
    configuredWhatsappMediaStoragePath || './var/whatsapp-media',
  );
  const documentReviewEnabled = booleanValue(
    config,
    'DOCUMENT_REVIEW_ENABLED',
    false,
  );
  const documentReviewProvider = optionalString(
    config,
    'DOCUMENT_REVIEW_PROVIDER',
    'local',
  );
  if (!['local', 'openai'].includes(documentReviewProvider)) {
    throw new Error('DOCUMENT_REVIEW_PROVIDER deve ser local ou openai.');
  }
  const openAiApiKey =
    documentReviewEnabled && documentReviewProvider === 'openai'
      ? requiredString(config, 'OPENAI_API_KEY', 20)
      : optionalString(config, 'OPENAI_API_KEY');
  const openAiDocumentMaxAttempts = positiveInteger(
    config,
    'OPENAI_DOCUMENT_MAX_ATTEMPTS',
    3,
  );
  if (openAiDocumentMaxAttempts > 3) {
    throw new Error('OPENAI_DOCUMENT_MAX_ATTEMPTS deve ser no máximo 3.');
  }
  const dataExchangeMaxFileBytes = positiveInteger(
    config,
    'DATA_EXCHANGE_MAX_FILE_BYTES',
    25 * 1024 * 1024,
  );
  if (dataExchangeMaxFileBytes > 50 * 1024 * 1024) {
    throw new Error(
      'DATA_EXCHANGE_MAX_FILE_BYTES não pode ultrapassar 52428800 bytes.',
    );
  }
  const dataExchangeMaxTenantBytes = positiveInteger(
    config,
    'DATA_EXCHANGE_MAX_TENANT_BYTES',
    250 * 1024 * 1024,
  );
  if (dataExchangeMaxTenantBytes < dataExchangeMaxFileBytes) {
    throw new Error(
      'DATA_EXCHANGE_MAX_TENANT_BYTES deve ser maior ou igual a DATA_EXCHANGE_MAX_FILE_BYTES.',
    );
  }
  if (dataExchangeMaxTenantBytes > 2 * 1024 * 1024 * 1024) {
    throw new Error(
      'DATA_EXCHANGE_MAX_TENANT_BYTES não pode ultrapassar 2147483648 bytes.',
    );
  }
  const apiAutomationEnabled = whatsappEnabled;
  const whatsappAiProviderOrder = commaSeparatedValues(
    config,
    'WHATSAPP_AI_PROVIDER_ORDER',
    'openai,cerebras,gemini,groq',
  );
  const supportedWhatsappAiProviders = new Set([
    'openai',
    'cerebras',
    'gemini',
    'groq',
  ]);
  if (
    whatsappAiProviderOrder.some(
      (provider) => !supportedWhatsappAiProviders.has(provider),
    )
  ) {
    throw new Error(
      'WHATSAPP_AI_PROVIDER_ORDER aceita apenas openai, cerebras, gemini e groq.',
    );
  }
  const whatsappAiOpenAiApiKey = optionalString(
    {
      ...config,
      WHATSAPP_AI_OPENAI_API_KEY:
        config.WHATSAPP_AI_OPENAI_API_KEY ?? config.OPENAI_API_KEY ?? '',
    },
    'WHATSAPP_AI_OPENAI_API_KEY',
  );
  const whatsappAiProviderKeys = {
    openai: whatsappAiOpenAiApiKey,
    cerebras: optionalString(config, 'WHATSAPP_AI_CEREBRAS_API_KEY'),
    gemini: optionalString(config, 'WHATSAPP_AI_GEMINI_API_KEY'),
    groq: optionalString(config, 'WHATSAPP_AI_GROQ_API_KEY'),
  };
  if (
    apiAutomationEnabled &&
    !whatsappAiProviderOrder.some(
      (provider) =>
        whatsappAiProviderKeys[provider as keyof typeof whatsappAiProviderKeys],
    )
  ) {
    throw new Error(
      'WHATSAPP_ENABLED=true exige a chave de ao menos um provedor em WHATSAPP_AI_PROVIDER_ORDER.',
    );
  }
  const evolutionWebhookSecret = whatsappEnabled
    ? requiredString(config, 'EVOLUTION_WEBHOOK_SECRET', 32)
    : optionalString(config, 'EVOLUTION_WEBHOOK_SECRET');
  const evolutionBaseUrl = httpUrl(
    config,
    'EVOLUTION_BASE_URL',
    whatsappEnabled,
  );
  if (
    nodeEnv === 'production' &&
    whatsappEnabled &&
    new URL(evolutionBaseUrl).protocol !== 'https:'
  ) {
    throw new Error('EVOLUTION_BASE_URL deve usar HTTPS em produção.');
  }
  const evolutionSendTextPayloadMode = optionalString(
    config,
    'EVOLUTION_SEND_TEXT_PAYLOAD_MODE',
    'number-text',
  );
  if (
    !['number-text', 'legacy-text', 'textMessage'].includes(
      evolutionSendTextPayloadMode,
    )
  ) {
    throw new Error(
      'EVOLUTION_SEND_TEXT_PAYLOAD_MODE deve ser number-text, legacy-text ou textMessage.',
    );
  }
  const whatsappAiRequestTimeoutMs = positiveInteger(
    config,
    'WHATSAPP_AI_REQUEST_TIMEOUT_MS',
    90_000,
  );
  const evolutionSendTextTimeoutMs = positiveInteger(
    config,
    'EVOLUTION_SEND_TEXT_TIMEOUT_MS',
    10_000,
  );
  const evolutionSendMediaTimeoutMs = positiveInteger(
    config,
    'EVOLUTION_SEND_MEDIA_TIMEOUT_MS',
    30_000,
  );
  const whatsappApiExecutionTimeoutMs = positiveInteger(
    config,
    'WHATSAPP_API_EXECUTION_TIMEOUT_MS',
    480_000,
  );
  const whatsappApiDebounceMs = positiveInteger(
    config,
    'WHATSAPP_API_DEBOUNCE_MS',
    2_000,
  );
  const whatsappApiDepartmentCollectionMs = positiveInteger(
    config,
    'WHATSAPP_API_DEPARTMENT_COLLECTION_MS',
    120_000,
  );
  if (
    whatsappApiDebounceMs > 300_000 ||
    whatsappApiDepartmentCollectionMs > 300_000
  ) {
    throw new Error(
      'As janelas WHATSAPP_API_*_MS devem ser de no máximo 300000 milissegundos.',
    );
  }
  const configuredAiProviderCount = whatsappAiProviderOrder.filter(
    (provider) =>
      whatsappAiProviderKeys[provider as keyof typeof whatsappAiProviderKeys],
  ).length;
  const minimumApiExecutionTimeoutMs =
    whatsappAiRequestTimeoutMs * configuredAiProviderCount +
    Math.max(evolutionSendTextTimeoutMs, evolutionSendMediaTimeoutMs) +
    30_000;
  if (
    apiAutomationEnabled &&
    whatsappApiExecutionTimeoutMs < minimumApiExecutionTimeoutMs
  ) {
    throw new Error(
      `WHATSAPP_API_EXECUTION_TIMEOUT_MS deve ser ao menos ${minimumApiExecutionTimeoutMs} para cobrir os provedores de IA configurados e o envio.`,
    );
  }
  const departmentPhoneKeys = [
    'MILENIUM_DIRECTOR_PHONE',
    'MILENIUM_DEPARTMENT_PURCHASES_PHONE',
    'MILENIUM_DEPARTMENT_CONTROLLING_PHONE',
    'MILENIUM_DEPARTMENT_DP_PHONE',
    'MILENIUM_DEPARTMENT_FINANCE_PHONE',
    'MILENIUM_DEPARTMENT_MANAGEMENT_PHONE',
    'MILENIUM_DEPARTMENT_MAINTENANCE_PHONE',
    'MILENIUM_DEPARTMENT_MONITORING_PHONE',
    'MILENIUM_DEPARTMENT_OPERATIONAL_PHONE',
  ] as const;
  const departmentPhones = Object.fromEntries(
    departmentPhoneKeys.map((key) => [
      key,
      optionalString(config, key).replace(/\D/g, ''),
    ]),
  ) as Record<(typeof departmentPhoneKeys)[number], string>;
  if (
    apiAutomationEnabled &&
    departmentPhoneKeys.some(
      (key) => !/^\d{10,15}$/.test(departmentPhones[key]),
    )
  ) {
    throw new Error(
      'WHATSAPP_ENABLED=true exige telefones válidos para a Diretoria e os oito departamentos.',
    );
  }
  const emailDeliveryEnabled = booleanValue(
    config,
    'EMAIL_DELIVERY_ENABLED',
    false,
  );
  if (nodeEnv === 'production' && !emailDeliveryEnabled) {
    throw new Error('EMAIL_DELIVERY_ENABLED deve ser true em produção.');
  }
  const resendApiKey = emailDeliveryEnabled
    ? requiredString(config, 'RESEND_API_KEY', 20)
    : optionalString(config, 'RESEND_API_KEY');
  const resendFromEmail = emailDeliveryEnabled
    ? emailAddress(config, 'RESEND_FROM_EMAIL', true)
    : emailAddress(
        {
          ...config,
          RESEND_FROM_EMAIL:
            config.RESEND_FROM_EMAIL ?? 'no-reply@localhost.invalid',
        },
        'RESEND_FROM_EMAIL',
        true,
      );
  const resendFromName = optionalString(config, 'RESEND_FROM_NAME', 'Lume');
  if (resendFromName.length < 2 || /[\r\n]/.test(resendFromName)) {
    throw new Error('RESEND_FROM_NAME deve possuir ao menos 2 caracteres.');
  }
  const resendApiUrl = httpUrl(
    {
      ...config,
      RESEND_API_URL: config.RESEND_API_URL ?? 'https://api.resend.com',
    },
    'RESEND_API_URL',
    true,
  );
  const supportRecipientEmail = emailAddress(
    {
      ...config,
      SUPPORT_RECIPIENT_EMAIL:
        optionalString(config, 'SUPPORT_RECIPIENT_EMAIL') ||
        'devops@mileniumturismo.com.br',
    },
    'SUPPORT_RECIPIENT_EMAIL',
    true,
  );
  const supportCcEmails = emailAddressList(
    {
      ...config,
      SUPPORT_CC_EMAIL:
        optionalString(config, 'SUPPORT_CC_EMAIL') ||
        [
          'taiane.karine@mileniumturismo.com.br',
          'taianekas.dev@outlook.com',
        ].join(','),
    },
    'SUPPORT_CC_EMAIL',
    true,
  );
  const resendMaxAttempts = positiveInteger(config, 'RESEND_MAX_ATTEMPTS', 2);
  if (resendMaxAttempts > 3) {
    throw new Error('RESEND_MAX_ATTEMPTS deve estar entre 1 e 3.');
  }
  const passwordResetUrlBase = httpUrl(
    {
      ...config,
      PASSWORD_RESET_URL_BASE:
        config.PASSWORD_RESET_URL_BASE ??
        `${parseCorsOrigins(cors)[0] ?? 'http://localhost:3000'}/reset-password`,
    },
    'PASSWORD_RESET_URL_BASE',
    true,
  );
  if (
    nodeEnv === 'production' &&
    new URL(passwordResetUrlBase).protocol !== 'https:'
  ) {
    throw new Error('PASSWORD_RESET_URL_BASE deve usar HTTPS em produção.');
  }
  if (nodeEnv === 'production' && new URL(resendApiUrl).protocol !== 'https:') {
    throw new Error('RESEND_API_URL deve usar HTTPS em produção.');
  }
  if (
    nodeEnv === 'production' &&
    emailDeliveryEnabled &&
    resendApiKey.toLowerCase().includes('replace-with')
  ) {
    throw new Error('Substitua RESEND_API_KEY em produção.');
  }
  if (
    nodeEnv === 'production' &&
    emailDeliveryEnabled &&
    resendFromEmail.toLowerCase() === 'onboarding@resend.dev'
  ) {
    throw new Error(
      'RESEND_FROM_EMAIL deve usar um domínio verificado no Resend em produção.',
    );
  }
  if (
    nodeEnv === 'production' &&
    whatsappEnabled &&
    [evolutionWebhookSecret, optionalString(config, 'EVOLUTION_API_KEY')].some(
      (secret) => secret.toLowerCase().includes('replace-with'),
    )
  ) {
    throw new Error('Substitua os segredos de WhatsApp em produção.');
  }
  if (
    nodeEnv === 'production' &&
    apiAutomationEnabled &&
    Object.values(whatsappAiProviderKeys).some((secret) =>
      secret.toLowerCase().includes('replace-with'),
    )
  ) {
    throw new Error('Substitua os segredos da IA do WhatsApp em produção.');
  }

  return {
    ...config,
    NODE_ENV: nodeEnv,
    DATABASE_URL: databaseUrl,
    DATABASE_TRANSACTION_MAX_WAIT_MS: positiveInteger(
      config,
      'DATABASE_TRANSACTION_MAX_WAIT_MS',
      15_000,
    ),
    DATABASE_TRANSACTION_TIMEOUT_MS: positiveInteger(
      config,
      'DATABASE_TRANSACTION_TIMEOUT_MS',
      60_000,
    ),
    PORT: positiveInteger(config, 'PORT', 3333),
    JWT_ACCESS_SECRET: jwtSecret,
    JWT_ACCESS_TTL_SECONDS: positiveInteger(
      config,
      'JWT_ACCESS_TTL_SECONDS',
      900,
    ),
    JWT_REFRESH_TTL_DAYS: positiveInteger(config, 'JWT_REFRESH_TTL_DAYS', 7),
    JWT_REFRESH_REMEMBER_TTL_DAYS: positiveInteger(
      config,
      'JWT_REFRESH_REMEMBER_TTL_DAYS',
      30,
    ),
    INSTALLATION_ID: requiredString(config, 'INSTALLATION_ID', 36),
    LICENSE_PUBLIC_KEY_BASE64: requiredString(
      config,
      'LICENSE_PUBLIC_KEY_BASE64',
      32,
    ),
    LICENSE_DOCUMENT: requiredString(config, 'LICENSE_DOCUMENT', 32),
    BCRYPT_ROUNDS: bcryptRounds,
    PASSWORD_CHANGE_TOKEN_TTL_MINUTES: positiveInteger(
      config,
      'PASSWORD_CHANGE_TOKEN_TTL_MINUTES',
      30,
    ),
    PASSWORD_HISTORY_LIMIT: positiveInteger(
      config,
      'PASSWORD_HISTORY_LIMIT',
      10,
    ),
    PASSWORD_RESET_URL_BASE: passwordResetUrlBase,
    PASSWORD_RESET_MIN_RESPONSE_MS: nonNegativeInteger(
      config,
      'PASSWORD_RESET_MIN_RESPONSE_MS',
      750,
    ),
    EMAIL_DELIVERY_ENABLED: emailDeliveryEnabled,
    RESEND_API_KEY: resendApiKey,
    RESEND_FROM_EMAIL: resendFromEmail,
    RESEND_FROM_NAME: resendFromName,
    RESEND_API_URL: resendApiUrl,
    SUPPORT_RECIPIENT_EMAIL: supportRecipientEmail,
    SUPPORT_CC_EMAIL: supportCcEmails.join(','),
    RESEND_REQUEST_TIMEOUT_MS: positiveInteger(
      config,
      'RESEND_REQUEST_TIMEOUT_MS',
      10_000,
    ),
    RESEND_MAX_ATTEMPTS: resendMaxAttempts,
    RESEND_RETRY_DELAY_MS: nonNegativeInteger(
      config,
      'RESEND_RETRY_DELAY_MS',
      150,
    ),
    CORS_ORIGINS: cors,
    SWAGGER_ENABLED: booleanValue(
      config,
      'SWAGGER_ENABLED',
      nodeEnv !== 'production',
    ),
    TRUST_PROXY_HOPS: nonNegativeInteger(config, 'TRUST_PROXY_HOPS', 0),
    RATE_LIMIT_TTL_MS: positiveInteger(config, 'RATE_LIMIT_TTL_MS', 60_000),
    RATE_LIMIT_MAX: positiveInteger(config, 'RATE_LIMIT_MAX', 100),
    HTTP_MAX_JSON_BODY_BYTES: positiveInteger(
      config,
      'HTTP_MAX_JSON_BODY_BYTES',
      1_048_576,
    ),
    API_USAGE_RETENTION_DAYS: positiveInteger(
      config,
      'API_USAGE_RETENTION_DAYS',
      90,
    ),
    DOCUMENT_REVIEW_ENABLED: documentReviewEnabled,
    DOCUMENT_REVIEW_PROVIDER: documentReviewProvider,
    OPENAI_API_KEY: openAiApiKey,
    OPENAI_DOCUMENT_MODEL: optionalString(
      config,
      'OPENAI_DOCUMENT_MODEL',
      'gpt-5.6-terra',
    ),
    OPENAI_DOCUMENT_TIMEOUT_MS: positiveInteger(
      config,
      'OPENAI_DOCUMENT_TIMEOUT_MS',
      90_000,
    ),
    OPENAI_DOCUMENT_MAX_ATTEMPTS: openAiDocumentMaxAttempts,
    OPENAI_API_BASE_URL: httpUrl(
      {
        ...config,
        OPENAI_API_BASE_URL:
          config.OPENAI_API_BASE_URL ?? 'https://api.openai.com/v1',
      },
      'OPENAI_API_BASE_URL',
      true,
    ),
    WHATSAPP_ENABLED: whatsappEnabled,
    WHATSAPP_MEDIA_STORAGE_DRIVER: whatsappMediaStorageDriver,
    WHATSAPP_MEDIA_STORAGE_PATH: whatsappMediaStoragePath,
    WHATSAPP_API_DISPATCH_INTERVAL_MS: positiveInteger(
      config,
      'WHATSAPP_API_DISPATCH_INTERVAL_MS',
      500,
    ),
    WHATSAPP_API_REQUEST_TIMEOUT_MS: positiveInteger(
      config,
      'WHATSAPP_API_REQUEST_TIMEOUT_MS',
      10_000,
    ),
    WHATSAPP_API_EXECUTION_TIMEOUT_MS: whatsappApiExecutionTimeoutMs,
    WHATSAPP_API_DISPATCH_BATCH_SIZE: positiveInteger(
      config,
      'WHATSAPP_API_DISPATCH_BATCH_SIZE',
      20,
    ),
    WHATSAPP_API_RETRY_BASE_DELAY_MS: positiveInteger(
      config,
      'WHATSAPP_API_RETRY_BASE_DELAY_MS',
      500,
    ),
    WHATSAPP_API_RETRY_MAX_DELAY_MS: positiveInteger(
      config,
      'WHATSAPP_API_RETRY_MAX_DELAY_MS',
      300_000,
    ),
    WHATSAPP_API_DEBOUNCE_MS: whatsappApiDebounceMs,
    WHATSAPP_API_DEPARTMENT_COLLECTION_MS: whatsappApiDepartmentCollectionMs,
    WHATSAPP_CHANNEL_ID: uuidString(
      config,
      'WHATSAPP_CHANNEL_ID',
      whatsappEnabled,
    ),
    WHATSAPP_CHANNEL_NAME: whatsappEnabled
      ? requiredString(config, 'WHATSAPP_CHANNEL_NAME', 2)
      : optionalString(config, 'WHATSAPP_CHANNEL_NAME', 'WhatsApp principal'),
    WHATSAPP_PHONE_NUMBER: whatsappEnabled
      ? requiredString(config, 'WHATSAPP_PHONE_NUMBER', 10)
      : optionalString(config, 'WHATSAPP_PHONE_NUMBER'),
    WHATSAPP_IGNORE_GROUPS: booleanValue(
      config,
      'WHATSAPP_IGNORE_GROUPS',
      true,
    ),
    WHATSAPP_IGNORE_FROM_ME: booleanValue(
      config,
      'WHATSAPP_IGNORE_FROM_ME',
      true,
    ),
    WHATSAPP_MAX_WEBHOOK_BYTES: positiveInteger(
      config,
      'WHATSAPP_MAX_WEBHOOK_BYTES',
      262_144,
    ),
    WHATSAPP_MAX_ATTACHMENT_BYTES: positiveInteger(
      config,
      'WHATSAPP_MAX_ATTACHMENT_BYTES',
      52_428_800,
    ),
    WHATSAPP_PANEL_MAX_ATTACHMENT_BYTES: positiveInteger(
      config,
      'WHATSAPP_PANEL_MAX_ATTACHMENT_BYTES',
      104_857_600,
    ),
    WHATSAPP_ALLOWED_MIME_TYPES: optionalString(
      config,
      'WHATSAPP_ALLOWED_MIME_TYPES',
      'image/jpeg,image/png,image/webp,image/gif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv,text/vcard,text/x-vcard,application/octet-stream,audio/ogg,audio/mpeg,audio/mp4,audio/aac,audio/wav,video/mp4,video/webm,video/quicktime',
    ),
    WHATSAPP_RETENTION_DAYS: positiveInteger(
      config,
      'WHATSAPP_RETENTION_DAYS',
      365,
    ),
    INTEGRATION_RETENTION_DAYS: positiveInteger(
      config,
      'INTEGRATION_RETENTION_DAYS',
      90,
    ),
    RETENTION_JOB_ENABLED: booleanValue(
      config,
      'RETENTION_JOB_ENABLED',
      nodeEnv !== 'test',
    ),
    EVOLUTION_PROVIDER_NAME: whatsappEnabled
      ? requiredString(config, 'EVOLUTION_PROVIDER_NAME', 2)
      : optionalString(config, 'EVOLUTION_PROVIDER_NAME', 'Evolution API'),
    EVOLUTION_BASE_URL: evolutionBaseUrl,
    EVOLUTION_INSTANCE_NAME: whatsappEnabled
      ? requiredString(config, 'EVOLUTION_INSTANCE_NAME', 2)
      : optionalString(config, 'EVOLUTION_INSTANCE_NAME'),
    EVOLUTION_API_KEY: whatsappEnabled
      ? requiredString(config, 'EVOLUTION_API_KEY', 16)
      : optionalString(config, 'EVOLUTION_API_KEY'),
    EVOLUTION_SEND_TEXT_PAYLOAD_MODE: evolutionSendTextPayloadMode,
    EVOLUTION_SEND_TEXT_TIMEOUT_MS: evolutionSendTextTimeoutMs,
    EVOLUTION_SEND_MEDIA_TIMEOUT_MS: evolutionSendMediaTimeoutMs,
    EVOLUTION_MEDIA_CONTENT_TIMEOUT_MS: positiveInteger(
      config,
      'EVOLUTION_MEDIA_CONTENT_TIMEOUT_MS',
      30_000,
    ),
    EVOLUTION_WEBHOOK_SECRET: evolutionWebhookSecret,
    WEBHOOK_MAX_SKEW_MS: positiveInteger(
      config,
      'WEBHOOK_MAX_SKEW_MS',
      300_000,
    ),
    WEBHOOK_MAX_EVENT_AGE_MS: positiveInteger(
      config,
      'WEBHOOK_MAX_EVENT_AGE_MS',
      604_800_000,
    ),
    EVOLUTION_DISPATCH_LEASE_MS: positiveInteger(
      config,
      'EVOLUTION_DISPATCH_LEASE_MS',
      90_000,
    ),
    WHATSAPP_FOLLOW_UP_INACTIVITY_MS: positiveInteger(
      config,
      'WHATSAPP_FOLLOW_UP_INACTIVITY_MS',
      1_800_000,
    ),
    WHATSAPP_PREVENT_CLOSE_WITH_APPROVED_QUOTE: booleanValue(
      config,
      'WHATSAPP_PREVENT_CLOSE_WITH_APPROVED_QUOTE',
      false,
    ),
    WHATSAPP_AI_PROVIDER_ORDER: whatsappAiProviderOrder.join(','),
    WHATSAPP_AI_REQUEST_TIMEOUT_MS: whatsappAiRequestTimeoutMs,
    WHATSAPP_AI_OPENAI_API_KEY: whatsappAiProviderKeys.openai,
    WHATSAPP_AI_OPENAI_BASE_URL: httpUrl(
      {
        ...config,
        WHATSAPP_AI_OPENAI_BASE_URL:
          config.WHATSAPP_AI_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      },
      'WHATSAPP_AI_OPENAI_BASE_URL',
      true,
    ),
    WHATSAPP_AI_OPENAI_MODEL: optionalString(
      config,
      'WHATSAPP_AI_OPENAI_MODEL',
      'gpt-5.5',
    ),
    WHATSAPP_AI_CEREBRAS_API_KEY: whatsappAiProviderKeys.cerebras,
    WHATSAPP_AI_CEREBRAS_BASE_URL: httpUrl(
      {
        ...config,
        WHATSAPP_AI_CEREBRAS_BASE_URL:
          config.WHATSAPP_AI_CEREBRAS_BASE_URL ?? 'https://api.cerebras.ai/v1',
      },
      'WHATSAPP_AI_CEREBRAS_BASE_URL',
      true,
    ),
    WHATSAPP_AI_CEREBRAS_MODEL: optionalString(
      config,
      'WHATSAPP_AI_CEREBRAS_MODEL',
      'gpt-oss-120b',
    ),
    WHATSAPP_AI_GEMINI_API_KEY: whatsappAiProviderKeys.gemini,
    WHATSAPP_AI_GEMINI_BASE_URL: httpUrl(
      {
        ...config,
        WHATSAPP_AI_GEMINI_BASE_URL:
          config.WHATSAPP_AI_GEMINI_BASE_URL ??
          'https://generativelanguage.googleapis.com/v1beta/openai',
      },
      'WHATSAPP_AI_GEMINI_BASE_URL',
      true,
    ),
    WHATSAPP_AI_GEMINI_MODEL: optionalString(
      config,
      'WHATSAPP_AI_GEMINI_MODEL',
      'gemini-2.5-flash',
    ),
    WHATSAPP_AI_GROQ_API_KEY: whatsappAiProviderKeys.groq,
    WHATSAPP_AI_GROQ_BASE_URL: httpUrl(
      {
        ...config,
        WHATSAPP_AI_GROQ_BASE_URL:
          config.WHATSAPP_AI_GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
      },
      'WHATSAPP_AI_GROQ_BASE_URL',
      true,
    ),
    WHATSAPP_AI_GROQ_MODEL: optionalString(
      config,
      'WHATSAPP_AI_GROQ_MODEL',
      'llama-3.3-70b-versatile',
    ),
    ...departmentPhones,
    DATA_EXCHANGE_MAX_FILE_BYTES: dataExchangeMaxFileBytes,
    DATA_EXCHANGE_MAX_TENANT_BYTES: dataExchangeMaxTenantBytes,
    DATA_EXCHANGE_RETENTION_DAYS: positiveInteger(
      config,
      'DATA_EXCHANGE_RETENTION_DAYS',
      30,
    ),
  };
}

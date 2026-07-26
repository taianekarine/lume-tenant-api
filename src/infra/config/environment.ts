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

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.local') ||
    !normalized.includes('.')
  ) {
    return true;
  }
  const match = /^172\.(\d{1,2})\./.exec(normalized);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
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
  const n8nDispatchEnabled = booleanValue(
    config,
    'N8N_DISPATCH_ENABLED',
    whatsappEnabled,
  );
  const evolutionWebhookSecret = whatsappEnabled
    ? requiredString(config, 'EVOLUTION_WEBHOOK_SECRET', 32)
    : optionalString(config, 'EVOLUTION_WEBHOOK_SECRET');
  const n8nServiceSecret = whatsappEnabled
    ? requiredString(config, 'N8N_SERVICE_SECRET', 32)
    : optionalString(config, 'N8N_SERVICE_SECRET');
  const n8nOutboundSecret = n8nDispatchEnabled
    ? requiredString(config, 'N8N_OUTBOUND_SECRET', 32)
    : optionalString(config, 'N8N_OUTBOUND_SECRET');
  const allowInsecurePrivateN8n = booleanValue(
    config,
    'N8N_ALLOW_INSECURE_PRIVATE_URL',
    false,
  );
  const n8nWebhookUrl = httpUrl(config, 'N8N_WEBHOOK_URL', n8nDispatchEnabled);
  if (
    nodeEnv === 'production' &&
    n8nDispatchEnabled &&
    new URL(n8nWebhookUrl).protocol !== 'https:' &&
    (!allowInsecurePrivateN8n ||
      !isPrivateHostname(new URL(n8nWebhookUrl).hostname))
  ) {
    throw new Error(
      'N8N_WEBHOOK_URL deve usar HTTPS em produção; HTTP exige N8N_ALLOW_INSECURE_PRIVATE_URL=true e host privado.',
    );
  }
  if (
    nodeEnv === 'production' &&
    whatsappEnabled &&
    [
      evolutionWebhookSecret,
      n8nServiceSecret,
      n8nOutboundSecret,
      optionalString(config, 'EVOLUTION_API_KEY'),
    ].some((secret) => secret.toLowerCase().includes('replace-with'))
  ) {
    throw new Error('Substitua os segredos de WhatsApp em produção.');
  }

  return {
    ...config,
    NODE_ENV: nodeEnv,
    DATABASE_URL: databaseUrl,
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
    CORS_ORIGINS: cors,
    SWAGGER_ENABLED: booleanValue(
      config,
      'SWAGGER_ENABLED',
      nodeEnv !== 'production',
    ),
    TRUST_PROXY_HOPS: nonNegativeInteger(config, 'TRUST_PROXY_HOPS', 0),
    RATE_LIMIT_TTL_MS: positiveInteger(config, 'RATE_LIMIT_TTL_MS', 60_000),
    RATE_LIMIT_MAX: positiveInteger(config, 'RATE_LIMIT_MAX', 100),
    WHATSAPP_ENABLED: whatsappEnabled,
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
      10_485_760,
    ),
    WHATSAPP_ALLOWED_MIME_TYPES: optionalString(
      config,
      'WHATSAPP_ALLOWED_MIME_TYPES',
      'image/jpeg,image/png,application/pdf,audio/ogg,video/mp4',
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
    EVOLUTION_BASE_URL: httpUrl(config, 'EVOLUTION_BASE_URL', whatsappEnabled),
    EVOLUTION_INSTANCE_NAME: whatsappEnabled
      ? requiredString(config, 'EVOLUTION_INSTANCE_NAME', 2)
      : optionalString(config, 'EVOLUTION_INSTANCE_NAME'),
    EVOLUTION_API_KEY: whatsappEnabled
      ? requiredString(config, 'EVOLUTION_API_KEY', 16)
      : optionalString(config, 'EVOLUTION_API_KEY'),
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
    N8N_SERVICE_KEY_ID: uuidString(
      config,
      'N8N_SERVICE_KEY_ID',
      whatsappEnabled,
    ),
    N8N_SERVICE_NAME: optionalString(
      config,
      'N8N_SERVICE_NAME',
      'n8n WhatsApp',
    ),
    N8N_SERVICE_SECRET: n8nServiceSecret,
    N8N_DISPATCH_ENABLED: n8nDispatchEnabled,
    N8N_WEBHOOK_URL: n8nWebhookUrl,
    N8N_ALLOW_INSECURE_PRIVATE_URL: allowInsecurePrivateN8n,
    N8N_OUTBOUND_SECRET: n8nOutboundSecret,
    N8N_DISPATCH_INTERVAL_MS: positiveInteger(
      config,
      'N8N_DISPATCH_INTERVAL_MS',
      1_000,
    ),
    N8N_REQUEST_TIMEOUT_MS: positiveInteger(
      config,
      'N8N_REQUEST_TIMEOUT_MS',
      10_000,
    ),
    N8N_EXECUTION_TIMEOUT_MS: positiveInteger(
      config,
      'N8N_EXECUTION_TIMEOUT_MS',
      300_000,
    ),
    N8N_RETRY_BASE_DELAY_MS: positiveInteger(
      config,
      'N8N_RETRY_BASE_DELAY_MS',
      1_000,
    ),
    N8N_RETRY_MAX_DELAY_MS: positiveInteger(
      config,
      'N8N_RETRY_MAX_DELAY_MS',
      300_000,
    ),
    N8N_DISPATCH_BATCH_SIZE: positiveInteger(
      config,
      'N8N_DISPATCH_BATCH_SIZE',
      20,
    ),
  };
}

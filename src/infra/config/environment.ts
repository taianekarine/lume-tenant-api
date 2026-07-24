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
  };
}

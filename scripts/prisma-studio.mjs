import 'dotenv/config';

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL é obrigatória para abrir o Prisma Studio. Configure o .env local primeiro.',
  );
}

let parsedDatabaseUrl;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  throw new Error('DATABASE_URL não é uma URL PostgreSQL válida.');
}

if (!['postgresql:', 'postgres:'].includes(parsedDatabaseUrl.protocol)) {
  throw new Error('O Prisma Studio desta aplicação aceita apenas PostgreSQL.');
}

const normalizedHost = parsedDatabaseUrl.hostname.toLowerCase();
const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
const isLocalDatabase = localHosts.has(normalizedHost);
const isProduction = process.env.NODE_ENV === 'production';
const databaseName = parsedDatabaseUrl.pathname.replace(/^\/+/, '');
const expectedConfirmation = `${normalizedHost}/${databaseName}`;
const confirmedTarget = process.env.PRISMA_STUDIO_CONFIRM_TARGET?.trim();

if (
  !isLocalDatabase &&
  (process.env.PRISMA_STUDIO_ALLOW_REMOTE !== 'true' ||
    confirmedTarget !== expectedConfirmation)
) {
  throw new Error(
    'Prisma Studio bloqueou um banco remoto. Confirme o ambiente e use PRISMA_STUDIO_ALLOW_REMOTE=true somente em uma estação administrativa protegida.',
  );
}

if (
  isProduction &&
  (process.env.PRISMA_STUDIO_ALLOW_PRODUCTION !== 'true' ||
    confirmedTarget !== expectedConfirmation)
) {
  throw new Error(
    'Prisma Studio fica bloqueado em NODE_ENV=production. Use PRISMA_STUDIO_ALLOW_PRODUCTION=true apenas durante uma janela administrativa autorizada.',
  );
}

const port = Number(process.env.PRISMA_STUDIO_PORT ?? 5555);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PRISMA_STUDIO_PORT deve estar entre 1024 e 65535.');
}

const prismaCli = fileURLToPath(
  new URL('../node_modules/prisma/build/index.js', import.meta.url),
);
const child = spawn(
  process.execPath,
  [
    prismaCli,
    'studio',
    '--config=./prisma.config.ts',
    '--port',
    String(port),
    '--browser',
    'none',
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, BROWSER: 'none' },
    stdio: 'inherit',
  },
);

child.on('error', (error) => {
  console.error('Não foi possível iniciar o Prisma Studio:', error.message);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Prisma Studio foi encerrado pelo sinal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});

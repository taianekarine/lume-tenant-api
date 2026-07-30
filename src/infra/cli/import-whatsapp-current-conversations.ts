import 'dotenv/config';

import { basename, dirname, resolve } from 'node:path';

import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../database/prisma/prisma.service';
import { WhatsAppImportService } from '../imports/whatsapp-import.service';

type Command = 'validate' | 'apply' | 'reconcile' | 'rollback';

const FLAG_ALIASES: Record<string, string> = {
  companyId: 'company-id',
  channelId: 'channel-id',
  actorUsername: 'actor-username',
  batchName: 'batch-name',
  batchId: 'batch-id',
  packagePath: 'package',
  'package-path': 'package',
  workbookPath: 'workbook',
  'workbook-path': 'workbook',
  cutoffAt: 'cutoff-at',
};

const COMMAND_FLAGS: Record<Command, ReadonlySet<string>> = {
  validate: new Set([
    'company-id',
    'channel-id',
    'actor-username',
    'batch-name',
    'package',
    'workbook',
    'cutoff-at',
  ]),
  apply: new Set([
    'company-id',
    'channel-id',
    'actor-username',
    'batch-name',
    'batch-id',
    'package',
    'workbook',
    'cutoff-at',
    'confirm',
  ]),
  reconcile: new Set(['company-id', 'batch-id']),
  rollback: new Set(['company-id', 'batch-id', 'actor-username', 'confirm']),
};

export function parseWhatsAppImportCliArgs(argv: string[]): {
  command: Command;
  values: Map<string, string>;
} {
  const [commandValue, ...tokens] = argv;
  if (
    !['validate', 'apply', 'reconcile', 'rollback'].includes(commandValue ?? '')
  ) {
    throw new Error(
      'Comando inválido. Use validate, apply, reconcile ou rollback.',
    );
  }
  const command = commandValue as Command;
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      throw new Error(`Argumento inválido: ${token}`);
    }
    const separator = token.indexOf('=');
    const rawName = separator > 2 ? token.slice(2, separator) : token.slice(2);
    const name = FLAG_ALIASES[rawName] ?? rawName;
    if (!COMMAND_FLAGS[command].has(name)) {
      throw new Error(`Flag desconhecida para ${command}: --${rawName}`);
    }
    if (values.has(name)) {
      throw new Error(`Flag duplicada: --${rawName}`);
    }
    if (separator > 2) {
      values.set(name, token.slice(separator + 1));
    } else {
      const next = tokens[index + 1];
      if (!next || next.startsWith('--')) {
        throw new Error(`O argumento ${token} exige um valor.`);
      }
      values.set(name, next);
      index += 1;
    }
  }
  return { command, values };
}

function required(values: Map<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = values.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`Argumento obrigatório ausente: --${names[0]}`);
}

function optional(
  values: Map<string, string>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = values.get(name)?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function packageArguments(values: Map<string, string>): {
  packagePath: string;
  workbookPath?: string;
} {
  const packagePath = optional(values, 'package', 'package-path');
  const workbook = optional(values, 'workbook', 'workbook-path');
  if (packagePath && workbook) {
    throw new Error('Informe --package ou --workbook, não ambos.');
  }
  if (workbook) {
    const absoluteWorkbook = resolve(workbook);
    return {
      packagePath: dirname(absoluteWorkbook),
      workbookPath: basename(absoluteWorkbook),
    };
  }
  return { packagePath: resolve(required(values, 'package', 'package-path')) };
}

function parseCutoff(value: string): Date {
  const cutoff = new Date(value);
  if (Number.isNaN(cutoff.getTime()) || !value.endsWith('Z')) {
    throw new Error(
      '--cutoff-at deve ser um instante ISO-8601 explícito em UTC, terminado em Z.',
    );
  }
  return cutoff;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { ok: false, error: 'Falha desconhecida.' };
  }
  const augmented = error as Error & {
    report?: unknown;
    issues?: unknown;
  };
  return {
    ok: false,
    error: error.message,
    ...(augmented.report ? { report: augmented.report } : {}),
    ...(augmented.issues ? { issues: augmented.issues } : {}),
  };
}

export async function runWhatsAppImportCli(
  argv = process.argv.slice(2),
): Promise<unknown> {
  const { command, values } = parseWhatsAppImportCliArgs(argv);
  const prisma = new PrismaService(new ConfigService(process.env));
  await prisma.$connect();
  try {
    const importsRoot =
      process.env.WHATSAPP_IMPORT_ROOT ??
      resolve(process.cwd(), 'var', 'imports', 'whatsapp');
    const service = new WhatsAppImportService(prisma, importsRoot);
    const companyId = required(values, 'company-id', 'companyId');
    if (command === 'reconcile') {
      return service.reconcile(
        companyId,
        required(values, 'batch-id', 'batchId'),
      );
    }
    if (command === 'rollback') {
      return service.rollback({
        companyId,
        batchId: required(values, 'batch-id', 'batchId'),
        actorUsername: required(values, 'actor-username', 'actorUsername'),
        confirmation: required(values, 'confirm'),
      });
    }
    const channelId = required(values, 'channel-id', 'channelId');
    const actorUsername = required(values, 'actor-username', 'actorUsername');
    const batchName = required(values, 'batch-name', 'batchName');
    const packageInput = packageArguments(values);
    if (command === 'validate') {
      return service.validate({
        companyId,
        channelId,
        actorUsername,
        batchName,
        ...packageInput,
        ...(optional(values, 'cutoff-at', 'cutoffAt')
          ? {
              cutoffAt: parseCutoff(optional(values, 'cutoff-at', 'cutoffAt')!),
            }
          : {}),
      });
    }
    const batchId = required(values, 'batch-id', 'batchId');
    return service.apply({
      companyId,
      channelId,
      actorUsername,
      batchName,
      batchId,
      cutoffAt: parseCutoff(required(values, 'cutoff-at', 'cutoffAt')),
      confirmation: required(values, 'confirm'),
      ...packageInput,
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void runWhatsAppImportCli()
    .then((result) => {
      process.stdout.write(
        `${JSON.stringify({ ok: true, result }, null, 2)}\n`,
      );
    })
    .catch((error: unknown) => {
      process.stdout.write(
        `${JSON.stringify(serializeError(error), null, 2)}\n`,
      );
      process.exitCode = 1;
    });
}

import 'dotenv/config';

import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../database/prisma/prisma.service';
import { WhatsAppAndroidMediaImportService } from '../imports/whatsapp-android-media-import.service';
import { FileSystemWhatsAppMediaStorage } from '../storage/file-system-whatsapp-media.storage';

function flags(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--'))
      throw new Error(`Argumento inválido: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`O argumento ${token} exige um valor.`);
    }
    if (values.has(name)) throw new Error(`Flag duplicada: ${token}`);
    values.set(name, value);
    index += 1;
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`Argumento obrigatório ausente: --${name}`);
  return value;
}

export async function runWhatsAppAndroidMediaImport(
  argv = process.argv.slice(2),
): Promise<unknown> {
  const values = flags(argv);
  const allowed = new Set(['company-id', 'batch-id', 'media-root', 'confirm']);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`Flag desconhecida: --${name}`);
  }
  const companyId = required(values, 'company-id');
  const batchId = required(values, 'batch-id');
  if (required(values, 'confirm') !== `ATTACH:${batchId}`) {
    throw new Error(`Confirmação inválida. Use --confirm ATTACH:${batchId}`);
  }
  const config = new ConfigService(process.env);
  const prisma = new PrismaService(config);
  await prisma.$connect();
  try {
    const service = new WhatsAppAndroidMediaImportService(
      prisma,
      new FileSystemWhatsAppMediaStorage(config),
      config,
    );
    return service.attach({
      companyId,
      batchId,
      mediaRoot: required(values, 'media-root'),
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void runWhatsAppAndroidMediaImport()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Falha desconhecida.',
        })}\n`,
      );
      process.exitCode = 1;
    });
}

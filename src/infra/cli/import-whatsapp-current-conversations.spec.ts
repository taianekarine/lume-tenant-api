import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseWhatsAppImportCliArgs } from './import-whatsapp-current-conversations';

describe('WhatsApp import CLI', () => {
  it('rejeita flags desconhecidas em vez de ignorar typo', () => {
    expect(() =>
      parseWhatsAppImportCliArgs(['validate', '--company-idd', 'tenant']),
    ).toThrow('Flag desconhecida');
  });

  it('rejeita flags duplicadas, inclusive por alias', () => {
    expect(() =>
      parseWhatsAppImportCliArgs([
        'reconcile',
        '--company-id',
        'tenant-a',
        '--companyId',
        'tenant-b',
        '--batch-id',
        'batch',
      ]),
    ).toThrow('Flag duplicada');
  });

  it('rejeita flags de apply no validate', () => {
    expect(() =>
      parseWhatsAppImportCliArgs(['validate', '--confirm', 'APPLY:batch']),
    ).toThrow('Flag desconhecida');
  });

  it('não carrega AppModule nem dispatcher no processo de importação', async () => {
    const source = await readFile(
      join(
        process.cwd(),
        'src',
        'infra',
        'cli',
        'import-whatsapp-current-conversations.ts',
      ),
      'utf8',
    );

    expect(source).not.toContain('AppModule');
    expect(source).not.toContain('IntegrationOutboxDispatcher');
    expect(source).toContain('new PrismaService');
  });
});

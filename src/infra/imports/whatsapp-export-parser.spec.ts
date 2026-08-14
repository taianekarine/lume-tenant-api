import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import {
  deterministicWhatsAppExportId,
  parseWhatsAppExportArchive,
} from './whatsapp-export-parser';

async function archive(
  chat: string,
  files: Readonly<Record<string, string | Buffer>> = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('Conversa do WhatsApp com Cliente.txt', chat);
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('parseWhatsAppExportArchive', () => {
  it('preserva mensagens simples, multilinha, emojis e ordem cronológica', async () => {
    const content = await archive(
      [
        '12/08/2026 09:00 - Cliente: Olá 👋',
        'segunda linha com ç e ã',
        '12/08/2026 09:01 - Milenium: Olá! Como posso ajudar?',
      ].join('\n'),
    );

    const result = await parseWhatsAppExportArchive('cliente.zip', content);

    expect(result.messageCount).toBe(2);
    expect(result.messages[0]).toMatchObject({
      senderName: 'Cliente',
      text: 'Olá 👋\nsegunda linha com ç e ã',
      kind: 'text',
    });
    expect(result.messages[0].occurredAt.toISOString()).toBe(
      '2026-08-12T12:00:00.000Z',
    );
    expect(result.messages[1].occurredAt.getTime()).toBeGreaterThan(
      result.messages[0].occurredAt.getTime(),
    );
  });

  it.each([
    ['IMG-20260812-WA0001.jpg', 'image/jpeg', 'image'],
    ['PTT-20260812-WA0001.opus', 'audio/ogg', 'audio'],
    ['documento.pdf', 'application/pdf', 'document'],
    ['contato.vcf', 'text/vcard', 'contact'],
    ['video.mp4', 'video/mp4', 'video'],
    ['figurinha.webp', 'image/webp', 'sticker'],
  ] as const)('identifica o anexo %s', async (fileName, mimeType, kind) => {
    const content = await archive(
      `12/08/2026 09:00 - Cliente: <Mídia oculta>\n${fileName}`,
      { [fileName]: 'conteúdo' },
    );

    const result = await parseWhatsAppExportArchive('cliente.zip', content);

    expect(result.messages[0]).toMatchObject({
      kind,
      attachment: { fileName, mimeType, entryName: fileName },
    });
  });

  it('identifica o formato brasileiro com o nome antes de arquivo anexado', async () => {
    const content = await archive(
      '12/08/2026 09:00 - Cliente: IMG-20260812-WA0001.jpg (arquivo anexado)',
      { 'IMG-20260812-WA0001.jpg': 'conteúdo' },
    );

    const result = await parseWhatsAppExportArchive('cliente.zip', content);

    expect(result.messages[0]).toMatchObject({
      text: null,
      kind: 'image',
      attachment: {
        fileName: 'IMG-20260812-WA0001.jpg',
        entryName: 'IMG-20260812-WA0001.jpg',
      },
    });
  });

  it('preserva mensagens apagadas e mensagens de sistema', async () => {
    const content = await archive(
      [
        '12/08/2026 09:00 - As mensagens são protegidas com criptografia.',
        '12/08/2026 09:01 - Cliente: Mensagem apagada',
      ].join('\n'),
    );

    const result = await parseWhatsAppExportArchive('cliente.zip', content);

    expect(result.messages[0]).toMatchObject({ system: true, kind: 'text' });
    expect(result.messages[1]).toMatchObject({
      system: false,
      kind: 'unknown',
      text: 'Mensagem apagada',
    });
  });

  it('preserva mensagens sem corpo como conteúdo não identificado', async () => {
    const content = await archive(
      [
        '12/08/2026 09:00 - Cliente: ',
        '12/08/2026 09:01 - Cliente: Mensagem seguinte',
      ].join('\n'),
    );

    const result = await parseWhatsAppExportArchive('cliente.zip', content);

    expect(result.messages[0]).toMatchObject({
      senderName: 'Cliente',
      text: null,
      kind: 'unknown',
      attachment: null,
      system: false,
    });
    expect(result.messages[1]).toMatchObject({
      text: 'Mensagem seguinte',
      kind: 'text',
    });
  });

  it('aceita o formato iOS com segundos e horário de doze horas', async () => {
    const content = await archive(
      '[12/08/2026, 9:05:07 PM] Cliente: Boa noite',
    );

    const result = await parseWhatsAppExportArchive('cliente.zip', content);

    expect(result.messages[0].occurredAt.toISOString()).toBe(
      '2026-08-13T00:05:07.000Z',
    );
  });

  it('mantém mensagens iguais como ocorrências diferentes', async () => {
    const content = await archive(
      ['12/08/2026 09:00 - Cliente: Ok', '12/08/2026 09:00 - Cliente: Ok'].join(
        '\n',
      ),
    );

    const result = await parseWhatsAppExportArchive('cliente.zip', content);

    expect(result.messages).toHaveLength(2);
    expect(
      deterministicWhatsAppExportId('conversation', 0, result.messages[0].text),
    ).not.toBe(
      deterministicWhatsAppExportId('conversation', 1, result.messages[1].text),
    );
  });

  it('normaliza mensagens fora de ordem para a sequência cronológica', async () => {
    const content = await archive(
      [
        '12/08/2026 09:05 - Cliente: Segunda',
        '12/08/2026 09:01 - Cliente: Primeira',
      ].join('\n'),
    );

    const result = await parseWhatsAppExportArchive('cliente.zip', content);

    expect(result.messages.map((message) => message.text)).toEqual([
      'Primeira',
      'Segunda',
    ]);
  });

  it('processa grande quantidade de mensagens sem perder registros', async () => {
    const chat = Array.from({ length: 10_000 }, (_, index) => {
      const day = 12 + Math.floor(index / (24 * 60));
      const hour = Math.floor(index / 60) % 24;
      const minute = index % 60;
      return `${String(day).padStart(2, '0')}/08/2026 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} - Cliente: Mensagem ${index}`;
    }).join('\n');

    const result = await parseWhatsAppExportArchive(
      'cliente.zip',
      await archive(chat),
    );

    expect(result.messageCount).toBe(10_000);
    expect(result.messages.at(-1)?.text).toBe('Mensagem 9999');
  });

  it('rejeita conteúdo que não é ZIP e arquivo corrompido', async () => {
    await expect(
      parseWhatsAppExportArchive('cliente.zip', Buffer.from('não é zip')),
    ).rejects.toThrow('backup ZIP válido');

    const valid = await archive('12/08/2026 09:00 - Cliente: Oi');
    await expect(
      parseWhatsAppExportArchive('cliente.zip', valid.subarray(0, 30)),
    ).rejects.toThrow('corrompido');
  });

  it('rejeita ZIP sem histórico e caminhos maliciosos', async () => {
    const empty = new JSZip();
    empty.file('arquivo.pdf', 'pdf');
    await expect(
      parseWhatsAppExportArchive(
        'cliente.zip',
        await empty.generateAsync({ type: 'nodebuffer' }),
      ),
    ).rejects.toThrow('exatamente um arquivo');

    const unsafe = new JSZip();
    unsafe.file('../conversa.txt', '12/08/2026 09:00 - Cliente: Oi');
    await expect(
      parseWhatsAppExportArchive(
        'cliente.zip',
        await unsafe.generateAsync({ type: 'nodebuffer' }),
      ),
    ).rejects.toThrow('caminho de arquivo inseguro');
  });
});

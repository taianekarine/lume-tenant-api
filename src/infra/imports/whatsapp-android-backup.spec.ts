import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectWhatsAppAndroidBackup,
  readWhatsAppAndroidBackup,
  WHATSAPP_ANDROID_BACKUP_SOURCE_SYSTEM,
} from './whatsapp-android-backup';

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lume-android-backup-'));
  roots.push(root);
  const path = join(root, 'msgstore.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE jid (
      _id INTEGER PRIMARY KEY,
      user TEXT,
      server TEXT
    );
    CREATE TABLE jid_map (
      lid_row_id INTEGER PRIMARY KEY,
      jid_row_id INTEGER
    );
    CREATE TABLE chat (
      _id INTEGER PRIMARY KEY,
      jid_row_id INTEGER
    );
    CREATE TABLE message (
      _id INTEGER PRIMARY KEY,
      chat_row_id INTEGER,
      from_me INTEGER,
      key_id TEXT,
      status INTEGER,
      timestamp INTEGER,
      message_type INTEGER,
      text_data TEXT
    );
    CREATE TABLE message_media (
      message_row_id INTEGER PRIMARY KEY,
      chat_row_id INTEGER,
      file_path TEXT,
      file_size INTEGER,
      mime_type TEXT,
      media_name TEXT,
      media_caption TEXT
    );
    INSERT INTO jid VALUES
      (1, '5534999999999', 's.whatsapp.net'),
      (2, '120363000000', 'g.us'),
      (3, 'status', 'broadcast');
    INSERT INTO chat VALUES (10, 1), (20, 2), (30, 3);
    INSERT INTO message VALUES
      (100, 10, 0, 'inbound-1', 4, 1700000000000, 0, 'Olá'),
      (101, 10, 1, 'outbound-1', 4, 1700000010000, 1, NULL),
      (200, 20, 0, 'group-1', 4, 1700000020000, 0, 'Grupo'),
      (300, 30, 0, 'status-1', 4, 1700000030000, 0, 'Status');
    INSERT INTO message_media VALUES
      (101, 10, 'Media/WhatsApp Images/foto.jpg', 1234, 'image/jpeg', 'foto.jpg', 'Foto');
  `);
  db.close();
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('WhatsApp Android backup reader', () => {
  it('reports direct conversations and exclusions without exposing content', async () => {
    const summary = inspectWhatsAppAndroidBackup(await fixture());

    expect(summary).toMatchObject({
      directConversations: 1,
      directMessages: 2,
      mediaReferences: 1,
      groupConversationsExcluded: 1,
      groupMessagesExcluded: 1,
      otherConversationsExcluded: 1,
      otherMessagesExcluded: 1,
      unmappedDirectConversations: 0,
    });
  });

  it('merges messages by phone and retains unavailable media references', async () => {
    const rows = [
      ...readWhatsAppAndroidBackup(await fixture(), {
        departmentCode: 'commercial',
        state: 'closed',
      }),
    ];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.parsed).toMatchObject({
      sourceSystem: WHATSAPP_ANDROID_BACKUP_SOURCE_SYSTEM,
      suggestedPhoneE164: '5534999999999',
      messageCount: 2,
      attachmentCount: 1,
      missingAttachmentCount: 1,
    });
    expect(rows[0]?.parsed.messages[0]).toMatchObject({
      outbound: false,
      text: 'Olá',
      kind: 'text',
    });
    expect(rows[0]?.parsed.messages[1]).toMatchObject({
      outbound: true,
      kind: 'image',
      attachment: {
        fileName: 'foto.jpg',
        mimeType: 'image/jpeg',
        reference:
          'whatsapp-android-media://Media%2FWhatsApp%20Images%2Ffoto.jpg',
      },
    });
    expect(rows[0]?.mapping).toMatchObject({
      phoneE164: '5534999999999',
      state: 'closed',
      departmentCode: 'commercial',
    });
  });

  it('reads interactive message text from optional WhatsApp UI elements', async () => {
    const path = await fixture();
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE message_ui_elements (
        message_row_id INTEGER PRIMARY KEY,
        element_content TEXT
      );
      INSERT INTO message VALUES
        (102, 10, 0, 'interactive-1', 4, 1700000040000, 0, NULL);
      INSERT INTO message_ui_elements VALUES
        (102, '{"content":"Escolha uma opção","footer":"Atendimento Lume","buttons":[{"displayText":"Comercial"},{"displayText":"Suporte"}]}');
    `);
    db.close();

    const rows = [
      ...readWhatsAppAndroidBackup(path, {
        departmentCode: 'commercial',
        state: 'closed',
      }),
    ];

    expect(rows[0]?.parsed.messages[2]).toMatchObject({
      kind: 'text',
      text: 'Escolha uma opção\nAtendimento Lume\nOpções: Comercial · Suporte',
      attachment: null,
    });
  });

  it('keeps genuinely empty text messages importable', async () => {
    const path = await fixture();
    const db = new DatabaseSync(path);
    db.exec(`
      INSERT INTO message VALUES
        (102, 10, 0, 'empty-text-1', 4, 1700000040000, 0, NULL);
    `);
    db.close();

    const rows = [
      ...readWhatsAppAndroidBackup(path, {
        departmentCode: 'commercial',
        state: 'closed',
      }),
    ];

    expect(rows[0]?.parsed.messages[2]).toMatchObject({
      kind: 'text',
      text: '[Mensagem de texto sem conteúdo disponível no backup]',
      attachment: null,
    });
  });
});

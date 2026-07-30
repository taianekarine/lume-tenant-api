import 'dotenv/config';

import { execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS, { type Worksheet } from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UsersRepository } from '../src/application/contracts/repositories';
import { UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT } from '../src/domain/whatsapp/whatsapp.constants';
import {
  DeliveryStatus,
  MessageDirection,
  MessageKind,
  Prisma,
  WhatsAppImportBatchStatus,
} from '../src/infra/database/prisma/generated/client';
import { WhatsAppImportService } from '../src/infra/imports/whatsapp-import.service';
import {
  CONVERSATION_HEADERS,
  DOCUMENT_HEADERS,
  MESSAGE_HEADERS,
} from '../src/infra/imports/whatsapp-import.types';
import { configureBodyParsers } from '../src/shared/http/configure-body-parsers';

const channelId = '00000000-0000-4000-8000-000000000221';
const serviceKeyId = '00000000-0000-4000-8000-000000000222';
const serviceSecret = 'n8n-service-secret-with-more-than-32-characters';
const webhookSecret = 'evolution-webhook-secret-with-more-than-32-characters';
const tenantId = '00000000-0000-4000-8000-000000000210';
const installationId = '00000000-0000-4000-8000-000000000211';

function blankImportRow(length: number): unknown[] {
  return Array.from({ length }, () => null);
}

function addImportTable(
  worksheet: Worksheet,
  name: string,
  headers: readonly string[],
  rows: unknown[][],
): void {
  worksheet.addTable({
    name,
    ref: 'A1',
    headerRow: true,
    totalsRow: false,
    columns: headers.map((header) => ({ name: header })),
    rows,
  });
}

function legacyConversationRow(options: {
  externalId: string;
  phone: string;
  wallClock: Date;
  contactName?: string;
  origin?: string;
  destination?: string;
  quoteSequence?: number;
}): unknown[] {
  const row = blankImportRow(CONVERSATION_HEADERS.length);
  row[0] = options.externalId;
  row[1] = 'legacy-e2e';
  row[2] = options.phone;
  row[3] = options.contactName ?? 'Cliente legado E2E';
  row[4] = '5511999999999';
  row[5] = 'commercial';
  row[7] = 'bot-active';
  row[8] = options.quoteSequence ? 'commercial-follow-up-menu' : 'main-menu';
  row[9] = options.quoteSequence ? 'under-review' : 'not-started';
  row[10] = options.wallClock;
  row[11] = 'Histórico legado importado';
  row[12] = 0;
  row[13] = options.quoteSequence ?? null;
  row[14] = options.quoteSequence ? options.contactName : null;
  row[17] = options.quoteSequence ? 'fretamento-eventual' : null;
  row[18] = 'unknown';
  row[19] = options.origin ?? null;
  row[20] = options.destination ?? null;
  row[23] = options.quoteSequence ? 12 : null;
  row[25] = 'desconhecido';
  row[26] = 'desconhecido';
  row[29] = options.quoteSequence ? options.wallClock : null;
  row[32] = 'upsert';
  return row;
}

function legacyMessageRow(
  externalConversationId: string,
  externalMessageId: string,
  wallClock: Date,
): unknown[] {
  const row = blankImportRow(MESSAGE_HEADERS.length);
  row[0] = externalConversationId;
  row[1] = externalMessageId;
  row[2] = 'inbound';
  row[3] = 'text';
  row[4] = wallClock;
  row[5] = 'received';
  row[6] = 'Mensagem histórica';
  row[9] = `provider-${externalMessageId}`;
  return row;
}

function legacyDocumentRow(
  externalConversationId: string,
  externalDocumentId: string,
  quoteSequence: number,
): unknown[] {
  const row = blankImportRow(DOCUMENT_HEADERS.length);
  row[0] = externalConversationId;
  row[1] = quoteSequence;
  row[2] = externalDocumentId;
  row[3] = 'proposta-legada.pdf';
  row[4] = 'files/proposta-legada.pdf';
  row[5] = 'application/pdf';
  row[6] = 'uploaded';
  return row;
}

async function createLegacyImportPackage(options: {
  root: string;
  directory: string;
  conversations: unknown[][];
  messages?: unknown[][];
  documents?: unknown[][];
  includePdf?: boolean;
}): Promise<string> {
  const packagePath = join(options.root, options.directory);
  const filesPath = join(packagePath, 'files');
  await mkdir(filesPath, { recursive: true });
  if (options.includePdf) {
    await writeFile(
      join(filesPath, 'proposta-legada.pdf'),
      Buffer.from('%PDF-1.7\nimport-e2e\n%%EOF'),
    );
  }
  const workbook = new ExcelJS.Workbook();
  addImportTable(
    workbook.addWorksheet('Atendimentos'),
    'AtendimentosImportacao',
    CONVERSATION_HEADERS,
    options.conversations,
  );
  addImportTable(
    workbook.addWorksheet('Mensagens'),
    'MensagensImportacao',
    MESSAGE_HEADERS,
    options.messages ?? [],
  );
  addImportTable(
    workbook.addWorksheet('Documentos'),
    'DocumentosImportacao',
    DOCUMENT_HEADERS,
    options.documents ?? [],
  );
  await workbook.xlsx.writeFile(
    join(packagePath, 'modelo-importacao-atendimentos-whatsapp.xlsx'),
  );
  return packagePath;
}

function configureEnvironment(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'TEST_DATABASE_URL é obrigatório para o E2E e deve apontar para um banco descartável.',
    );
  }
  const databaseName = new URL(databaseUrl).pathname.toLowerCase();
  if (!databaseName.includes('test')) {
    throw new Error('TEST_DATABASE_URL deve conter "test" no nome do banco.');
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const license = {
    version: 1,
    licenseId: '00000000-0000-4000-8000-000000000212',
    installationId,
    tenantId,
    plan: 'standard',
    features: ['users', 'whatsapp'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z',
    graceUntil: '2027-02-01T00:00:00.000Z',
  };
  const encoded = Buffer.from(JSON.stringify(license)).toString('base64url');
  const signature = sign(null, Buffer.from(encoded), privateKey).toString(
    'base64url',
  );
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });

  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    JWT_ACCESS_SECRET: 'e2e-jwt-secret-with-at-least-32-characters',
    INSTALLATION_ID: installationId,
    LICENSE_PUBLIC_KEY_BASE64: Buffer.from(publicPem).toString('base64'),
    LICENSE_DOCUMENT: `${encoded}.${signature}`,
    TENANT_LEGAL_NAME: 'Lume E2E Ltda.',
    TENANT_TRADE_NAME: 'Lume E2E',
    TENANT_TAX_ID: '04.252.011/0001-10',
    TENANT_ADMIN_NAME: 'Admin E2E',
    TENANT_ADMIN_USERNAME: 'admin.e2e',
    TENANT_ADMIN_EMAIL: 'admin.e2e@example.test',
    TENANT_ADMIN_PASSWORD: 'SenhaForte@2026',
    WHATSAPP_ENABLED: 'true',
    WHATSAPP_CHANNEL_ID: channelId,
    WHATSAPP_CHANNEL_NAME: 'WhatsApp E2E',
    WHATSAPP_PHONE_NUMBER: '5511999999999',
    EVOLUTION_PROVIDER_NAME: 'Evolution E2E',
    EVOLUTION_BASE_URL: 'https://evolution.example.test',
    EVOLUTION_INSTANCE_NAME: 'lume-e2e',
    EVOLUTION_API_KEY: 'evolution-api-key-for-e2e',
    EVOLUTION_WEBHOOK_SECRET: webhookSecret,
    N8N_SERVICE_KEY_ID: serviceKeyId,
    N8N_SERVICE_SECRET: serviceSecret,
    N8N_DISPATCH_ENABLED: 'false',
    RETENTION_JOB_ENABLED: 'false',
    SWAGGER_ENABLED: 'false',
  });
  return databaseUrl;
}

function webhookPayload(
  messageId: string,
  phone: string,
  text: string,
  timestampSeconds = Math.floor(Date.now() / 1000),
) {
  return {
    event: 'messages.upsert',
    instance: 'lume-e2e',
    data: {
      key: {
        id: messageId,
        remoteJid: `${phone}@s.whatsapp.net`,
        fromMe: false,
      },
      pushName: `Contato ${phone.slice(-4)}`,
      messageTimestamp: timestampSeconds,
      message: { conversation: text },
    },
  };
}

function signedWebhook(
  app: INestApplication,
  payload: ReturnType<typeof webhookPayload>,
) {
  const raw = JSON.stringify(payload);
  const timestamp = String(payload.data.messageTimestamp);
  const signature = createHmac('sha256', webhookSecret)
    .update(timestamp)
    .update('.')
    .update(raw)
    .digest('hex');
  return request(app.getHttpServer())
    .post(`/api/v1/webhooks/evolution/${channelId}`)
    .set('content-type', 'application/json')
    .set('x-evolution-timestamp', timestamp)
    .set('x-evolution-signature', `sha256=${signature}`)
    .send(raw);
}

function tokenWebhook(
  app: INestApplication,
  payload: ReturnType<typeof webhookPayload>,
) {
  return request(app.getHttpServer())
    .post(`/api/v1/webhooks/evolution/${channelId}`)
    .set('content-type', 'application/json')
    .set('x-evolution-webhook-token', webhookSecret)
    .send(JSON.stringify(payload));
}

describe('WhatsApp MVP HTTP E2E com PostgreSQL', () => {
  let app: NestExpressApplication;
  let prisma: import('../src/infra/database/prisma/prisma.service').PrismaService;
  let accessToken: string;
  const serviceToken = `${serviceKeyId}.${serviceSecret}`;
  let conversationId: string;
  let quoteRequestId: string;
  let selectedCommandId: string;

  beforeAll(async () => {
    const databaseUrl = configureEnvironment();
    execFileSync(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'),
        'migrate',
        'reset',
        '--force',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: 'pipe',
      },
    );

    const [{ AppModule }, { ProductionBootstrapService }, prismaModule] =
      await Promise.all([
        import('../src/app.module'),
        import('../src/infra/bootstrap/production-bootstrap.service'),
        import('../src/infra/database/prisma/prisma.service'),
      ]);
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      rawBody: true,
      bodyParser: false,
      logger: ['error'],
    });
    configureBodyParsers(
      app,
      app.get(ConfigService).getOrThrow<number>('HTTP_MAX_JSON_BODY_BYTES'),
    );
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    prisma = app.get(prismaModule.PrismaService);
    await app.get(ProductionBootstrapService).execute();

    const firstAccess = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: 'admin.e2e',
        password: 'SenhaForte@2026',
        remember: false,
      })
      .expect(403);
    expect(firstAccess.body).toMatchObject({
      code: 'ACCOUNT_PASSWORD_SETUP_REQUIRED',
      details: {
        challengeToken: expect.any(String),
        expiresAt: expect.any(String),
        reason: 'first-access',
      },
    });
    const challengeToken = firstAccess.body.details.challengeToken as string;
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/change')
      .send({
        token: challengeToken,
        newPassword: 'SenhaFinalE2E@2026',
      })
      .expect(200)
      .expect(({ body }) => expect(body).toEqual({ changed: true }));
    await request(app.getHttpServer())
      .post('/api/v1/auth/password/change')
      .send({
        token: challengeToken,
        newPassword: 'OutraSenhaE2E@2026',
      })
      .expect(401);

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: 'admin.e2e',
        password: 'SenhaFinalE2E@2026',
        remember: false,
      })
      .expect((response) => {
        if (response.status !== 200) {
          throw new Error(
            `Login E2E falhou com HTTP ${response.status}: ${JSON.stringify(response.body)}`,
          );
        }
      });
    accessToken = login.body.accessToken as string;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('aceita corpos JSON normais e rejeita payloads acima de 1 MB', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: 'admin.e2e',
        password: 'SenhaFinalE2E@2026',
        remember: false,
      })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: 'x'.repeat(1_048_576),
        password: 'SenhaFinalE2E@2026',
        remember: false,
      })
      .expect(413);
  });

  it('persiste inbound antes da outbox e trata webhook duplicado', async () => {
    const payload = webhookPayload(
      'provider-first-contact',
      '5511988881111',
      'Olá',
    );
    const first = await signedWebhook(app, payload).expect(202);
    const duplicate = await signedWebhook(app, payload).expect(202);

    expect(first.body).toMatchObject({
      accepted: true,
      duplicate: false,
      automationAllowed: true,
    });
    expect(duplicate.body).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    conversationId = first.body.conversationId as string;

    const [messages, inbox, outbox] = await Promise.all([
      prisma.whatsAppMessage.findMany({
        where: { companyId: tenantId, conversationId },
      }),
      prisma.integrationInbox.findMany({
        where: { companyId: tenantId, source: 'evolution' },
      }),
      prisma.integrationOutbox.findMany({
        where: {
          companyId: tenantId,
          topic: 'whatsapp.inbound.persisted',
        },
      }),
    ]);
    expect(messages).toHaveLength(1);
    expect(inbox).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(outbox[0].payload).toMatchObject({
      automationAllowed: true,
      canGenerateReply: true,
      canSendReply: true,
      isFirstContact: true,
      conversation: {
        id: conversationId,
        flowStep: 'main-menu',
      },
    });
    expect(messages[0].createdAt.valueOf()).toBeLessThanOrEqual(
      outbox[0].createdAt.valueOf(),
    );

    const conversation = await prisma.whatsAppConversation.findUniqueOrThrow({
      where: { id_companyId: { id: conversationId, companyId: tenantId } },
    });
    expect(conversation).toMatchObject({
      conversationState: 'BOT_ACTIVE',
      flowStep: 'MAIN_MENU',
      requestStatus: 'NOT_STARTED',
      version: 1,
    });
  });

  it('aceita o token estático configurável da Evolution sem header dinâmico', async () => {
    const response = await tokenWebhook(
      app,
      webhookPayload(
        'provider-static-token',
        '5511988882222',
        'Primeiro contato por token',
      ),
    ).expect(202);

    expect(response.body).toMatchObject({
      accepted: true,
      duplicate: false,
      automationAllowed: true,
      isFirstContact: true,
    });
  });

  it('serializa duas primeiras mensagens concorrentes em uma conversa aberta', async () => {
    const [first, second] = await Promise.all([
      signedWebhook(
        app,
        webhookPayload(
          'provider-race-first',
          '5511988883333',
          'Primeira mensagem',
        ),
      ),
      signedWebhook(
        app,
        webhookPayload(
          'provider-race-second',
          '5511988883333',
          'Segunda mensagem',
        ),
      ),
    ]);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.conversationId).toBe(second.body.conversationId);
    expect(
      [first.body.isFirstContact, second.body.isFirstContact].sort(),
    ).toEqual([false, true]);
    const contact = await prisma.whatsAppContact.findUniqueOrThrow({
      where: {
        companyId_phoneNormalized: {
          companyId: tenantId,
          phoneNormalized: '5511988883333',
        },
      },
    });
    expect(
      await prisma.whatsAppConversation.count({
        where: {
          companyId: tenantId,
          channelId,
          contactId: contact.id,
          closedAt: null,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.whatsAppMessage.count({
        where: {
          companyId: tenantId,
          conversationId: first.body.conversationId as string,
        },
      }),
    ).toBe(2);
  });

  it('cria outbound pending antes do resultado Evolution', async () => {
    const commandId = randomUUID();
    const outboundBody = {
      commandId,
      expectedVersion: 1,
      automatic: true,
      purpose: 'main-menu',
      kind: 'text',
      text: 'Mensagem automática',
    };
    const response = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send(outboundBody)
      .expect(201);

    expect(response.body).toMatchObject({
      deliveryStatus: 'pending',
      providerMessageId: null,
    });
    expect(response.body.attempts[0]).toMatchObject({ status: 'pending' });
    const persisted = await prisma.whatsAppMessage.findUniqueOrThrow({
      where: {
        id_companyId: { id: response.body.id as string, companyId: tenantId },
      },
    });
    expect(persisted.deliveryStatus).toBe('PENDING');
    expect(persisted.providerMessageId).toBeNull();

    const claim = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${response.body.id as string}/evolution-dispatch-claims`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        attemptId: response.body.attempts[0].id,
      })
      .expect(201);
    expect(claim.body).toMatchObject({
      shouldSend: true,
      state: 'leased',
    });
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${response.body.id as string}/evolution-result`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        attemptId: response.body.attempts[0].id,
        status: 'sent',
        providerMessageId: 'evolution-main-menu',
      })
      .expect(201);
    const replay = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send(outboundBody)
      .expect(201);
    expect(replay.body).toMatchObject({
      id: response.body.id,
      deliveryStatus: 'sent',
      providerMessageId: 'evolution-main-menu',
      idempotent: true,
      attempts: [
        {
          id: response.body.attempts[0].id,
          status: 'succeeded',
          dispatchState: 'succeeded',
          providerMessageId: 'evolution-main-menu',
        },
      ],
    });
    expect(
      (
        await prisma.whatsAppConversation.findUniqueOrThrow({
          where: { id_companyId: { id: conversationId, companyId: tenantId } },
        })
      ).mainMenuPresentedAt,
    ).toBeInstanceOf(Date);
  });

  it('responde inbound não textual com texto fixo sem reabrir a automação humana', async () => {
    const unsupportedPayload = webhookPayload(
      `provider-unsupported-${randomUUID()}`,
      '5511988883311',
      'placeholder',
    );
    unsupportedPayload.data.message = {
      imageMessage: {
        mimetype: 'image/jpeg',
        fileLength: 128,
        url: 'https://evolution.example.test/media/image.jpg',
      },
    } as unknown as typeof unsupportedPayload.data.message;
    const inbound = await signedWebhook(app, unsupportedPayload).expect(202);
    const unsupportedConversationId = inbound.body.conversationId as string;
    const inboundMessageId = inbound.body.messageId as string;

    const forwarded = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${unsupportedConversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 1,
        name: 'forward',
        targetDepartment: 'commercial',
      })
      .expect(201);
    expect(forwarded.body).toMatchObject({
      conversationState: 'sent-to-human',
      flowStep: 'human-service',
      version: 2,
    });

    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${unsupportedConversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 2,
        automatic: true,
        purpose: 'main-menu',
        kind: 'text',
        text: UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT,
      })
      .expect(403);

    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${unsupportedConversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 2,
        automatic: true,
        purpose: 'unsupported-message-kind',
        inReplyToMessageId: inboundMessageId,
        kind: 'text',
        text: 'Não consigo processar a imagem.',
      })
      .expect(400);

    const reply = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${unsupportedConversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 2,
        automatic: true,
        purpose: 'unsupported-message-kind',
        inReplyToMessageId: inboundMessageId,
        kind: 'text',
        text: UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT,
      })
      .expect(201);
    expect(reply.body).toMatchObject({
      automationPurpose: 'unsupported-message-kind',
      deliveryStatus: 'pending',
      kind: 'text',
      text: UNSUPPORTED_MESSAGE_KIND_REPLY_TEXT,
    });

    expect(
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: unsupportedConversationId,
            companyId: tenantId,
          },
        },
      }),
    ).toMatchObject({
      conversationState: 'SENT_TO_HUMAN',
      flowStep: 'HUMAN_SERVICE',
      version: 2,
    });
  });

  it('persiste a coleta departamental, notifica o telefone interno e mantém a mensagem fora do painel', async () => {
    const inbound = await signedWebhook(
      app,
      webhookPayload(
        'provider-department-contact',
        '5511988887777',
        'Quero falar com a manutenção',
      ),
    ).expect(202);
    const departmentConversationId = inbound.body.conversationId as string;

    const collecting = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${departmentConversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 1,
        name: 'start-department-contact',
        targetDepartment: 'maintenance',
        metadata: { departmentOption: '7' },
      })
      .expect(201);
    expect(collecting.body).toMatchObject({
      department: 'maintenance',
      conversationState: 'bot-active',
      flowStep: 'main-menu',
      departmentContactOption: '7',
      version: 2,
    });

    const notification = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${departmentConversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 2,
        automatic: true,
        purpose: 'department-notification',
        recipientPhone: '5534998385144',
        kind: 'text',
        text: 'Telefone do cliente: 5511988887777\nNome e motivo informados: Cliente E2E - manutenção',
      })
      .expect(201);
    expect(notification.body).toMatchObject({
      deliveryStatus: 'pending',
      automationPurpose: 'department-notification',
      recipientPhone: '5534998385144',
    });

    const claim = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${notification.body.id as string}/evolution-dispatch-claims`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        attemptId: notification.body.attempts[0].id,
      })
      .expect(201);
    expect(claim.body).toMatchObject({ shouldSend: true });
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${notification.body.id as string}/evolution-result`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        attemptId: notification.body.attempts[0].id,
        status: 'sent',
        providerMessageId: 'evolution-department-notification',
      })
      .expect(201);

    const persisted = await prisma.whatsAppConversation.findUniqueOrThrow({
      where: {
        id_companyId: {
          id: departmentConversationId,
          companyId: tenantId,
        },
      },
    });
    expect(persisted.lastOutboundAt).toBeNull();

    const panelMessages = await request(app.getHttpServer())
      .get(
        `/api/v1/whatsapp/conversations/${departmentConversationId}/messages`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(panelMessages.body.meta.total).toBe(1);
    expect(panelMessages.body.data).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: notification.body.id }),
      ]),
    );

    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${departmentConversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 2,
        automatic: true,
        purpose: 'main-menu',
        recipientPhone: '5534998385144',
        kind: 'text',
        text: 'Não deve aceitar destinatário alternativo',
      })
      .expect(400);

    const forwarded = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${departmentConversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 2,
        name: 'forward',
        targetDepartment: 'maintenance',
        metadata: {
          departmentOption: '7',
          reason: 'department-contact-forwarded',
        },
      })
      .expect(201);
    expect(forwarded.body).toMatchObject({
      department: 'maintenance',
      conversationState: 'sent-to-human',
      flowStep: 'human-service',
      departmentContactOption: null,
    });
  });

  it('mantém filas distintas por departamento, estado e status exclusivamente comercial', async () => {
    const registeredDepartments = await prisma.tenantDepartment.findMany({
      where: { companyId: tenantId },
      select: { code: true },
    });
    expect(registeredDepartments.map(({ code }) => code).sort()).toEqual(
      [
        'COMMERCIAL',
        'CONTROLLING',
        'FINANCIAL',
        'MAINTENANCE',
        'MANAGEMENT',
        'MONITORING',
        'OPERATIONS',
        'PERSONNEL_DEPARTMENT',
        'PURCHASING',
      ].sort(),
    );

    const queueFixtures = [
      {
        phone: '5511910000001',
        department: 'CONTROLLING',
        requestStatus: 'NOT_STARTED',
      },
      {
        phone: '5511910000002',
        department: 'FINANCIAL',
        requestStatus: 'NOT_STARTED',
      },
      {
        phone: '5511910000003',
        department: 'MANAGEMENT',
        requestStatus: 'NOT_STARTED',
      },
      {
        phone: '5511910000004',
        department: 'OPERATIONS',
        requestStatus: 'NOT_STARTED',
      },
      {
        phone: '5511910000005',
        department: 'COMMERCIAL',
        requestStatus: 'UNDER_REVIEW',
      },
    ] as const;

    const queueConversationIds = new Map<string, string>();
    for (const fixture of queueFixtures) {
      const contact = await prisma.whatsAppContact.create({
        data: {
          companyId: tenantId,
          phoneNormalized: fixture.phone,
          displayName: fixture.department,
        },
      });
      const conversation = await prisma.whatsAppConversation.create({
        data: {
          companyId: tenantId,
          channelId,
          contactId: contact.id,
          department: fixture.department,
          conversationState: 'SENT_TO_HUMAN',
          flowStep: 'HUMAN_SERVICE',
          requestStatus: fixture.requestStatus,
        },
      });
      queueConversationIds.set(fixture.department, conversation.id);
    }

    for (const department of [
      'controlling',
      'financial',
      'management',
      'operations',
    ]) {
      const response = await request(app.getHttpServer())
        .get('/api/v1/whatsapp/conversations')
        .query({ department, state: 'sent-to-human', pageSize: 100 })
        .set('authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]).toMatchObject({
        id: queueConversationIds.get(department.toUpperCase()),
        department,
        conversationState: 'sent-to-human',
      });
    }

    const commercialStatus = await request(app.getHttpServer())
      .get('/api/v1/whatsapp/conversations')
      .query({ requestStatus: 'under-review', pageSize: 100 })
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(commercialStatus.body.data).toHaveLength(1);
    expect(commercialStatus.body.data[0]).toMatchObject({
      id: queueConversationIds.get('COMMERCIAL'),
      department: 'commercial',
      requestStatus: 'under-review',
    });

    await request(app.getHttpServer())
      .get('/api/v1/whatsapp/conversations')
      .query({
        department: 'maintenance',
        requestStatus: 'under-review',
      })
      .set('authorization', `Bearer ${accessToken}`)
      .expect(400);
  });

  it('aplica matriz, commandId idempotente e conflito expectedVersion', async () => {
    const forbiddenActor = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 1,
        name: 'take-over',
      })
      .expect(403);
    expect(forbiddenActor.body.message).toContain('ator n8n');

    const commandId = randomUUID();
    selectedCommandId = commandId;
    const selected = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId,
        expectedVersion: 1,
        name: 'select-commercial',
      })
      .expect(201);
    expect(selected.body).toMatchObject({
      flowStep: 'commercial-menu',
      version: 2,
      idempotent: false,
    });

    const duplicate = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId,
        expectedVersion: 1,
        name: 'select-commercial',
      })
      .expect(201);
    expect(duplicate.body).toMatchObject({ version: 2, idempotent: true });
    expect(
      await prisma.whatsAppConversationTransition.count({
        where: { companyId: tenantId, commandId },
      }),
    ).toBe(1);
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId,
        expectedVersion: 1,
        name: 'start-quote',
      })
      .expect(409);

    const conflict = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 1,
        name: 'start-quote',
      })
      .expect(409);
    expect(conflict.body.details).toEqual({ currentVersion: 2 });
  });

  it('preserva dados na correção e confirmação nunca fecha a conversa', async () => {
    const transition = async (
      name: string,
      expectedVersion: number,
    ): Promise<Record<string, unknown>> => {
      const response = await request(app.getHttpServer())
        .post(
          `/api/v1/internal/whatsapp/conversations/${conversationId}/transitions`,
        )
        .set('authorization', `Bearer ${serviceToken}`)
        .send({ commandId: randomUUID(), expectedVersion, name })
        .expect(201);
      return response.body as Record<string, unknown>;
    };

    const collecting = await transition('start-quote', 2);
    const oldReplay = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: selectedCommandId,
        expectedVersion: 1,
        name: 'select-commercial',
      })
      .expect(201);
    expect(oldReplay.body).toMatchObject({
      version: 2,
      flowStep: 'commercial-menu',
      idempotent: true,
    });
    quoteRequestId = (collecting.currentQuoteRequest as Record<string, string>)
      .id;
    await request(app.getHttpServer())
      .patch(`/api/v1/internal/whatsapp/quote-requests/${quoteRequestId}`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 1,
        contactName: 'Cliente E2E',
        serviceType: 'Fretamento eventual',
        origin: 'São Paulo',
        destination: 'Campinas',
        departureAt: '2026-08-01T10:00:00.000Z',
        passengerCount: 12,
      })
      .expect(200);
    await transition('present-quote-summary', 3);
    const awaitingReply = await signedWebhook(
      app,
      webhookPayload(
        'provider-summary-correction',
        '5511988881111',
        'Quero corrigir',
      ),
    ).expect(202);
    expect(awaitingReply.body).toMatchObject({
      automationAllowed: true,
      version: 5,
    });
    const waitingState = await prisma.whatsAppConversation.findUniqueOrThrow({
      where: { id_companyId: { id: conversationId, companyId: tenantId } },
    });
    expect(waitingState).toMatchObject({
      conversationState: 'BOT_ACTIVE',
      flowStep: 'QUOTE_SUMMARY_CONFIRMATION',
      requestStatus: 'WAITING_FOR_CUSTOMER',
      version: 5,
    });

    await transition('correct-quote', 5);

    const preserved = await prisma.quoteRequest.findUniqueOrThrow({
      where: {
        id_companyId: { id: quoteRequestId, companyId: tenantId },
      },
    });
    expect(preserved).toMatchObject({
      origin: 'São Paulo',
      destination: 'Campinas',
      passengerCount: 12,
      status: 'COLLECTING_INFORMATION',
    });

    await transition('present-quote-summary', 6);
    const confirmed = await transition('confirm-quote', 7);
    expect(confirmed).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
      closedAt: null,
    });
    expect(confirmed.conversationState).not.toBe('closed');
    const persistedQuote = await prisma.quoteRequest.findUniqueOrThrow({
      where: {
        id_companyId: { id: quoteRequestId, companyId: tenantId },
      },
    });
    expect(persistedQuote.confirmedAt).toBeInstanceOf(Date);
    expect(persistedQuote.confirmedVersion).toBe(persistedQuote.version);
    expect(persistedQuote.confirmedSummary).toMatchObject({
      origin: 'São Paulo',
      destination: 'Campinas',
      passengerCount: 12,
    });
    const pendingAfterConfirmation = await request(app.getHttpServer())
      .get('/api/v1/whatsapp/quote-proposals?page=1&pageSize=100')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(pendingAfterConfirmation.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: quoteRequestId,
          quoteRequest: expect.objectContaining({
            status: 'under-review',
          }),
          conversation: expect.objectContaining({
            id: conversationId,
            conversationState: 'bot-active',
            flowStep: 'commercial-follow-up-menu',
          }),
        }),
      ]),
    );
    await request(app.getHttpServer())
      .patch(`/api/v1/internal/whatsapp/quote-requests/${quoteRequestId}`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: persistedQuote.version,
        origin: 'Origem indevidamente alterada',
      })
      .expect(400);
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 8,
        name: 'start-quote',
      })
      .expect(400);
  });

  it('mantém o bot ativo em análise e preserva o histórico após take-over', async () => {
    const beforeAutomatedInbounds =
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: { id_companyId: { id: conversationId, companyId: tenantId } },
      });
    expect(beforeAutomatedInbounds).toMatchObject({
      conversationState: 'BOT_ACTIVE',
      flowStep: 'COMMERCIAL_FOLLOW_UP_MENU',
      version: 8,
    });
    const automatedInbounds = [
      {
        providerMessageId: 'provider-complementary-contact-1',
        text: 'Complemento: levaremos bagagens.',
      },
      {
        providerMessageId: 'provider-complementary-contact-2',
        text: 'Serão duas malas grandes.',
      },
      {
        providerMessageId: 'provider-complementary-contact-3',
        text: 'Precisamos embarcar pelo portão lateral.',
      },
    ];
    const automatedResponses = await Promise.all(
      automatedInbounds.map(({ providerMessageId, text }) =>
        signedWebhook(
          app,
          webhookPayload(providerMessageId, '5511988881111', text),
        ),
      ),
    );
    for (const response of automatedResponses) {
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        accepted: true,
        duplicate: false,
        automationAllowed: true,
      });
    }
    expect(
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: { id_companyId: { id: conversationId, companyId: tenantId } },
      }),
    ).toMatchObject({
      conversationState: 'BOT_ACTIVE',
      flowStep: 'COMMERCIAL_FOLLOW_UP_MENU',
      version: 8,
      unreadCount:
        beforeAutomatedInbounds.unreadCount + automatedInbounds.length,
    });

    await prisma.whatsAppConversation.update({
      where: { id_companyId: { id: conversationId, companyId: tenantId } },
      data: { contextualFollowUpAt: new Date(Date.now() - 1_000) },
    });
    const contextual = await signedWebhook(
      app,
      webhookPayload(
        'provider-contextual-contact',
        '5511988881111',
        'E o orçamento?',
      ),
    ).expect(202);
    expect(contextual.body).toMatchObject({
      automationAllowed: true,
      version: 9,
    });

    const state = await request(app.getHttpServer())
      .get(`/api/v1/internal/whatsapp/conversations/${conversationId}`)
      .set('authorization', `Bearer ${serviceToken}`)
      .expect(200);
    expect(state.body).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
      version: 9,
    });

    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${conversationId}/actions/take-over`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({ commandId: randomUUID(), expectedVersion: 9 })
      .expect(201);

    const humanMessage = await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/conversations/${conversationId}/messages`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        idempotencyKey: randomUUID(),
        expectedVersion: 10,
        text: 'Recebemos sua solicitação e vamos verificar.',
      })
      .expect(201);
    expect(humanMessage.body).toMatchObject({
      idempotent: false,
      message: {
        deliveryStatus: 'pending',
        direction: 'outbound',
        sentBy: { name: 'Admin E2E' },
      },
      conversation: {
        conversationState: 'human-active',
        version: 11,
      },
    });
    const requested = await prisma.integrationOutbox.findFirstOrThrow({
      where: {
        companyId: tenantId,
        topic: 'whatsapp.outbound.requested',
        aggregateId: conversationId,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(requested.payload).toMatchObject({
      messageId: humanMessage.body.message.id,
      attemptId: humanMessage.body.message.attempts[0].id,
      automationAllowed: false,
      canGenerateReply: false,
      canSendReply: true,
    });

    const competingClaimBodies = [randomUUID(), randomUUID()].map(
      (commandId) => ({
        commandId,
        attemptId: humanMessage.body.message.attempts[0].id as string,
      }),
    );
    const competingClaims = await Promise.all(
      competingClaimBodies.map((body) =>
        request(app.getHttpServer())
          .post(
            `/api/v1/internal/whatsapp/messages/${humanMessage.body.message.id as string}/evolution-dispatch-claims`,
          )
          .set('authorization', `Bearer ${serviceToken}`)
          .send(body)
          .expect(201),
      ),
    );
    expect(
      competingClaims.filter((response) => response.body.shouldSend === true),
    ).toHaveLength(1);
    const winningClaimIndex = competingClaims.findIndex(
      (response) => response.body.shouldSend === true,
    );
    const claimBody = competingClaimBodies[winningClaimIndex];
    const duplicateClaim = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${humanMessage.body.message.id as string}/evolution-dispatch-claims`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send(claimBody)
      .expect(201);
    expect(duplicateClaim.body.shouldSend).toBe(false);
    await prisma.whatsAppMessageAttempt.update({
      where: {
        id_companyId: {
          id: claimBody.attemptId,
          companyId: tenantId,
        },
      },
      data: { dispatchLeaseUntil: new Date(Date.now() - 1_000) },
    });
    const unknownClaim = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${humanMessage.body.message.id as string}/evolution-dispatch-claims`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send(claimBody)
      .expect(201);
    expect(unknownClaim.body).toMatchObject({
      shouldSend: false,
      state: 'unknown',
      requiresReconciliation: true,
    });
    const reconciledClaim = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${humanMessage.body.message.id as string}/evolution-dispatch-claims`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        attemptId: claimBody.attemptId,
        reconciliation: 'confirmed-not-sent',
      })
      .expect(201);
    expect(reconciledClaim.body).toMatchObject({
      shouldSend: true,
      state: 'leased',
    });
    const evolutionResultUrl =
      `/api/v1/internal/whatsapp/messages/` +
      `${humanMessage.body.message.id as string}/evolution-result`;
    const [sentResult, failedResult] = await Promise.all([
      request(app.getHttpServer())
        .post(evolutionResultUrl)
        .set('authorization', `Bearer ${serviceToken}`)
        .send({
          commandId: randomUUID(),
          attemptId: claimBody.attemptId,
          status: 'sent',
          providerMessageId: 'evolution-human-message',
        })
        .expect(201),
      request(app.getHttpServer())
        .post(evolutionResultUrl)
        .set('authorization', `Bearer ${serviceToken}`)
        .send({
          commandId: randomUUID(),
          attemptId: claimBody.attemptId,
          status: 'failed',
          errorCode: 'CONCURRENT_FAILURE',
          errorMessage: 'Resultado concorrente simulado.',
        })
        .expect(201),
    ]);
    expect([
      sentResult.body.deliveryStatus,
      failedResult.body.deliveryStatus,
    ]).toContain('sent');
    expect(
      await prisma.whatsAppMessage.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: humanMessage.body.message.id as string,
            companyId: tenantId,
          },
        },
        include: { attempts: true },
      }),
    ).toMatchObject({
      deliveryStatus: 'SENT',
      providerMessageId: 'evolution-human-message',
      attempts: [
        {
          status: 'SUCCEEDED',
          dispatchState: 'SUCCEEDED',
          providerMessageId: 'evolution-human-message',
        },
      ],
    });

    const beforeHumanInbounds =
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: { id_companyId: { id: conversationId, companyId: tenantId } },
      });
    expect(beforeHumanInbounds).toMatchObject({
      conversationState: 'HUMAN_ACTIVE',
      flowStep: 'HUMAN_SERVICE',
      version: 11,
    });

    const humanInbounds = [
      {
        providerMessageId: 'provider-human-contact-1',
        text: 'Ainda aguardando.',
      },
      {
        providerMessageId: 'provider-human-contact-2',
        text: 'Também preciso incluir duas malas grandes.',
      },
      {
        providerMessageId: 'provider-human-contact-3',
        text: 'E o embarque deve ser pelo portão lateral.',
      },
    ];
    const inboundResponses = await Promise.all(
      humanInbounds.map(({ providerMessageId, text }) =>
        signedWebhook(
          app,
          webhookPayload(providerMessageId, '5511988881111', text),
        ),
      ),
    );
    for (const response of inboundResponses) {
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        accepted: true,
        duplicate: false,
        automationAllowed: false,
      });
    }

    const afterHumanInbounds =
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: { id_companyId: { id: conversationId, companyId: tenantId } },
      });
    expect(afterHumanInbounds).toMatchObject({
      conversationState: 'HUMAN_ACTIVE',
      flowStep: 'HUMAN_SERVICE',
      version: 11,
      unreadCount: beforeHumanInbounds.unreadCount + humanInbounds.length,
    });

    const history = await request(app.getHttpServer())
      .get(
        `/api/v1/whatsapp/conversations/${conversationId}/messages?page=1&pageSize=100`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    const capturedByProviderId = new Map(
      (
        history.body.data as Array<{
          providerMessageId: string | null;
          direction: string;
          deliveryStatus: string;
          text: string | null;
        }>
      ).map((message) => [message.providerMessageId, message]),
    );
    const allCapturedInbounds = [...automatedInbounds, ...humanInbounds];
    for (const inbound of allCapturedInbounds) {
      expect(capturedByProviderId.get(inbound.providerMessageId)).toMatchObject(
        {
          providerMessageId: inbound.providerMessageId,
          direction: 'inbound',
          deliveryStatus: 'received',
          text: inbound.text,
        },
      );
    }

    const humanNotificationProviderIds = new Set(
      humanInbounds.map(({ providerMessageId }) => providerMessageId),
    );
    const humanNotifications = (
      await prisma.integrationOutbox.findMany({
        where: {
          companyId: tenantId,
          aggregateId: conversationId,
          topic: 'whatsapp.inbound.human-notification',
        },
      })
    ).filter((event) => {
      const eventPayload = event.payload as {
        message?: { providerMessageId?: string };
      };
      return humanNotificationProviderIds.has(
        eventPayload.message?.providerMessageId ?? '',
      );
    });
    expect(humanNotifications).toHaveLength(humanInbounds.length);
    expect(
      humanNotifications.every((event) => event.status === 'PENDING'),
    ).toBe(true);

    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 11,
        automatic: true,
        kind: 'text',
        text: 'Não pode enviar',
      })
      .expect(403);
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 11,
        automatic: false,
        kind: 'text',
        text: 'Tentativa de contornar o bloqueio',
      })
      .expect(400);
    const after = await prisma.whatsAppConversation.findUniqueOrThrow({
      where: { id_companyId: { id: conversationId, companyId: tenantId } },
    });
    expect(after.conversationState).toBe('HUMAN_ACTIVE');
  });

  it('isola consultas do painel por companyId e nova solicitação cria novo registro', async () => {
    const foreignCompanyId = '00000000-0000-4000-8000-000000000299';
    await prisma.company.create({
      data: {
        id: foreignCompanyId,
        legalName: 'Tenant externo',
        taxId: '11222333000181',
      },
    });
    const foreignProvider = await prisma.whatsAppProvider.create({
      data: {
        companyId: foreignCompanyId,
        name: 'Foreign Evolution',
        baseUrl: 'https://foreign.example.test',
        apiKeyHash: 'a'.repeat(64),
      },
    });
    const foreignChannel = await prisma.whatsAppChannel.create({
      data: {
        companyId: foreignCompanyId,
        providerId: foreignProvider.id,
        name: 'Foreign channel',
        phoneNumber: '5511977777777',
        instanceName: 'foreign',
        webhookSecretHash: 'b'.repeat(64),
      },
    });
    const foreignContact = await prisma.whatsAppContact.create({
      data: {
        companyId: foreignCompanyId,
        phoneNormalized: '5511966666666',
      },
    });
    const foreignConversation = await prisma.whatsAppConversation.create({
      data: {
        companyId: foreignCompanyId,
        channelId: foreignChannel.id,
        contactId: foreignContact.id,
      },
    });

    const list = await request(app.getHttpServer())
      .get('/api/v1/whatsapp/conversations')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(
      (list.body.data as Array<{ id: string }>).some(
        (item) => item.id === foreignConversation.id,
      ),
    ).toBe(false);
    await request(app.getHttpServer())
      .get(`/api/v1/whatsapp/conversations/${foreignConversation.id}`)
      .set('authorization', `Bearer ${accessToken}`)
      .expect(404);

    const current = await prisma.whatsAppConversation.findUniqueOrThrow({
      where: { id_companyId: { id: conversationId, companyId: tenantId } },
    });
    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${conversationId}/actions/return-to-bot`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({ commandId: randomUUID(), expectedVersion: current.version })
      .expect(201);
    const returned = await prisma.whatsAppConversation.findUniqueOrThrow({
      where: { id_companyId: { id: conversationId, companyId: tenantId } },
    });
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversationId}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: returned.version,
        name: 'new-quote-request',
      })
      .expect(201);
    expect(
      await prisma.quoteRequest.count({
        where: { companyId: tenantId, conversationId },
      }),
    ).toBe(2);
  });

  it('devolve orçamento confirmado ao bot e publica o próximo inbound para o menu de acompanhamento', async () => {
    const phone = '5511988884444';
    const first = await signedWebhook(
      app,
      webhookPayload('provider-follow-up-return-start', phone, 'Olá'),
    ).expect(202);
    const followUpConversationId = first.body.conversationId as string;

    const transition = async (
      name: string,
      expectedVersion: number,
      targetDepartment?: string,
    ) =>
      request(app.getHttpServer())
        .post(
          `/api/v1/internal/whatsapp/conversations/${followUpConversationId}/transitions`,
        )
        .set('authorization', `Bearer ${serviceToken}`)
        .send({
          commandId: randomUUID(),
          expectedVersion,
          name,
          ...(targetDepartment ? { targetDepartment } : {}),
        })
        .expect(201);

    await transition('select-commercial', 1);
    await transition('start-quote', 2);
    const quote = await prisma.quoteRequest.findFirstOrThrow({
      where: {
        companyId: tenantId,
        conversationId: followUpConversationId,
      },
      orderBy: { sequence: 'desc' },
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/internal/whatsapp/quote-requests/${quote.id}`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: quote.version,
        contactName: 'Cliente acompanhamento',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Goiânia',
        departureAt: '2026-08-10T10:00:00.000Z',
        passengerCount: 20,
      })
      .expect(200);
    await transition('present-quote-summary', 3);
    await transition('confirm-quote', 4);

    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${followUpConversationId}/actions/take-over`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({ commandId: randomUUID(), expectedVersion: 5 })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${followUpConversationId}/actions/forward`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 6,
        targetDepartment: 'commercial',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${followUpConversationId}/actions/take-over`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({ commandId: randomUUID(), expectedVersion: 7 })
      .expect(201);
    const returned = await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${followUpConversationId}/actions/return-to-bot`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({ commandId: randomUUID(), expectedVersion: 8 })
      .expect(201);

    expect(returned.body).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
      resumeFlowStep: null,
      followUpMenuPresentedAt: null,
    });

    const nextInbound = await signedWebhook(
      app,
      webhookPayload('provider-follow-up-return-next', phone, 'Olá novamente'),
    ).expect(202);
    expect(nextInbound.body).toMatchObject({
      accepted: true,
      automationAllowed: true,
      canGenerateReply: true,
      canSendReply: true,
      version: 10,
    });
    const followUpEvent = await prisma.integrationOutbox.findFirstOrThrow({
      where: {
        companyId: tenantId,
        aggregateId: followUpConversationId,
        topic: 'whatsapp.inbound.persisted',
      },
      orderBy: { aggregateSequence: 'desc' },
    });
    expect(followUpEvent.payload).toMatchObject({
      contextualTransition: true,
      automationAllowed: true,
      canGenerateReply: true,
      canSendReply: true,
      conversation: {
        conversationState: 'bot-active',
        flowStep: 'commercial-follow-up-menu',
        requestStatus: 'under-review',
        version: 10,
      },
    });

    const menuOutbound = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${followUpConversationId}/messages/outbound`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 10,
        automatic: true,
        purpose: 'commercial-follow-up-menu',
        kind: 'text',
        text: 'Menu de acompanhamento',
      })
      .expect(201);
    const menuClaim = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${menuOutbound.body.id as string}/evolution-dispatch-claims`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        attemptId: menuOutbound.body.attempts[0].id,
      })
      .expect(201);
    expect(menuClaim.body.shouldSend).toBe(true);
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${menuOutbound.body.id as string}/evolution-result`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        attemptId: menuOutbound.body.attempts[0].id,
        status: 'sent',
        providerMessageId: 'evolution-follow-up-menu',
      })
      .expect(201);
    expect(
      (
        await prisma.whatsAppConversation.findUniqueOrThrow({
          where: {
            id_companyId: {
              id: followUpConversationId,
              companyId: tenantId,
            },
          },
        })
      ).followUpMenuPresentedAt,
    ).toBeInstanceOf(Date);

    const forwarded = await transition('forward', 10, 'commercial');
    expect(forwarded.body).toMatchObject({
      conversationState: 'sent-to-human',
      flowStep: 'human-service',
      requestStatus: 'under-review',
      resumeFlowStep: 'commercial-follow-up-menu',
    });

    await prisma.quoteRequest.update({
      where: {
        id_companyId: { id: quote.id, companyId: tenantId },
      },
      data: {
        status: 'APPROVED',
        decidedAt: new Date(),
      },
    });
    await prisma.whatsAppConversation.update({
      where: {
        id_companyId: {
          id: followUpConversationId,
          companyId: tenantId,
        },
      },
      data: {
        conversationState: 'WAITING_FOR_CUSTOMER',
        flowStep: 'QUOTE_SEND_PENDING',
        requestStatus: 'APPROVED',
        assignedToUserId: (
          await prisma.user.findFirstOrThrow({
            where: {
              companyId: tenantId,
              usernameNormalized: 'admin.e2e',
            },
            select: { id: true },
          })
        ).id,
      },
    });
    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${followUpConversationId}/actions/return-to-bot`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: forwarded.body.version,
      })
      .expect(400);
    await prisma.whatsAppConversation.update({
      where: {
        id_companyId: {
          id: followUpConversationId,
          companyId: tenantId,
        },
      },
      data: { assignedToUserId: null },
    });
    const approvedReturn = await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${followUpConversationId}/actions/return-to-bot`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: forwarded.body.version,
      })
      .expect(201);
    expect(approvedReturn.body).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'approved',
      assignedTo: null,
      hasApprovedQuoteRequest: true,
      followUpMenuPresentedAt: null,
      contextualFollowUpAt: '1970-01-01T00:00:00.000Z',
    });
  });

  it('mantém ordem estrita até completion n8n e recupera retry/timeout entre réplicas', async () => {
    await prisma.integrationOutbox.updateMany({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
      data: {
        status: 'DELIVERED',
        deliveredAt: new Date(),
        lockedAt: null,
        lockId: null,
        executionLeaseUntil: null,
      },
    });
    const received: Array<{
      eventId: string;
      executionId: string;
      aggregateSequence: number;
      authorization: string | undefined;
      executionHeader: string | undefined;
    }> = [];
    const statuses = [500];
    let completeBeforeAck = false;
    let raceCommandId = randomUUID();
    let raceCallbackStatus: number | undefined;
    const fakeN8n = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('end', () => {
        const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id: string;
          executionId: string;
          aggregateSequence: number;
          aggregateType: string;
          aggregateId: string;
        };
        received.push({
          eventId: envelope.id,
          executionId: envelope.executionId,
          aggregateSequence: envelope.aggregateSequence,
          authorization: incoming.headers.authorization,
          executionHeader: incoming.headers['x-lume-execution-id'] as
            string | undefined,
        });
        void (async () => {
          if (completeBeforeAck) {
            const callback = await request(app.getHttpServer())
              .post(
                `/api/v1/internal/whatsapp/outbox-events/${envelope.id}/completions`,
              )
              .set('authorization', `Bearer ${serviceToken}`)
              .send({
                commandId: raceCommandId,
                executionId: envelope.executionId,
                aggregateType: envelope.aggregateType,
                aggregateId: envelope.aggregateId,
                outcome: 'succeeded',
              });
            raceCallbackStatus = callback.status;
          }
          response.statusCode = statuses.shift() ?? 202;
          response.end();
        })();
      });
    });
    await new Promise<void>((resolve) =>
      fakeN8n.listen(0, '127.0.0.1', resolve),
    );

    try {
      const address = fakeN8n.address() as AddressInfo;
      const values: Record<string, unknown> = {
        N8N_DISPATCH_ENABLED: true,
        N8N_WEBHOOK_URL: `http://127.0.0.1:${address.port}/webhook/lume`,
        N8N_OUTBOUND_SECRET: 'fake-n8n-secret',
        N8N_DISPATCH_INTERVAL_MS: 60_000,
        N8N_REQUEST_TIMEOUT_MS: 2_000,
        N8N_EXECUTION_TIMEOUT_MS: 60_000,
        N8N_RETRY_BASE_DELAY_MS: 1,
        N8N_RETRY_MAX_DELAY_MS: 10,
        N8N_DISPATCH_BATCH_SIZE: 20,
      };
      const dispatcherModule =
        await import('../src/infra/integrations/n8n/integration-outbox.dispatcher');
      const buildDispatcher = () =>
        new dispatcherModule.IntegrationOutboxDispatcher(prisma, {
          get: <T>(key: string) => values[key] as T | undefined,
        } as ConfigService);
      const aggregateId = randomUUID();
      const [firstEvent, secondEvent] = await prisma.$transaction([
        prisma.integrationOutbox.create({
          data: {
            companyId: tenantId,
            topic: 'whatsapp.inbound.persisted',
            aggregateType: 'whatsapp-conversation',
            aggregateId,
            aggregateSequence: 1,
            correlationId: `dispatcher:${randomUUID()}`,
            payload: { order: 1 },
          },
        }),
        prisma.integrationOutbox.create({
          data: {
            companyId: tenantId,
            topic: 'whatsapp.inbound.persisted',
            aggregateType: 'whatsapp-conversation',
            aggregateId,
            aggregateSequence: 2,
            correlationId: `dispatcher:${randomUUID()}`,
            payload: { order: 2 },
          },
        }),
      ]);
      const completion = (
        eventId: string,
        executionId: string,
        targetAggregateId: string,
        outcome: 'succeeded' | 'retryable-failure' | 'terminal-failure',
        commandId = randomUUID(),
      ) => {
        const body = {
          commandId,
          executionId,
          aggregateType: 'whatsapp-conversation',
          aggregateId: targetAggregateId,
          outcome,
          ...(outcome === 'succeeded'
            ? {}
            : { errorCode: 'E2E_FAILURE', errorMessage: 'falha controlada' }),
        };
        return {
          commandId,
          body,
          request: request(app.getHttpServer())
            .post(
              `/api/v1/internal/whatsapp/outbox-events/${eventId}/completions`,
            )
            .set('authorization', `Bearer ${serviceToken}`)
            .send(body),
        };
      };

      await Promise.all([buildDispatcher().tick(), buildDispatcher().tick()]);
      expect(received.map((item) => item.eventId)).toEqual([firstEvent.id]);
      expect(received[0]).toMatchObject({
        aggregateSequence: 1,
        authorization: 'Bearer fake-n8n-secret',
      });
      expect(received[0].executionHeader).toBe(received[0].executionId);
      const firstAfterFailure =
        await prisma.integrationOutbox.findUniqueOrThrow({
          where: { id: firstEvent.id },
        });
      expect(firstAfterFailure).toMatchObject({
        status: 'PENDING',
        attempts: 1,
      });
      expect(
        await prisma.integrationOutbox.findUniqueOrThrow({
          where: { id: secondEvent.id },
        }),
      ).toMatchObject({ status: 'PENDING', attempts: 0 });

      await prisma.integrationOutbox.update({
        where: { id: firstAfterFailure.id },
        data: { availableAt: new Date(Date.now() - 1_000) },
      });
      await buildDispatcher().tick();
      const acceptedFirst = await prisma.integrationOutbox.findUniqueOrThrow({
        where: { id: firstEvent.id },
      });
      expect(acceptedFirst).toMatchObject({
        status: 'PROCESSING',
        attempts: 2,
      });
      expect(acceptedFirst.executionLeaseUntil).toBeInstanceOf(Date);

      await buildDispatcher().tick();
      expect(received.map((item) => item.eventId)).toEqual([
        firstEvent.id,
        firstEvent.id,
      ]);
      expect(
        await prisma.integrationOutbox.findUniqueOrThrow({
          where: { id: secondEvent.id },
        }),
      ).toMatchObject({
        status: 'PENDING',
        attempts: 0,
        executionId: null,
      });

      const firstCompletion = completion(
        firstEvent.id,
        acceptedFirst.executionId!,
        aggregateId,
        'succeeded',
      );
      const completed = await firstCompletion.request.expect(201);
      expect(completed.body).toMatchObject({
        eventId: firstEvent.id,
        status: 'delivered',
        idempotent: false,
      });
      await request(app.getHttpServer())
        .post(
          `/api/v1/internal/whatsapp/outbox-events/${firstEvent.id}/completions`,
        )
        .set('authorization', `Bearer ${serviceToken}`)
        .send(firstCompletion.body)
        .expect(201)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            status: 'delivered',
            idempotent: true,
          });
        });
      await request(app.getHttpServer())
        .post(
          `/api/v1/internal/whatsapp/outbox-events/${firstEvent.id}/completions`,
        )
        .set('authorization', `Bearer ${serviceToken}`)
        .send({
          ...firstCompletion.body,
          outcome: 'terminal-failure',
        })
        .expect(409);

      await buildDispatcher().tick();
      const acceptedSecond = await prisma.integrationOutbox.findUniqueOrThrow({
        where: { id: secondEvent.id },
      });
      expect(acceptedSecond.status).toBe('PROCESSING');
      const retryable = completion(
        secondEvent.id,
        acceptedSecond.executionId!,
        aggregateId,
        'retryable-failure',
      );
      await retryable.request.expect(201).expect(({ body }) => {
        expect(body).toMatchObject({ status: 'pending' });
      });
      await prisma.integrationOutbox.update({
        where: { id: secondEvent.id },
        data: { availableAt: new Date(Date.now() - 1_000) },
      });
      await buildDispatcher().tick();
      const secondRetry = await prisma.integrationOutbox.findUniqueOrThrow({
        where: { id: secondEvent.id },
      });
      expect(secondRetry.executionId).not.toBe(acceptedSecond.executionId);
      await completion(
        secondEvent.id,
        secondRetry.executionId!,
        aggregateId,
        'succeeded',
      ).request.expect(201);

      const exhaustedAggregateId = randomUUID();
      const exhaustedEvent = await prisma.integrationOutbox.create({
        data: {
          companyId: tenantId,
          topic: 'whatsapp.inbound.persisted',
          aggregateType: 'whatsapp-conversation',
          aggregateId: exhaustedAggregateId,
          aggregateSequence: 1,
          correlationId: `dispatcher:${randomUUID()}`,
          payload: { retryableFailureExhaustion: true },
          maxAttempts: 1,
        },
      });
      await buildDispatcher().tick();
      const acceptedExhausted =
        await prisma.integrationOutbox.findUniqueOrThrow({
          where: { id: exhaustedEvent.id },
        });
      expect(acceptedExhausted).toMatchObject({
        status: 'PROCESSING',
        attempts: 1,
      });

      await completion(
        exhaustedEvent.id,
        acceptedExhausted.executionId!,
        exhaustedAggregateId,
        'retryable-failure',
      )
        .request.expect(201)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            eventId: exhaustedEvent.id,
            outcome: 'retryable-failure',
            status: 'dead',
            attempts: 1,
          });
        });

      const exhaustedAfterCompletion =
        await prisma.integrationOutbox.findUniqueOrThrow({
          where: { id: exhaustedEvent.id },
        });
      expect(exhaustedAfterCompletion).toMatchObject({
        status: 'DEAD',
        attempts: 1,
        executionId: null,
        acceptedAt: null,
        executionLeaseUntil: null,
        lockId: null,
        lastError: 'E2E_FAILURE: falha controlada',
      });

      await buildDispatcher().tick();
      expect(
        await prisma.integrationOutbox.findUniqueOrThrow({
          where: { id: exhaustedEvent.id },
        }),
      ).toMatchObject({
        status: 'DEAD',
        attempts: 1,
        lastError: 'E2E_FAILURE: falha controlada',
      });

      const timeoutAggregateId = randomUUID();
      const timeoutEvent = await prisma.integrationOutbox.create({
        data: {
          companyId: tenantId,
          topic: 'whatsapp.inbound.persisted',
          aggregateType: 'whatsapp-conversation',
          aggregateId: timeoutAggregateId,
          aggregateSequence: 1,
          correlationId: `dispatcher:${randomUUID()}`,
          payload: { timeout: true },
        },
      });
      await buildDispatcher().tick();
      const acceptedTimeout = await prisma.integrationOutbox.findUniqueOrThrow({
        where: { id: timeoutEvent.id },
      });
      const oldExecutionId = acceptedTimeout.executionId!;
      await prisma.integrationOutbox.update({
        where: { id: timeoutEvent.id },
        data: { executionLeaseUntil: new Date(Date.now() - 1_000) },
      });
      await buildDispatcher().tick();
      const redispatched = await prisma.integrationOutbox.findUniqueOrThrow({
        where: { id: timeoutEvent.id },
      });
      expect(redispatched.executionId).not.toBe(oldExecutionId);
      expect(
        received.filter((item) => item.eventId === timeoutEvent.id),
      ).toHaveLength(2);
      await completion(
        timeoutEvent.id,
        oldExecutionId,
        timeoutAggregateId,
        'succeeded',
      ).request.expect(409);
      await completion(
        timeoutEvent.id,
        redispatched.executionId!,
        timeoutAggregateId,
        'succeeded',
      ).request.expect(201);

      const raceAggregateId = randomUUID();
      const raceEvent = await prisma.integrationOutbox.create({
        data: {
          companyId: tenantId,
          topic: 'whatsapp.inbound.persisted',
          aggregateType: 'whatsapp-conversation',
          aggregateId: raceAggregateId,
          aggregateSequence: 1,
          correlationId: `dispatcher:${randomUUID()}`,
          payload: { callbackBeforeAck: true },
        },
      });
      completeBeforeAck = true;
      raceCommandId = randomUUID();
      await buildDispatcher().tick();
      completeBeforeAck = false;
      expect(raceCallbackStatus).toBe(201);
      expect(
        await prisma.integrationOutbox.findUniqueOrThrow({
          where: { id: raceEvent.id },
        }),
      ).toMatchObject({
        status: 'DELIVERED',
        attempts: 1,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        fakeN8n.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('cancela e audita o ciclo under-review substituído sem deixá-lo na fila ou notificação', async () => {
    const actor = await prisma.user.findFirstOrThrow({
      where: { companyId: tenantId, usernameNormalized: 'admin.e2e' },
    });
    const baselineNotifications = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    const contact = await prisma.whatsAppContact.create({
      data: {
        companyId: tenantId,
        phoneNormalized: '5511977773131',
        displayName: 'Cliente ciclo substituído',
      },
    });
    const conversation = await prisma.whatsAppConversation.create({
      data: {
        companyId: tenantId,
        channelId,
        contactId: contact.id,
        department: 'COMMERCIAL',
        conversationState: 'BOT_ACTIVE',
        flowStep: 'COMMERCIAL_FOLLOW_UP_MENU',
        requestStatus: 'UNDER_REVIEW',
      },
    });
    const supersededQuote = await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: conversation.id,
        sequence: 1,
        status: 'UNDER_REVIEW',
        contactName: 'Cliente ciclo substituído',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Goiânia',
        departureAt: new Date('2026-08-14T12:00:00.000Z'),
        passengerCount: 12,
        confirmedAt: new Date(),
        confirmedVersion: 1,
        confirmedSummary: { source: 'superseded-cycle-e2e' },
      },
    });
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
    );
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${supersededQuote.id}/documents`)
      .set('authorization', `Bearer ${accessToken}`)
      .field('commandId', randomUUID())
      .field('expectedVersion', '1')
      .attach('file', pdf, {
        filename: 'orcamento-ciclo-substituido.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const uploadedDocumentId = upload.body.proposalDocument.id as string;

    const notificationsWithPendingQuote = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(notificationsWithPendingQuote.body).toMatchObject({
      total: baselineNotifications.body.total + 1,
      unreadTotal: baselineNotifications.body.unreadTotal + 1,
    });
    await request(app.getHttpServer())
      .get('/api/v1/whatsapp/quote-proposals?page=1&pageSize=100')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: supersededQuote.id }),
          ]),
        );
      });

    const commandId = randomUUID();
    const transitionRequest = () =>
      request(app.getHttpServer())
        .post(
          `/api/v1/internal/whatsapp/conversations/${conversation.id}/transitions`,
        )
        .set('authorization', `Bearer ${serviceToken}`)
        .send({
          commandId,
          expectedVersion: 1,
          name: 'new-quote-request',
        });
    const newCycle = await transitionRequest().expect(201);
    expect(newCycle.body).toMatchObject({
      idempotent: false,
      conversationState: 'bot-active',
      flowStep: 'quote-data-collection',
      requestStatus: 'collecting-information',
      version: 2,
      currentQuoteRequest: {
        sequence: 2,
        status: 'collecting-information',
      },
    });
    await transitionRequest()
      .expect(201)
      .expect(({ body }) => expect(body.idempotent).toBe(true));

    const quotes = await prisma.quoteRequest.findMany({
      where: { companyId: tenantId, conversationId: conversation.id },
      orderBy: { sequence: 'asc' },
    });
    expect(quotes).toHaveLength(2);
    expect(
      quotes.map(({ sequence, status, version }) => [
        sequence,
        status,
        version,
      ]),
    ).toEqual([
      [1, 'CANCELLED', 2],
      [2, 'COLLECTING_INFORMATION', 1],
    ]);
    expect(quotes[0]).toMatchObject({
      decisionReason: 'Substituído por uma nova solicitação de orçamento.',
      decidedAt: expect.any(Date),
    });
    const currentQuote = quotes[1];
    const transition =
      await prisma.whatsAppConversationTransition.findUniqueOrThrow({
        where: {
          companyId_commandId: {
            companyId: tenantId,
            commandId,
          },
        },
      });
    expect(transition.metadata).toMatchObject({
      quoteRequestId: currentQuote.id,
      supersededQuoteRequest: {
        id: supersededQuote.id,
        fromStatus: 'under-review',
        toStatus: 'cancelled',
        previousVersion: 1,
        resultingVersion: 2,
      },
    });
    expect(
      await prisma.tenantAuditLog.findMany({
        where: {
          companyId: tenantId,
          action: 'whatsapp.quote-request.superseded',
          targetId: supersededQuote.id,
        },
      }),
    ).toEqual([
      expect.objectContaining({
        actorUserId: null,
        metadata: expect.objectContaining({
          conversationId: conversation.id,
          newQuoteRequestId: currentQuote.id,
          transitionId: transition.id,
          commandId,
          fromStatus: 'under-review',
          toStatus: 'cancelled',
          previousVersion: 1,
          resultingVersion: 2,
        }),
      }),
    ]);

    await request(app.getHttpServer())
      .get('/api/v1/whatsapp/quote-proposals?page=1&pageSize=100')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        const ids = (body.items as Array<{ id: string }>).map(({ id }) => id);
        expect(ids).not.toContain(supersededQuote.id);
        expect(ids).not.toContain(currentQuote.id);
      });
    await request(app.getHttpServer())
      .get(
        `/api/v1/whatsapp/quote-proposals?stage=cancelled&search=${encodeURIComponent(
          'Cliente ciclo substituído',
        )}&page=1&pageSize=100`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) =>
        expect(body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: supersededQuote.id,
              quoteRequest: expect.objectContaining({
                status: 'cancelled',
                decision: {
                  status: 'cancelled',
                  reason: 'Substituído por uma nova solicitação de orçamento.',
                  decidedAt: expect.any(String),
                  decidedBy: null,
                },
              }),
            }),
          ]),
        ),
      );
    await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.total).toBe(baselineNotifications.body.total);
        expect(body.unreadTotal).toBe(baselineNotifications.body.unreadTotal);
      });
    await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${supersededQuote.id}/send`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 2,
        proposalDocumentId: uploadedDocumentId,
        batchId: randomUUID(),
        batchDocumentIds: [uploadedDocumentId],
      })
      .expect(400);
    expect(
      await prisma.quoteProposalDocument.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: uploadedDocumentId,
            companyId: tenantId,
          },
        },
      }),
    ).toMatchObject({
      status: 'UPLOADED',
      uploadedByUserId: actor.id,
    });
  });

  it('envia a proposta do ciclo confirmado mesmo após encaminhamento para atendimento', async () => {
    const actor = await prisma.user.findFirstOrThrow({
      where: { companyId: tenantId, usernameNormalized: 'admin.e2e' },
    });
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
    );
    const contact = await prisma.whatsAppContact.create({
      data: {
        companyId: tenantId,
        phoneNormalized: '5511987654321',
        displayName: 'Cliente proposta após acompanhamento',
      },
    });
    const conversation = await prisma.whatsAppConversation.create({
      data: {
        companyId: tenantId,
        channelId,
        contactId: contact.id,
        department: 'COMMERCIAL',
        conversationState: 'BOT_ACTIVE',
        flowStep: 'COMMERCIAL_FOLLOW_UP_MENU',
        requestStatus: 'UNDER_REVIEW',
      },
    });
    const quote = await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: conversation.id,
        sequence: 1,
        status: 'UNDER_REVIEW',
        contactName: 'Cliente proposta após acompanhamento',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Goiânia',
        departureAt: new Date('2026-08-15T12:00:00.000Z'),
        passengerCount: 18,
        confirmedAt: new Date(),
        confirmedVersion: 1,
        confirmedSummary: {
          contactName: 'Cliente proposta após acompanhamento',
          serviceType: 'Fretamento eventual',
          origin: 'Uberlândia',
          destination: 'Goiânia',
          departureAt: '2026-08-15T12:00:00.000Z',
          passengerCount: 18,
        },
      },
    });
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${quote.id}/documents`)
      .set('authorization', `Bearer ${accessToken}`)
      .field('commandId', randomUUID())
      .field('expectedVersion', '1')
      .attach('file', pdf, {
        filename: 'orcamento-acompanhamento.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    const documentId = upload.body.proposalDocument.id as string;

    await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/conversations/${conversation.id}/actions/forward`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 1,
        targetDepartment: 'commercial',
      })
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          conversationState: 'sent-to-human',
          flowStep: 'human-service',
          requestStatus: 'under-review',
          version: 2,
        });
      });

    await request(app.getHttpServer())
      .get('/api/v1/whatsapp/quote-proposals?page=1&pageSize=100')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: quote.id,
              quoteRequest: expect.objectContaining({
                status: 'under-review',
              }),
              conversation: expect.objectContaining({
                id: conversation.id,
                conversationState: 'sent-to-human',
                flowStep: 'human-service',
                requestStatus: 'under-review',
                currentQuoteRequest: expect.objectContaining({
                  id: quote.id,
                  status: 'under-review',
                }),
              }),
            }),
          ]),
        );
      });

    const sent = await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${quote.id}/send`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 2,
        proposalDocumentId: documentId,
        batchId: randomUUID(),
        batchDocumentIds: [documentId],
      })
      .expect(201);
    expect(sent.body).toMatchObject({
      message: {
        direction: 'outbound',
        kind: 'document',
        sentBy: { id: actor.id, name: actor.name },
      },
      conversation: {
        id: conversation.id,
        conversationState: 'bot-active',
        flowStep: 'quote-send-pending',
        requestStatus: 'under-review',
        assignedTo: { id: actor.id, name: actor.name },
        version: 3,
      },
      proposalDocument: {
        id: documentId,
        status: 'queued',
        sentBy: { id: actor.id, name: actor.name },
      },
    });
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversation.id}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 3,
        name: 'new-quote-request',
      })
      .expect(409);
    await expect(
      prisma.quoteRequest.count({
        where: { companyId: tenantId, conversationId: conversation.id },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.quoteRequest.findUniqueOrThrow({
        where: { id_companyId: { id: quote.id, companyId: tenantId } },
      }),
    ).resolves.toMatchObject({
      status: 'UNDER_REVIEW',
      confirmedAt: expect.any(Date),
    });

    const createBlockedFixture = async (
      suffix: string,
      input: {
        conversationState: 'BOT_ACTIVE' | 'CLOSED';
        flowStep: 'COMMERCIAL_FOLLOW_UP_MENU' | 'CLOSED';
        requestStatus: 'APPROVED' | 'UNDER_REVIEW';
        quoteStatus: 'APPROVED' | 'UNDER_REVIEW';
        closedAt?: Date;
      },
    ) => {
      const blockedContact = await prisma.whatsAppContact.create({
        data: {
          companyId: tenantId,
          phoneNormalized: `551197777${suffix}`,
          displayName: `Cliente bloqueado ${suffix}`,
        },
      });
      const blockedConversation = await prisma.whatsAppConversation.create({
        data: {
          companyId: tenantId,
          channelId,
          contactId: blockedContact.id,
          department: 'COMMERCIAL',
          conversationState: input.conversationState,
          flowStep: input.flowStep,
          requestStatus: input.requestStatus,
          closedAt: input.closedAt,
        },
      });
      const blockedQuote = await prisma.quoteRequest.create({
        data: {
          companyId: tenantId,
          conversationId: blockedConversation.id,
          sequence: 1,
          status: input.quoteStatus,
          confirmedAt: new Date(),
          confirmedVersion: 1,
        },
      });
      const blockedDocument = await prisma.quoteProposalDocument.create({
        data: {
          companyId: tenantId,
          conversationId: blockedConversation.id,
          quoteRequestId: blockedQuote.id,
          uploadedByUserId: actor.id,
          sequence: 1,
          fileName: `orcamento-${suffix}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: pdf.byteLength,
          sha256: 'a'.repeat(64),
          content: Uint8Array.from(pdf),
        },
      });
      return {
        conversation: blockedConversation,
        quote: blockedQuote,
        document: blockedDocument,
      };
    };
    const approved = await createBlockedFixture('3434', {
      conversationState: 'BOT_ACTIVE',
      flowStep: 'COMMERCIAL_FOLLOW_UP_MENU',
      requestStatus: 'APPROVED',
      quoteStatus: 'APPROVED',
    });
    await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${approved.quote.id}/send`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: approved.conversation.version,
        proposalDocumentId: approved.document.id,
        batchId: randomUUID(),
        batchDocumentIds: [approved.document.id],
      })
      .expect(400);

    const closed = await createBlockedFixture('3535', {
      conversationState: 'CLOSED',
      flowStep: 'CLOSED',
      requestStatus: 'UNDER_REVIEW',
      quoteStatus: 'UNDER_REVIEW',
      closedAt: new Date(),
    });
    await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${closed.quote.id}/send`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: closed.conversation.version,
        proposalDocumentId: closed.document.id,
        batchId: randomUUID(),
        batchDocumentIds: [closed.document.id],
      })
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe('QUOTE_CONVERSATION_CLOSED');
      });
  });

  it('altera o status comercial somente pelo atendente responsável e registra auditoria', async () => {
    const actor = await prisma.user.findFirstOrThrow({
      where: { companyId: tenantId, usernameNormalized: 'admin.e2e' },
    });
    const contact = await prisma.whatsAppContact.create({
      data: {
        companyId: tenantId,
        phoneNormalized: '5511977773232',
        displayName: 'Cliente status manual',
      },
    });
    const conversation = await prisma.whatsAppConversation.create({
      data: {
        companyId: tenantId,
        channelId,
        contactId: contact.id,
        department: 'COMMERCIAL',
        conversationState: 'HUMAN_ACTIVE',
        flowStep: 'HUMAN_SERVICE',
        requestStatus: 'COLLECTING_INFORMATION',
        assignedToUserId: actor.id,
      },
    });
    const quote = await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: conversation.id,
        sequence: 1,
        status: 'COLLECTING_INFORMATION',
        contactName: contact.displayName,
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Goiânia',
        departureDate: new Date('2026-08-10T00:00:00.000Z'),
      },
    });
    const commandId = randomUUID();

    await request(app.getHttpServer())
      .patch(`/api/v1/whatsapp/quote-proposals/${quote.id}/status`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId,
        expectedVersion: conversation.version,
        status: 'under-review',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          id: quote.id,
          stage: 'pending',
          idempotent: false,
          quoteRequest: { status: 'under-review' },
          conversation: {
            id: conversation.id,
            requestStatus: 'under-review',
            version: conversation.version + 1,
          },
        });
      });

    await request(app.getHttpServer())
      .patch(`/api/v1/whatsapp/quote-proposals/${quote.id}/status`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId,
        expectedVersion: conversation.version,
        status: 'under-review',
      })
      .expect(200)
      .expect(({ body }) => expect(body.idempotent).toBe(true));

    await request(app.getHttpServer())
      .patch(`/api/v1/whatsapp/quote-proposals/${quote.id}/status`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: conversation.version + 1,
        status: 'waiting-for-customer',
      })
      .expect(400);

    const cancellationReason = 'Cliente desistiu antes do envio da proposta.';
    await request(app.getHttpServer())
      .patch(`/api/v1/whatsapp/quote-proposals/${quote.id}/status`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: conversation.version + 1,
        status: 'cancelled',
        reason: cancellationReason,
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          stage: 'cancelled',
          quoteRequest: {
            status: 'cancelled',
            decision: {
              reason: cancellationReason,
              decidedBy: { id: actor.id, name: actor.name },
            },
          },
          conversation: {
            requestStatus: 'cancelled',
            version: conversation.version + 2,
          },
        });
      });

    expect(
      await prisma.tenantAuditLog.findFirstOrThrow({
        where: {
          companyId: tenantId,
          action: 'whatsapp.quote-proposal.status-change',
          targetId: quote.id,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ).toMatchObject({
      actorUserId: actor.id,
      metadata: expect.objectContaining({
        fromStatus: 'under-review',
        toStatus: 'cancelled',
        reason: cancellationReason,
      }),
    });
  });

  it('persiste PDF, enfileira envio idempotente e só aguarda cliente após confirmação Evolution', async () => {
    const actor = await prisma.user.findFirstOrThrow({
      where: { companyId: tenantId, usernameNormalized: 'admin.e2e' },
    });
    const contact = await prisma.whatsAppContact.create({
      data: {
        companyId: tenantId,
        phoneNormalized: '5511977773333',
        displayName: 'Cliente proposta PDF',
      },
    });
    const proposalConversation = await prisma.whatsAppConversation.create({
      data: {
        companyId: tenantId,
        channelId,
        contactId: contact.id,
        department: 'COMMERCIAL',
        conversationState: 'BOT_ACTIVE',
        flowStep: 'QUOTE_SEND_PENDING',
        requestStatus: 'UNDER_REVIEW',
      },
    });
    const proposalQuote = await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: proposalConversation.id,
        sequence: 1,
        status: 'UNDER_REVIEW',
        contactName: 'Cliente proposta PDF',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Goiânia',
        departureAt: new Date('2026-08-10T12:00:00.000Z'),
        passengerCount: 20,
        confirmedAt: new Date(),
        confirmedVersion: 1,
        confirmedSummary: {
          contactName: 'Cliente proposta PDF',
          serviceType: 'Fretamento eventual',
          origin: 'Uberlândia',
          destination: 'Goiânia',
          departureAt: '2026-08-10T12:00:00.000Z',
          passengerCount: 20,
        },
      },
    });
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
    );

    const queue = await request(app.getHttpServer())
      .get('/api/v1/whatsapp/quote-proposals?page=1&pageSize=100')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(queue.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: proposalQuote.id,
          quoteRequest: expect.objectContaining({
            status: 'under-review',
            origin: 'Uberlândia',
            destination: 'Goiânia',
          }),
          conversation: expect.objectContaining({
            id: proposalConversation.id,
            version: 1,
          }),
          proposalDocument: null,
        }),
      ]),
    );

    await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${proposalQuote.id}/documents`)
      .set('authorization', `Bearer ${accessToken}`)
      .field('commandId', randomUUID())
      .field('expectedVersion', '1')
      .attach('file', Buffer.from('not a pdf'), {
        filename: 'orcamento.pdf',
        contentType: 'application/pdf',
      })
      .expect(400);

    const uploadCommandId = randomUUID();
    const upload = await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${proposalQuote.id}/documents`)
      .set('authorization', `Bearer ${accessToken}`)
      .field('commandId', uploadCommandId)
      .field('expectedVersion', '1')
      .attach('file', pdf, {
        filename: 'orcamento-e2e.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    expect(upload.body).toMatchObject({
      idempotent: false,
      proposalDocument: {
        quoteRequestId: proposalQuote.id,
        conversationId: proposalConversation.id,
        status: 'uploaded',
        fileName: 'orcamento-e2e.pdf',
        mimeType: 'application/pdf',
        sizeBytes: pdf.byteLength,
      },
      conversation: { id: proposalConversation.id, version: 1 },
    });
    expect(upload.body.proposalDocument.sha256).toMatch(/^[0-9a-f]{64}$/);
    const documentId = upload.body.proposalDocument.id as string;
    const duplicateUpload = await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${proposalQuote.id}/documents`)
      .set('authorization', `Bearer ${accessToken}`)
      .field('commandId', uploadCommandId)
      .field('expectedVersion', '1')
      .attach('file', pdf, {
        filename: 'orcamento-e2e.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    expect(duplicateUpload.body).toMatchObject({
      idempotent: true,
      proposalDocument: { id: documentId },
    });
    expect(
      await prisma.quoteProposalDocument.count({
        where: { companyId: tenantId, quoteRequestId: proposalQuote.id },
      }),
    ).toBe(1);

    const panelDownload = await request(app.getHttpServer())
      .get(
        `/api/v1/whatsapp/quote-proposals/${proposalQuote.id}/documents/${documentId}/content`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(panelDownload.body).toEqual(pdf);
    expect(panelDownload.headers['x-content-sha256']).toBe(
      upload.body.proposalDocument.sha256,
    );

    const sendCommandId = randomUUID();
    const sendBatchId = randomUUID();
    const send = await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${proposalQuote.id}/send`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: sendCommandId,
        expectedVersion: 1,
        proposalDocumentId: documentId,
        batchId: sendBatchId,
        batchDocumentIds: [documentId],
      })
      .expect(201);
    expect(send.body).toMatchObject({
      idempotent: false,
      message: {
        direction: 'outbound',
        deliveryStatus: 'pending',
        kind: 'document',
      },
      conversation: {
        id: proposalConversation.id,
        conversationState: 'bot-active',
        assignedTo: { id: actor.id, name: actor.name },
        requestStatus: 'under-review',
        version: 2,
      },
      proposalDocument: {
        id: documentId,
        status: 'queued',
      },
    });
    const messageId = send.body.message.id as string;
    const attemptId = send.body.message.attempts[0].id as string;
    const duplicateSend = await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${proposalQuote.id}/send`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: sendCommandId,
        expectedVersion: 1,
        proposalDocumentId: documentId,
        batchId: sendBatchId,
        batchDocumentIds: [documentId],
      })
      .expect(201);
    expect(duplicateSend.body).toMatchObject({
      idempotent: true,
      message: { id: messageId },
      proposalDocument: { id: documentId },
    });
    expect(
      await prisma.whatsAppMessage.count({
        where: { id: messageId, companyId: tenantId },
      }),
    ).toBe(1);

    const outbound = await prisma.integrationOutbox.findFirstOrThrow({
      where: {
        companyId: tenantId,
        topic: 'whatsapp.outbound.requested',
        aggregateId: proposalConversation.id,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(outbound.payload).toMatchObject({
      commandId: sendCommandId,
      messageId,
      attemptId,
      automatic: false,
      canGenerateReply: false,
      canSendReply: true,
      message: {
        kind: 'document',
        deliveryStatus: 'pending',
        media: {
          documentId,
          fileName: 'orcamento-e2e.pdf',
          mimetype: 'application/pdf',
          sizeBytes: pdf.byteLength,
          sha256: upload.body.proposalDocument.sha256,
          downloadPath: `/internal/whatsapp/proposal-documents/${documentId}/content`,
        },
      },
    });
    const outboundExecutionId = randomUUID();
    await prisma.integrationOutbox.update({
      where: { id: outbound.id },
      data: {
        status: 'PROCESSING',
        executionId: outboundExecutionId,
        acceptedAt: new Date(),
        executionLeaseUntil: new Date(Date.now() + 60_000),
      },
    });
    const outboundCompletion = {
      commandId: randomUUID(),
      executionId: outboundExecutionId,
      aggregateType: outbound.aggregateType,
      aggregateId: outbound.aggregateId,
      outcome: 'succeeded',
    };
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/outbox-events/${outbound.id}/completions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send(outboundCompletion)
      .expect(409);

    const internalDownload = await request(app.getHttpServer())
      .get(`/api/v1/internal/whatsapp/proposal-documents/${documentId}/content`)
      .set('authorization', `Bearer ${serviceToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(internalDownload.body).toEqual(pdf);

    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/messages/${messageId}/evolution-dispatch-claims`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({ commandId: randomUUID(), attemptId })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/internal/whatsapp/messages/${messageId}/evolution-result`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        attemptId,
        status: 'sent',
      })
      .expect(400);
    expect(
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: proposalConversation.id,
            companyId: tenantId,
          },
        },
      }),
    ).toMatchObject({
      conversationState: 'BOT_ACTIVE',
      requestStatus: 'UNDER_REVIEW',
      assignedToUserId: actor.id,
      version: 2,
    });
    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${proposalConversation.id}/actions/forward`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 2,
        targetDepartment: 'operations',
      })
      .expect(409);

    const resultCommandId = randomUUID();
    await request(app.getHttpServer())
      .post(`/api/v1/internal/whatsapp/messages/${messageId}/evolution-result`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: resultCommandId,
        attemptId,
        status: 'sent',
        providerMessageId: 'evolution-proposal-pdf-e2e',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/internal/whatsapp/messages/${messageId}/evolution-result`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: resultCommandId,
        attemptId,
        status: 'sent',
        providerMessageId: 'evolution-proposal-pdf-e2e',
      })
      .expect(201)
      .expect(({ body }) => expect(body.idempotent).toBe(true));
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/outbox-events/${outbound.id}/completions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send(outboundCompletion)
      .expect(201)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          eventId: outbound.id,
          outcome: 'succeeded',
          status: 'delivered',
        });
      });

    expect(
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: proposalConversation.id,
            companyId: tenantId,
          },
        },
      }),
    ).toMatchObject({
      conversationState: 'WAITING_FOR_CUSTOMER',
      flowStep: 'QUOTE_SEND_PENDING',
      requestStatus: 'WAITING_FOR_CUSTOMER',
      assignedToUserId: actor.id,
      version: 3,
    });
    expect(
      await prisma.quoteRequest.findUniqueOrThrow({
        where: {
          id_companyId: { id: proposalQuote.id, companyId: tenantId },
        },
      }),
    ).toMatchObject({
      status: 'WAITING_FOR_CUSTOMER',
      version: 2,
    });
    expect(
      await prisma.quoteProposalDocument.findUniqueOrThrow({
        where: { id_companyId: { id: documentId, companyId: tenantId } },
      }),
    ).toMatchObject({
      status: 'SENT',
      providerMessageId: 'evolution-proposal-pdf-e2e',
      messageId,
    });
    expect(
      await prisma.whatsAppConversationTransition.findFirstOrThrow({
        where: {
          companyId: tenantId,
          conversationId: proposalConversation.id,
          name: 'proposal-delivery-confirmed',
        },
      }),
    ).toMatchObject({
      expectedVersion: 2,
      resultingVersion: 3,
      toState: 'WAITING_FOR_CUSTOMER',
      toRequestStatus: 'WAITING_FOR_CUSTOMER',
    });

    const queueAfterDelivery = await request(app.getHttpServer())
      .get('/api/v1/whatsapp/quote-proposals?page=1&pageSize=100')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    const remainingItems = queueAfterDelivery.body.items as Array<{
      id: string;
    }>;
    expect(remainingItems.some((item) => item.id === proposalQuote.id)).toBe(
      false,
    );

    const sentProposals = await request(app.getHttpServer())
      .get('/api/v1/whatsapp/quote-proposals?stage=sent&page=1&pageSize=100')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(sentProposals.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: proposalQuote.id,
          stage: 'sent',
          quoteRequest: expect.objectContaining({
            status: 'waiting-for-customer',
          }),
          conversation: expect.objectContaining({
            id: proposalConversation.id,
            conversationState: 'waiting-for-customer',
            requestStatus: 'waiting-for-customer',
          }),
          proposalDocument: expect.objectContaining({
            id: documentId,
            status: 'sent',
            providerMessageId: 'evolution-proposal-pdf-e2e',
          }),
        }),
      ]),
    );

    const customerResponse = await signedWebhook(
      app,
      webhookPayload(
        'proposal-customer-response-e2e',
        contact.phoneNormalized,
        'Tenho uma dúvida sobre o orçamento.',
      ),
    ).expect(202);
    expect(customerResponse.body).toMatchObject({
      automationAllowed: false,
      canGenerateReply: false,
      canSendReply: false,
      conversationId: proposalConversation.id,
      version: 4,
    });
    expect(
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: proposalConversation.id,
            companyId: tenantId,
          },
        },
      }),
    ).toMatchObject({
      conversationState: 'SENT_TO_HUMAN',
      flowStep: 'HUMAN_SERVICE',
      requestStatus: 'WAITING_FOR_CUSTOMER',
      resumeFlowStep: 'COMMERCIAL_FOLLOW_UP_MENU',
      version: 4,
    });
    expect(
      await prisma.whatsAppConversationTransition.findFirstOrThrow({
        where: {
          companyId: tenantId,
          conversationId: proposalConversation.id,
          name: 'proposal-response-received',
        },
      }),
    ).toMatchObject({
      expectedVersion: 3,
      resultingVersion: 4,
      toState: 'SENT_TO_HUMAN',
      toFlowStep: 'HUMAN_SERVICE',
    });
    expect(
      await prisma.integrationOutbox.findFirstOrThrow({
        where: {
          companyId: tenantId,
          aggregateId: proposalConversation.id,
          topic: 'whatsapp.inbound.human-notification',
        },
        orderBy: { createdAt: 'desc' },
      }),
    ).toMatchObject({
      topic: 'whatsapp.inbound.human-notification',
    });

    const decisionCommandId = randomUUID();
    const rejectedProposal = await request(app.getHttpServer())
      .patch(`/api/v1/whatsapp/quote-proposals/${proposalQuote.id}/decision`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: decisionCommandId,
        expectedVersion: 4,
        decision: 'rejected',
        reason: 'Cliente solicitou uma nova data para a viagem.',
      })
      .expect(200);
    expect(rejectedProposal.body).toMatchObject({
      id: proposalQuote.id,
      stage: 'cancelled',
      quoteRequest: {
        status: 'rejected',
        decision: {
          status: 'rejected',
          reason: 'Cliente solicitou uma nova data para a viagem.',
          decidedBy: { id: actor.id, name: actor.name },
        },
      },
      conversation: {
        id: proposalConversation.id,
        requestStatus: 'rejected',
        version: 5,
      },
      proposalDocument: {
        id: documentId,
        status: 'sent',
        sentBy: { id: actor.id, name: actor.name },
      },
    });
    const cancelledProposals = await request(app.getHttpServer())
      .get(
        '/api/v1/whatsapp/quote-proposals?stage=cancelled&search=Cliente%20proposta%20PDF&page=1&pageSize=100',
      )
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(cancelledProposals.body).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          id: proposalQuote.id,
          stage: 'cancelled',
          quoteRequest: expect.objectContaining({
            status: 'rejected',
            decision: {
              status: 'rejected',
              reason: 'Cliente solicitou uma nova data para a viagem.',
              decidedAt: expect.any(String),
              decidedBy: { id: actor.id, name: actor.name },
            },
          }),
        }),
      ]),
      summary: {
        pending: expect.any(Number),
        sent: expect.any(Number),
        approved: expect.any(Number),
        cancelled: expect.any(Number),
        cancellationReasons: expect.arrayContaining([
          {
            reason: 'Cliente solicitou uma nova data para a viagem.',
            count: 1,
          },
        ]),
      },
      filters: {
        search: 'Cliente proposta PDF',
        createdFrom: null,
        createdTo: null,
      },
    });
    expect(cancelledProposals.body.summary.cancelled).toBeGreaterThanOrEqual(1);

    await request(app.getHttpServer())
      .get(
        '/api/v1/whatsapp/quote-proposals?stage=approved&page=1&pageSize=100',
      )
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.summary.approved).toBeGreaterThanOrEqual(1);
        expect(
          (body.items as Array<{ quoteRequest: { status: string } }>).every(
            (item) => item.quoteRequest.status === 'approved',
          ),
        ).toBe(true);
      });
    await request(app.getHttpServer())
      .patch(`/api/v1/whatsapp/quote-proposals/${proposalQuote.id}/decision`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: decisionCommandId,
        expectedVersion: 4,
        decision: 'rejected',
        reason: 'Cliente solicitou uma nova data para a viagem.',
      })
      .expect(200)
      .expect(({ body }) => expect(body.idempotent).toBe(true));

    await request(app.getHttpServer())
      .patch(`/api/v1/whatsapp/quote-proposals/${proposalQuote.id}/decision`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 5,
        decision: 'approved',
      })
      .expect(409);
    expect(
      await prisma.quoteRequest.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: proposalQuote.id,
            companyId: tenantId,
          },
        },
      }),
    ).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'Cliente solicitou uma nova data para a viagem.',
      decidedByUserId: actor.id,
    });

    const newProposal = await request(app.getHttpServer())
      .post('/api/v1/whatsapp/quote-proposals')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 5,
        conversationId: proposalConversation.id,
        contactName: 'Cliente proposta PDF',
        document: null,
        email: 'cliente.proposta@example.test',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Brasília',
        departureAt: '2026-09-10T12:00:00.000Z',
        returnAt: null,
        passengerCount: 24,
        vehicleType: 'Ônibus',
        vehicleAtDisposal: false,
        localTransfers: true,
        notes: 'Nova data solicitada pelo cliente.',
      })
      .expect(201);
    expect(newProposal.body).toMatchObject({
      stage: 'pending',
      quoteRequest: {
        sequence: 2,
        status: 'under-review',
        requestedBy: {
          type: 'attendant',
          id: actor.id,
          name: actor.name,
        },
      },
      conversation: {
        id: proposalConversation.id,
        conversationState: 'bot-active',
        flowStep: 'quote-send-pending',
        requestStatus: 'under-review',
        assignedTo: { id: actor.id, name: actor.name },
        version: 6,
      },
      proposalDocument: null,
    });
    expect(
      await prisma.quoteRequest.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: newProposal.body.id as string,
            companyId: tenantId,
          },
        },
      }),
    ).toMatchObject({
      sequence: 2,
      requestedByUserId: actor.id,
      status: 'UNDER_REVIEW',
    });

    const otherAttendantSuffix = randomUUID().slice(0, 8);
    const otherAttendant = await prisma.user.create({
      data: {
        companyId: tenantId,
        name: 'Outro atendente',
        username: `outro.${otherAttendantSuffix}`,
        usernameNormalized: `outro.${otherAttendantSuffix}`,
        email: `${randomUUID()}@example.test`,
        emailNormalized: `${randomUUID()}@example.test`,
        passwordHash: 'hash-e2e-sem-uso',
        departments: ['commercial'],
      },
    });
    await prisma.whatsAppConversation.update({
      where: {
        id_companyId: {
          id: proposalConversation.id,
          companyId: tenantId,
        },
      },
      data: { assignedToUserId: otherAttendant.id },
    });
    await request(app.getHttpServer())
      .post('/api/v1/whatsapp/quote-proposals')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 6,
        conversationId: proposalConversation.id,
        contactName: 'Cliente proposta PDF',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Brasília',
        departureAt: '2026-10-10T12:00:00.000Z',
        passengerCount: 24,
        vehicleAtDisposal: false,
        localTransfers: false,
      })
      .expect(403);
    expect(
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: proposalConversation.id,
            companyId: tenantId,
          },
        },
      }),
    ).toMatchObject({
      assignedToUserId: otherAttendant.id,
      version: 6,
    });
    expect(
      await prisma.quoteRequest.count({
        where: {
          companyId: tenantId,
          conversationId: proposalConversation.id,
        },
      }),
    ).toBe(2);
    expect(actor.isActive).toBe(true);
  });

  it('bloqueia encerramento com proposta ativa e encerra conversa geral sem proposta', async () => {
    const activeInbound = await signedWebhook(
      app,
      webhookPayload(
        'close-active-proposal-contact',
        '5511988877710',
        'Preciso de orçamento',
      ),
    ).expect(202);
    const activeConversationId = activeInbound.body.conversationId as string;
    await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: activeConversationId,
        sequence: 1,
        status: 'COLLECTING_INFORMATION',
      },
    });
    const activeConversation = await prisma.whatsAppConversation.update({
      where: {
        id_companyId: {
          id: activeConversationId,
          companyId: tenantId,
        },
      },
      data: {
        conversationState: 'BOT_ACTIVE',
        flowStep: 'QUOTE_DATA_COLLECTION',
        requestStatus: 'COLLECTING_INFORMATION',
        version: { increment: 1 },
      },
    });

    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${activeConversationId}/actions/close`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: activeConversation.version,
        reason: 'Atendimento interrompido.',
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          details: {
            requestStatus: 'collecting-information',
          },
        }),
      );
    expect(
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: activeConversationId,
            companyId: tenantId,
          },
        },
      }),
    ).toMatchObject({
      conversationState: 'BOT_ACTIVE',
      closedAt: null,
      version: activeConversation.version,
    });

    const approvedHistoryInbound = await signedWebhook(
      app,
      webhookPayload(
        'close-approved-history-contact',
        '5511988877713',
        'Atendimento com viagem aprovada',
      ),
    ).expect(202);
    const approvedHistoryConversationId = approvedHistoryInbound.body
      .conversationId as string;
    await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: approvedHistoryConversationId,
        sequence: 1,
        status: 'APPROVED',
      },
    });
    await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: approvedHistoryConversationId,
        sequence: 2,
        status: 'REJECTED',
        decisionReason: 'Segundo orçamento recusado.',
        decidedAt: new Date(),
      },
    });
    const approvedHistoryConversation =
      await prisma.whatsAppConversation.update({
        where: {
          id_companyId: {
            id: approvedHistoryConversationId,
            companyId: tenantId,
          },
        },
        data: {
          conversationState: 'SENT_TO_HUMAN',
          flowStep: 'HUMAN_SERVICE',
          requestStatus: 'REJECTED',
          version: { increment: 1 },
        },
      });

    await request(app.getHttpServer())
      .get(`/api/v1/whatsapp/conversations/${approvedHistoryConversationId}`)
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          hasApprovedQuoteRequest: true,
          currentQuoteRequest: { status: 'rejected' },
        }),
      );

    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${approvedHistoryConversationId}/actions/close`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: approvedHistoryConversation.version,
        reason: 'Encerramento solicitado pelo atendente.',
      })
      .expect(201)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          conversationState: 'closed',
          requestStatus: 'rejected',
        }),
      );

    const generalInbound = await signedWebhook(
      app,
      webhookPayload(
        'close-general-contact',
        '5511988877711',
        'Atendimento simples',
      ),
    ).expect(202);
    const generalConversationId = generalInbound.body.conversationId as string;
    const generalConversation =
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: {
            id: generalConversationId,
            companyId: tenantId,
          },
        },
      });

    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${generalConversationId}/actions/close`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: generalConversation.version + 1,
      })
      .expect(409)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          details: { currentVersion: generalConversation.version },
        }),
      );

    const closeCommandId = randomUUID();
    const closedResponse = await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${generalConversationId}/actions/close`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: closeCommandId,
        expectedVersion: generalConversation.version,
      })
      .expect(201);
    expect(closedResponse.body).toMatchObject({
      id: generalConversationId,
      conversationState: 'closed',
      flowStep: 'closed',
      requestStatus: 'not-started',
      version: generalConversation.version + 1,
      closure: {
        transitionName: 'close',
        reason: null,
        actor: {
          type: 'user',
          user: { id: expect.any(String) },
        },
      },
      idempotent: false,
    });
    expect(
      await prisma.whatsAppConversationTransition.findUniqueOrThrow({
        where: {
          companyId_commandId: {
            companyId: tenantId,
            commandId: closeCommandId,
          },
        },
      }),
    ).toMatchObject({
      name: 'close',
      metadata: { reason: null, quoteRequestId: null },
    });
    const farewellMessage = await prisma.whatsAppMessage.findFirstOrThrow({
      where: {
        companyId: tenantId,
        conversationId: generalConversationId,
        direction: 'OUTBOUND',
        actorUserId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      include: { attempts: true },
    });
    expect(farewellMessage).toMatchObject({
      deliveryStatus: 'PENDING',
      kind: 'TEXT',
      text: expect.stringContaining('Foi um prazer te atender!'),
      attempts: [expect.objectContaining({ status: 'PENDING' })],
    });
    expect(
      await prisma.integrationOutbox.findFirstOrThrow({
        where: {
          companyId: tenantId,
          aggregateId: generalConversationId,
          topic: 'whatsapp.outbound.requested',
        },
        orderBy: { aggregateSequence: 'desc' },
      }),
    ).toMatchObject({
      payload: expect.objectContaining({
        messageId: farewellMessage.id,
        automatic: false,
        canSendReply: true,
      }),
    });

    const rejectedInbound = await signedWebhook(
      app,
      webhookPayload(
        'close-rejected-without-reason',
        '5511988877712',
        'Recusei a proposta',
      ),
    ).expect(202);
    const rejectedConversationId = rejectedInbound.body
      .conversationId as string;
    await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: rejectedConversationId,
        sequence: 1,
        status: 'REJECTED',
      },
    });
    const rejectedConversation = await prisma.whatsAppConversation.update({
      where: {
        id_companyId: {
          id: rejectedConversationId,
          companyId: tenantId,
        },
      },
      data: {
        conversationState: 'SENT_TO_HUMAN',
        flowStep: 'HUMAN_SERVICE',
        requestStatus: 'REJECTED',
        version: { increment: 1 },
      },
    });
    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${rejectedConversationId}/actions/close`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: rejectedConversation.version,
      })
      .expect(400);

    const explicitReason = 'Proposta recusada pelo cliente.';
    const rejectedCloseCommandId = randomUUID();
    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${rejectedConversationId}/actions/close`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: rejectedCloseCommandId,
        expectedVersion: rejectedConversation.version,
        reason: explicitReason,
      })
      .expect(201);
    expect(
      await prisma.whatsAppConversationTransition.findUniqueOrThrow({
        where: {
          companyId_commandId: {
            companyId: tenantId,
            commandId: rejectedCloseCommandId,
          },
        },
      }),
    ).toMatchObject({
      name: 'close',
      metadata: { reason: explicitReason },
    });
  });

  it('encerra uma proposta recusada e o próximo inbound abre atendimento novo para o bot', async () => {
    const phone = '5511988877700';
    const firstInbound = await signedWebhook(
      app,
      webhookPayload('close-rejected-first-contact', phone, 'Olá'),
    ).expect(202);
    const rejectedConversationId = firstInbound.body.conversationId as string;
    const assignee = await prisma.user.findFirstOrThrow({
      where: {
        companyId: tenantId,
        usernameNormalized: 'admin.e2e',
        isActive: true,
      },
      select: { id: true },
    });

    const rejected = await prisma.whatsAppConversation.update({
      where: {
        id_companyId: {
          id: rejectedConversationId,
          companyId: tenantId,
        },
      },
      data: {
        conversationState: 'HUMAN_ACTIVE',
        flowStep: 'HUMAN_SERVICE',
        requestStatus: 'REJECTED',
        assignedToUserId: assignee.id,
        version: { increment: 1 },
      },
    });
    const decisionReason = 'Cliente recusou a proposta apresentada.';
    await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: rejectedConversationId,
        sequence: 1,
        status: 'REJECTED',
        decisionReason,
        decidedAt: new Date(),
        decidedByUserId: assignee.id,
      },
    });

    const closeCommandId = randomUUID();
    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${rejectedConversationId}/actions/close-after-rejection`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: closeCommandId,
        expectedVersion: rejected.version,
      })
      .expect(201);

    const closed = await prisma.whatsAppConversation.findUniqueOrThrow({
      where: {
        id_companyId: {
          id: rejectedConversationId,
          companyId: tenantId,
        },
      },
    });
    expect(closed).toMatchObject({
      conversationState: 'CLOSED',
      flowStep: 'CLOSED',
      requestStatus: 'REJECTED',
      assignedToUserId: null,
      unreadCount: 0,
    });
    expect(closed.closedAt).toBeInstanceOf(Date);

    const closeTransition =
      await prisma.whatsAppConversationTransition.findUniqueOrThrow({
        where: {
          companyId_commandId: {
            companyId: tenantId,
            commandId: closeCommandId,
          },
        },
      });
    expect(closeTransition).toMatchObject({
      name: 'close',
      actorType: 'USER',
      actorUserId: assignee.id,
      resultingVersion: rejected.version + 1,
      metadata: {
        reason: decisionReason,
      },
    });
    expect(closeTransition.createdAt).toEqual(closed.closedAt);
    expect(
      await prisma.tenantAuditLog.findFirstOrThrow({
        where: {
          companyId: tenantId,
          action: 'whatsapp.conversation.close',
          targetId: rejectedConversationId,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ).toMatchObject({
      actorUserId: assignee.id,
      metadata: {
        transitionId: closeTransition.id,
        transitionName: 'close',
        commandId: closeCommandId,
        reason: decisionReason,
      },
      createdAt: closed.closedAt,
    });

    await request(app.getHttpServer())
      .get(`/api/v1/whatsapp/conversations/${rejectedConversationId}`)
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          id: rejectedConversationId,
          conversationState: 'closed',
          closedAt: closed.closedAt?.toISOString(),
          closure: {
            transitionId: closeTransition.id,
            transitionName: 'close',
            occurredAt: closed.closedAt?.toISOString(),
            reason: decisionReason,
            actor: {
              type: 'user',
              user: { id: assignee.id },
            },
          },
        }),
      );

    await request(app.getHttpServer())
      .get(
        `/api/v1/whatsapp/conversations/${rejectedConversationId}/transitions?page=1&pageSize=100`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) =>
        expect(body.data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: closeTransition.id,
              name: 'close',
              metadata: expect.objectContaining({ reason: decisionReason }),
              actor: {
                type: 'user',
                user: { id: assignee.id, name: expect.any(String) },
              },
              createdAt: closed.closedAt?.toISOString(),
            }),
          ]),
        ),
      );

    await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${rejectedConversationId}/actions/close`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: closeCommandId,
        expectedVersion: rejected.version,
      })
      .expect(201)
      .expect(({ body }) => expect(body.idempotent).toBe(true));

    const nextInbound = await signedWebhook(
      app,
      webhookPayload('close-rejected-next-contact', phone, 'Novo contato'),
    ).expect(202);
    expect(nextInbound.body).toMatchObject({
      isFirstContact: true,
      automationAllowed: true,
      canGenerateReply: true,
      canSendReply: true,
    });
    expect(nextInbound.body.conversationId).not.toBe(rejectedConversationId);

    const reopened = await prisma.whatsAppConversation.findUniqueOrThrow({
      where: {
        id_companyId: {
          id: nextInbound.body.conversationId as string,
          companyId: tenantId,
        },
      },
    });
    expect(reopened).toMatchObject({
      conversationState: 'BOT_ACTIVE',
      flowStep: 'MAIN_MENU',
      requestStatus: 'NOT_STARTED',
      closedAt: null,
    });

    const reopenedConversationId = reopened.id;
    const transitionReopened = (name: string, expectedVersion: number) =>
      request(app.getHttpServer())
        .post(
          `/api/v1/internal/whatsapp/conversations/${reopenedConversationId}/transitions`,
        )
        .set('authorization', `Bearer ${serviceToken}`)
        .send({ commandId: randomUUID(), expectedVersion, name })
        .expect(201);
    await transitionReopened('select-commercial', 1);
    await transitionReopened('start-quote', 2);
    const reopenedQuote = await prisma.quoteRequest.findFirstOrThrow({
      where: {
        companyId: tenantId,
        conversationId: reopenedConversationId,
      },
      orderBy: { sequence: 'desc' },
    });
    await request(app.getHttpServer())
      .patch(`/api/v1/internal/whatsapp/quote-requests/${reopenedQuote.id}`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: reopenedQuote.version,
        contactName: 'Cliente reaberto',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Goiânia',
        departureAt: '2026-11-10T12:00:00.000Z',
        passengerCount: 20,
      })
      .expect(200);
    await transitionReopened('present-quote-summary', 3);
    const reopenedConfirmed = await transitionReopened('confirm-quote', 4);
    expect(reopenedConfirmed.body).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'under-review',
    });
    await request(app.getHttpServer())
      .get('/api/v1/whatsapp/quote-proposals?page=1&pageSize=100')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) =>
        expect(body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: reopenedQuote.id,
              conversation: expect.objectContaining({
                id: reopenedConversationId,
              }),
            }),
          ]),
        ),
      );
  });

  it('mantém múltiplos PDFs no ciclo, atribui o remetente, confirma o lote e abre novo ciclo para o mesmo contato', async () => {
    const actor = await prisma.user.findFirstOrThrow({
      where: { companyId: tenantId, usernameNormalized: 'admin.e2e' },
    });
    await request(app.getHttpServer())
      .post('/api/v1/notifications/commercial.pending-quote-proposals/read')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);

    const contact = await prisma.whatsAppContact.create({
      data: {
        companyId: tenantId,
        phoneNormalized: '5534996305110',
        displayName: 'Cliente ciclo múltiplo',
      },
    });
    const conversation = await prisma.whatsAppConversation.create({
      data: {
        companyId: tenantId,
        channelId,
        contactId: contact.id,
        department: 'COMMERCIAL',
        conversationState: 'BOT_ACTIVE',
        flowStep: 'QUOTE_SEND_PENDING',
        requestStatus: 'UNDER_REVIEW',
      },
    });
    const quote = await prisma.quoteRequest.create({
      data: {
        companyId: tenantId,
        conversationId: conversation.id,
        sequence: 1,
        status: 'UNDER_REVIEW',
        contactName: 'Cliente ciclo múltiplo',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Goiânia',
        departureAt: new Date('2026-09-10T12:00:00.000Z'),
        passengerCount: 18,
        confirmedAt: new Date(),
        confirmedVersion: 1,
        confirmedSummary: { source: 'multi-pdf-e2e' },
      },
    });
    const notificationBeforeRead = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(notificationBeforeRead.body.unreadTotal).toBeGreaterThanOrEqual(1);
    await request(app.getHttpServer())
      .post('/api/v1/notifications/commercial.pending-quote-proposals/read')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => expect(body.unreadTotal).toBe(0));

    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n',
    );
    const upload = async (fileName: string, expectedVersion = 1) =>
      request(app.getHttpServer())
        .post(`/api/v1/whatsapp/quote-proposals/${quote.id}/documents`)
        .set('authorization', `Bearer ${accessToken}`)
        .field('commandId', randomUUID())
        .field('expectedVersion', String(expectedVersion))
        .attach('file', pdf, {
          filename: fileName,
          contentType: 'application/pdf',
        })
        .expect(201);
    const firstDocument = (await upload('orcamento-a.pdf')).body
      .proposalDocument;
    const secondDocument = (await upload('orcamento-b.pdf')).body
      .proposalDocument;
    await request(app.getHttpServer())
      .get(`/api/v1/whatsapp/quote-proposals/${quote.id}`)
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        const documents = body.documents as Array<{ id: string }>;
        expect(body.documents).toHaveLength(2);
        expect(documents.map((document) => document.id)).toEqual(
          expect.arrayContaining([firstDocument.id, secondDocument.id]),
        );
      });

    const batchId = randomUUID();
    const batchDocumentIds = [
      firstDocument.id as string,
      secondDocument.id as string,
    ];
    const sendDocument = async (
      documentId: string,
      expectedVersion: number,
      currentBatchId = batchId,
      currentBatchDocumentIds = batchDocumentIds,
    ) =>
      request(app.getHttpServer())
        .post(`/api/v1/whatsapp/quote-proposals/${quote.id}/send`)
        .set('authorization', `Bearer ${accessToken}`)
        .send({
          commandId: randomUUID(),
          expectedVersion,
          proposalDocumentId: documentId,
          batchId: currentBatchId,
          batchDocumentIds: currentBatchDocumentIds,
        })
        .expect(201);
    const firstSend = await sendDocument(firstDocument.id as string, 1);
    expect(firstSend.body).toMatchObject({
      conversation: {
        conversationState: 'bot-active',
        assignedTo: { id: actor.id, name: actor.name },
        version: 2,
      },
      message: { sentBy: { id: actor.id, name: actor.name } },
    });
    const recordDelivery = async (
      sent: typeof firstSend,
      status: 'sent' | 'failed',
      providerMessageId?: string,
    ) => {
      const messageId = sent.body.message.id as string;
      const attemptId = sent.body.message.attempts[0].id as string;
      await request(app.getHttpServer())
        .post(
          `/api/v1/internal/whatsapp/messages/${messageId}/evolution-dispatch-claims`,
        )
        .set('authorization', `Bearer ${serviceToken}`)
        .send({ commandId: randomUUID(), attemptId })
        .expect(201);
      await request(app.getHttpServer())
        .post(
          `/api/v1/internal/whatsapp/messages/${messageId}/evolution-result`,
        )
        .set('authorization', `Bearer ${serviceToken}`)
        .send({
          commandId: randomUUID(),
          attemptId,
          status,
          ...(providerMessageId ? { providerMessageId } : {}),
        })
        .expect(201);
    };
    await recordDelivery(firstSend, 'sent', 'evolution-multi-a');
    await expect(
      prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: { id: conversation.id, companyId: tenantId },
        },
      }),
    ).resolves.toMatchObject({
      conversationState: 'BOT_ACTIVE',
      requestStatus: 'UNDER_REVIEW',
      assignedToUserId: actor.id,
      version: 2,
    });
    const secondSend = await sendDocument(secondDocument.id as string, 2);
    expect(secondSend.body.conversation).toMatchObject({
      conversationState: 'bot-active',
      assignedTo: { id: actor.id, name: actor.name },
      version: 3,
    });
    await recordDelivery(secondSend, 'failed');
    await expect(
      prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: { id: conversation.id, companyId: tenantId },
        },
      }),
    ).resolves.toMatchObject({
      conversationState: 'BOT_ACTIVE',
      requestStatus: 'UNDER_REVIEW',
      assignedToUserId: actor.id,
      version: 3,
    });
    const retrySecond = await sendDocument(secondDocument.id as string, 3);
    expect(retrySecond.body.conversation.version).toBe(4);
    await recordDelivery(retrySecond, 'sent', 'evolution-multi-b-retry');
    await expect(
      prisma.whatsAppConversation.findUniqueOrThrow({
        where: {
          id_companyId: { id: conversation.id, companyId: tenantId },
        },
      }),
    ).resolves.toMatchObject({
      conversationState: 'WAITING_FOR_CUSTOMER',
      requestStatus: 'WAITING_FOR_CUSTOMER',
      assignedToUserId: actor.id,
      version: 5,
    });
    await request(app.getHttpServer())
      .get(`/api/v1/whatsapp/conversations/${conversation.id}/messages`)
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => {
        const messages = body.data as Array<{
          automationPurpose: string | null;
          sentBy: { id: string; name: string } | null;
        }>;
        const sent = messages.filter(
          (message) => message.automationPurpose === 'quote-proposal',
        );
        expect(sent).toHaveLength(3);
        expect(sent).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sentBy: { id: actor.id, name: actor.name },
            }),
          ]),
        );
      });

    const revisionDocument = (await upload('orcamento-revisado.pdf', 5)).body
      .proposalDocument;
    await prisma.quoteProposalDocument.update({
      where: {
        id_companyId: {
          id: firstDocument.id as string,
          companyId: tenantId,
        },
      },
      data: { deliveryBatchId: null },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/whatsapp/quote-proposals/${quote.id}/send`)
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 5,
        proposalDocumentId: revisionDocument.id,
        batchId: randomUUID(),
        batchDocumentIds: [
          revisionDocument.id as string,
          firstDocument.id as string,
        ],
      })
      .expect(400);
    const revisionBatchId = randomUUID();
    const revisionSend = await sendDocument(
      revisionDocument.id as string,
      5,
      revisionBatchId,
      [revisionDocument.id as string],
    );
    expect(revisionSend.body.conversation.version).toBe(6);
    await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) => expect(body.unreadTotal).toBeGreaterThanOrEqual(1));
    await recordDelivery(revisionSend, 'sent', 'evolution-multi-revision');

    const customerResponse = await signedWebhook(
      app,
      webhookPayload(
        `multi-pdf-response-${randomUUID()}`,
        contact.phoneNormalized,
        'Preciso de um novo orçamento.',
      ),
    ).expect(202);
    expect(customerResponse.body.version).toBe(8);
    const returned = await request(app.getHttpServer())
      .post(
        `/api/v1/whatsapp/conversations/${conversation.id}/actions/return-to-bot`,
      )
      .set('authorization', `Bearer ${accessToken}`)
      .send({ commandId: randomUUID(), expectedVersion: 8 })
      .expect(201);
    expect(returned.body).toMatchObject({
      conversationState: 'bot-active',
      flowStep: 'commercial-follow-up-menu',
      requestStatus: 'waiting-for-customer',
      version: 9,
    });
    const newCycle = await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversation.id}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 9,
        name: 'new-quote-request',
      })
      .expect(201);
    expect(newCycle.body).toMatchObject({
      flowStep: 'quote-data-collection',
      requestStatus: 'collecting-information',
      version: 10,
    });
    const quotes = await prisma.quoteRequest.findMany({
      where: { companyId: tenantId, conversationId: conversation.id },
      orderBy: { sequence: 'asc' },
    });
    expect(quotes).toHaveLength(2);
    expect(quotes.map((item) => [item.sequence, item.status])).toEqual([
      [1, 'WAITING_FOR_CUSTOMER'],
      [2, 'COLLECTING_INFORMATION'],
    ]);

    const nextCycleQuote = quotes[1];
    await request(app.getHttpServer())
      .patch(`/api/v1/internal/whatsapp/quote-requests/${nextCycleQuote.id}`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: nextCycleQuote.version,
        contactName: 'Cliente ciclo múltiplo',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Brasília',
        departureAt: '2026-12-10T12:00:00.000Z',
        passengerCount: 22,
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversation.id}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 10,
        name: 'present-quote-summary',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/api/v1/internal/whatsapp/conversations/${conversation.id}/transitions`,
      )
      .set('authorization', `Bearer ${serviceToken}`)
      .send({
        commandId: randomUUID(),
        expectedVersion: 11,
        name: 'confirm-quote',
      })
      .expect(201)
      .expect(({ body }) =>
        expect(body).toMatchObject({
          conversationState: 'bot-active',
          flowStep: 'commercial-follow-up-menu',
          requestStatus: 'under-review',
          version: 12,
        }),
      );
    await request(app.getHttpServer())
      .get('/api/v1/whatsapp/quote-proposals?page=1&pageSize=100')
      .set('authorization', `Bearer ${accessToken}`)
      .expect(200)
      .expect(({ body }) =>
        expect(body.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: nextCycleQuote.id,
              conversation: expect.objectContaining({ id: conversation.id }),
            }),
          ]),
        ),
      );
  });

  it('returns a public conflict when creating a proposal in a closed conversation', async () => {
    const contact = await prisma.whatsAppContact.create({
      data: {
        companyId: tenantId,
        phoneNormalized: '5534996305220',
        displayName: 'Cliente encerrado',
      },
    });
    const conversation = await prisma.whatsAppConversation.create({
      data: {
        companyId: tenantId,
        channelId,
        contactId: contact.id,
        department: 'COMMERCIAL',
        conversationState: 'CLOSED',
        flowStep: 'CLOSED',
        requestStatus: 'NOT_STARTED',
        closedAt: new Date(),
      },
    });

    await request(app.getHttpServer())
      .post('/api/v1/whatsapp/quote-proposals')
      .set('authorization', `Bearer ${accessToken}`)
      .send({
        conversationId: conversation.id,
        commandId: randomUUID(),
        expectedVersion: 1,
        contactName: 'Cliente encerrado',
        serviceType: 'Fretamento eventual',
        origin: 'Uberlândia',
        destination: 'Goiânia',
        departureAt: '2026-09-10T12:00:00.000Z',
        passengerCount: 18,
        vehicleAtDisposal: false,
        localTransfers: false,
      })
      .expect(409)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          code: 'QUOTE_CONVERSATION_CLOSED',
          message:
            'Não é possível cadastrar proposta em um atendimento encerrado.',
          details: { conversationId: conversation.id },
        });
      });
  });

  it('preserva ao menos um administrador sob despromoção e inativação concorrentes', async () => {
    const isolatedCompanyId = randomUUID();
    await prisma.company.create({
      data: {
        id: isolatedCompanyId,
        legalName: 'Concorrência Administrativa E2E',
        taxId: '99999999000199',
      },
    });
    const [first, second] = await Promise.all([
      prisma.user.create({
        data: {
          companyId: isolatedCompanyId,
          name: 'Administrador A',
          username: 'admin.concorrencia.a',
          usernameNormalized: 'admin.concorrencia.a',
          email: 'admin.concorrencia.a@example.test',
          emailNormalized: 'admin.concorrencia.a@example.test',
          passwordHash: 'hash-sem-uso-e2e-a',
          isAdministrator: true,
        },
      }),
      prisma.user.create({
        data: {
          companyId: isolatedCompanyId,
          name: 'Administrador B',
          username: 'admin.concorrencia.b',
          usernameNormalized: 'admin.concorrencia.b',
          email: 'admin.concorrencia.b@example.test',
          emailNormalized: 'admin.concorrencia.b@example.test',
          passwordHash: 'hash-sem-uso-e2e-b',
          isAdministrator: true,
        },
      }),
    ]);
    const users = app.get(UsersRepository);

    const results = await Promise.all([
      users.updateWithAdministratorInvariant(isolatedCompanyId, first.id, {
        isAdministrator: false,
        departments: ['management'],
        permissionCodes: ['users:manage'],
      }),
      users.updateStatusWithAdministratorInvariant(
        isolatedCompanyId,
        second.id,
        {
          status: 'inactive',
          suspendedUntil: null,
          suspensionReason: null,
          changedAt: new Date(),
        },
      ),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(
      prisma.user.count({
        where: {
          companyId: isolatedCompanyId,
          isAdministrator: true,
          isActive: true,
          status: 'ACTIVE',
        },
      }),
    ).resolves.toBe(1);
  });

  it('preserva o nome live de contato sem referência externa no dry-run e apply', async () => {
    const importRoot = await mkdtemp(
      join(tmpdir(), 'lume-whatsapp-import-live-contact-e2e-'),
    );
    try {
      const service = new WhatsAppImportService(prisma, importRoot);
      const phone = `55117${String(Date.now()).slice(-8)}`;
      const contact = await prisma.whatsAppContact.create({
        data: {
          companyId: tenantId,
          phoneNormalized: phone,
          displayName: 'Nome atual do contato',
        },
      });
      const wallClock = new Date(Date.now() - 6 * 60 * 60 * 1_000);
      const externalConversationId = `legacy-${randomUUID()}`;
      const packagePath = await createLegacyImportPackage({
        root: importRoot,
        directory: 'preserve-live-contact',
        conversations: [
          legacyConversationRow({
            externalId: externalConversationId,
            phone,
            wallClock,
            contactName: 'Nome histórico da planilha',
          }),
        ],
      });
      const batchId = randomUUID();
      const input = {
        companyId: tenantId,
        channelId,
        actorUsername: 'admin.e2e',
        batchName: `e2e-live-contact-${batchId}`,
        batchId,
        packagePath,
        cutoffAt: new Date(Date.now() + 60 * 60 * 1_000),
        confirmation: `APPLY:${batchId}`,
      };

      await expect(service.validate(input)).resolves.toMatchObject({
        valid: true,
        counts: {
          contactsToCreate: 0,
          contactsToUpdate: 0,
          conversationsToCreate: 1,
        },
      });
      await expect(service.apply(input)).resolves.toMatchObject({
        counts: {
          contactsToCreate: 0,
          contactsToUpdate: 0,
          conversationsToCreate: 1,
        },
      });
      await expect(
        prisma.whatsAppContact.findUniqueOrThrow({
          where: {
            id_companyId: { id: contact.id, companyId: tenantId },
          },
        }),
      ).resolves.toMatchObject({
        displayName: 'Nome atual do contato',
      });
      await service.rollback({
        companyId: tenantId,
        batchId,
        actorUsername: 'admin.e2e',
        confirmation: `ROLLBACK:${batchId}`,
      });
    } finally {
      await rm(importRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('importa historico silenciosamente, retoma lote, reconcilia e protege rollback', async () => {
    const importRoot = await mkdtemp(
      join(tmpdir(), 'lume-whatsapp-import-e2e-'),
    );
    try {
      const service = new WhatsAppImportService(prisma, importRoot);
      const wallClock = new Date(Date.now() - 6 * 60 * 60 * 1_000);
      const cutoffAt = new Date(Date.now() + 60 * 60 * 1_000);
      const externalConversationId = `legacy-${randomUUID()}`;
      const externalMessageId = `message-${randomUUID()}`;
      const externalDocumentId = `document-${randomUUID()}`;
      const phone = `55119${String(Date.now()).slice(-8)}`;
      const firstPackage = await createLegacyImportPackage({
        root: importRoot,
        directory: 'first-batch',
        conversations: [
          legacyConversationRow({
            externalId: externalConversationId,
            phone,
            wallClock,
            contactName: 'Cliente importado E2E',
            origin: 'Uberlandia',
            destination: 'Goiania',
            quoteSequence: 1,
          }),
        ],
        messages: [
          legacyMessageRow(
            externalConversationId,
            externalMessageId,
            wallClock,
          ),
        ],
        documents: [
          legacyDocumentRow(externalConversationId, externalDocumentId, 1),
        ],
        includePdf: true,
      });
      const batchId = randomUUID();
      const batchName = `e2e-${batchId}`;
      const input = {
        companyId: tenantId,
        channelId,
        actorUsername: 'admin.e2e',
        batchName,
        batchId,
        packagePath: firstPackage,
        cutoffAt,
        confirmation: `APPLY:${batchId}`,
      };

      const dryRun = await service.validate(input);
      expect(dryRun).toMatchObject({
        valid: true,
        zeroWrites: true,
        counts: {
          conversations: 1,
          messagesToCreate: 1,
          documentsToCreate: 1,
        },
      });
      const outboxBefore = await prisma.integrationOutbox.count({
        where: { companyId: tenantId },
      });
      const applied = await service.apply(input);
      expect(applied).toMatchObject({
        status: 'applied',
        idempotentReplay: false,
        outboxCreatedByImporter: 0,
        counts: {
          conversations: 1,
          contactsToCreate: 1,
          conversationsToCreate: 1,
          quoteRequestsToCreate: 1,
          messagesToCreate: 1,
          documentsToCreate: 1,
        },
      });
      await expect(
        prisma.integrationOutbox.count({
          where: { companyId: tenantId },
        }),
      ).resolves.toBe(outboxBefore);

      const conversationReference =
        await prisma.whatsAppImportExternalRef.findUniqueOrThrow({
          where: {
            companyId_entityType_sourceSystem_externalId: {
              companyId: tenantId,
              entityType: 'conversation',
              sourceSystem: 'legacy-e2e',
              externalId: externalConversationId,
            },
          },
        });
      const importedConversation =
        await prisma.whatsAppConversation.findUniqueOrThrow({
          where: {
            id_companyId: {
              id: conversationReference.internalId,
              companyId: tenantId,
            },
          },
          include: {
            quoteRequests: true,
            messages: true,
            proposalDocuments: true,
          },
        });
      expect(importedConversation.quoteRequests).toHaveLength(1);
      expect(importedConversation.messages).toHaveLength(1);
      expect(importedConversation.proposalDocuments).toHaveLength(1);
      expect(
        Buffer.from(importedConversation.proposalDocuments[0].content)
          .subarray(0, 5)
          .toString('ascii'),
      ).toBe('%PDF-');
      await expect(
        prisma.tenantAuditLog.count({
          where: {
            companyId: tenantId,
            action: 'legacy-conversation-imported',
            targetId: importedConversation.id,
          },
        }),
      ).resolves.toBe(1);

      await expect(service.apply(input)).resolves.toMatchObject({
        idempotentReplay: true,
        outboxCreatedByImporter: 0,
      });
      await prisma.whatsAppImportBatch.update({
        where: { id: batchId },
        data: {
          claimId: randomUUID(),
          leaseUntil: new Date(Date.now() + 60_000),
        },
      });
      await expect(service.apply(input)).rejects.toThrow(
        /rollback reivindicado/i,
      );
      await prisma.whatsAppImportBatch.update({
        where: { id: batchId },
        data: { claimId: null, leaseUntil: null },
      });
      await expect(
        service.apply({
          ...input,
          cutoffAt: new Date(cutoffAt.getTime() + 1),
        }),
      ).rejects.toThrow(/batchId.*tenant.*planilha diferente/i);

      await prisma.whatsAppImportBatch.update({
        where: { id: batchId },
        data: { status: WhatsAppImportBatchStatus.FAILED },
      });
      const resumed = await service.apply(input);
      expect(resumed).toMatchObject({
        idempotentReplay: false,
        counts: {
          conversations: 1,
          conversationsToCreate: 1,
          messagesToCreate: 1,
          documentsToCreate: 1,
        },
      });
      const reconciled = await service.reconcile(tenantId, batchId);
      expect(reconciled).toMatchObject({
        valid: true,
        counts: {
          records: 1,
          conversations: 1,
          messages: 1,
          documents: 1,
          outboxDeltaDuringApply: 0,
        },
      });

      const persistedBatch = await prisma.whatsAppImportBatch.findUniqueOrThrow(
        {
          where: { id: batchId },
        },
      );
      const originalAppliedCounts =
        persistedBatch.appliedCounts as Prisma.InputJsonValue;
      await prisma.whatsAppImportBatch.update({
        where: { id: batchId },
        data: {
          appliedCounts: {
            ...(originalAppliedCounts as Record<string, Prisma.JsonValue>),
            messagesToCreate: 99,
          },
        },
      });
      const inconsistent = await service.reconcile(tenantId, batchId);
      expect(inconsistent.valid).toBe(false);
      expect(inconsistent.issues).toContainEqual(
        expect.objectContaining({ code: 'MESSAGE_COUNT_MISMATCH' }),
      );
      await prisma.whatsAppImportBatch.update({
        where: { id: batchId },
        data: { appliedCounts: originalAppliedCounts },
      });

      const updatePackage = await createLegacyImportPackage({
        root: importRoot,
        directory: 'update-batch',
        conversations: [
          legacyConversationRow({
            externalId: externalConversationId,
            phone,
            wallClock,
            contactName: 'Cliente importado atualizado',
            origin: 'Araguari',
            destination: 'Goiania',
            quoteSequence: 1,
          }),
        ],
      });
      const updateBatchId = randomUUID();
      const updateInput = {
        companyId: tenantId,
        channelId,
        actorUsername: 'admin.e2e',
        batchName: `e2e-update-${updateBatchId}`,
        batchId: updateBatchId,
        packagePath: updatePackage,
        cutoffAt,
        confirmation: `APPLY:${updateBatchId}`,
      };
      await expect(service.apply(updateInput)).resolves.toMatchObject({
        counts: {
          conversationsToUpdate: 1,
          quoteRequestsToUpdate: 1,
        },
      });
      const changedQuote = await prisma.quoteRequest.findFirstOrThrow({
        where: {
          companyId: tenantId,
          conversationId: importedConversation.id,
          sequence: 1,
        },
      });
      expect(changedQuote.origin).toBe('Araguari');

      await expect(
        service.rollback({
          companyId: tenantId,
          batchId: updateBatchId,
          actorUsername: 'admin.e2e',
          confirmation: `ROLLBACK:${updateBatchId}`,
        }),
      ).resolves.toMatchObject({
        status: 'rolled-back',
        recordsRolledBack: 1,
      });
      const restoredQuote = await prisma.quoteRequest.findFirstOrThrow({
        where: {
          companyId: tenantId,
          conversationId: importedConversation.id,
          sequence: 1,
        },
      });
      expect(restoredQuote).toMatchObject({
        sequence: 1,
        origin: 'Uberlandia',
      });

      const guardedExternalId = `legacy-${randomUUID()}`;
      const guardedPhone = `55118${String(Date.now()).slice(-8)}`;
      const guardedPackage = await createLegacyImportPackage({
        root: importRoot,
        directory: 'rollback-guard-batch',
        conversations: [
          legacyConversationRow({
            externalId: guardedExternalId,
            phone: guardedPhone,
            wallClock,
          }),
        ],
      });
      const guardedBatchId = randomUUID();
      const guardedCutoff = new Date(Date.now() - 60 * 1_000);
      await service.apply({
        companyId: tenantId,
        channelId,
        actorUsername: 'admin.e2e',
        batchName: `e2e-guard-${guardedBatchId}`,
        batchId: guardedBatchId,
        packagePath: guardedPackage,
        cutoffAt: guardedCutoff,
        confirmation: `APPLY:${guardedBatchId}`,
      });
      const guardedRecord = await prisma.whatsAppImportRecord.findFirstOrThrow({
        where: {
          companyId: tenantId,
          batchId: guardedBatchId,
        },
      });
      const realMessage = await prisma.whatsAppMessage.create({
        data: {
          companyId: tenantId,
          conversationId: guardedRecord.conversationId,
          channelId,
          contactId: guardedRecord.contactId,
          direction: MessageDirection.INBOUND,
          deliveryStatus: DeliveryStatus.RECEIVED,
          kind: MessageKind.TEXT,
          text: 'Interacao posterior ao corte',
          correlationId: `e2e-real-${randomUUID()}`,
          occurredAt: new Date(),
        },
      });
      await expect(
        service.rollback({
          companyId: tenantId,
          batchId: guardedBatchId,
          actorUsername: 'admin.e2e',
          confirmation: `ROLLBACK:${guardedBatchId}`,
        }),
      ).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'POST_CUTOFF_INTERACTION' }),
        ]),
      });
      await prisma.whatsAppMessage.delete({
        where: {
          id_companyId: {
            id: realMessage.id,
            companyId: tenantId,
          },
        },
      });
      await service.rollback({
        companyId: tenantId,
        batchId: guardedBatchId,
        actorUsername: 'admin.e2e',
        confirmation: `ROLLBACK:${guardedBatchId}`,
      });

      await expect(
        service.rollback({
          companyId: tenantId,
          batchId,
          actorUsername: 'admin.e2e',
          confirmation: `ROLLBACK:${batchId}`,
        }),
      ).resolves.toMatchObject({
        status: 'rolled-back',
        recordsRolledBack: 1,
      });
      await expect(
        service.rollback({
          companyId: tenantId,
          batchId,
          actorUsername: 'admin.e2e',
          confirmation: `ROLLBACK:${batchId}`,
        }),
      ).resolves.toMatchObject({
        recordsRolledBack: 0,
      });
    } finally {
      await rm(importRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

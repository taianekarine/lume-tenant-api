import 'dotenv/config';

import { execFileSync } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const channelId = '00000000-0000-4000-8000-000000000221';
const serviceKeyId = '00000000-0000-4000-8000-000000000222';
const serviceSecret = 'n8n-service-secret-with-more-than-32-characters';
const webhookSecret = 'evolution-webhook-secret-with-more-than-32-characters';
const tenantId = '00000000-0000-4000-8000-000000000210';
const installationId = '00000000-0000-4000-8000-000000000211';

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
  let app: INestApplication;
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
    app = await NestFactory.create(AppModule, {
      rawBody: true,
      logger: ['error'],
    });
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

    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({
        identifier: 'admin.e2e',
        password: 'SenhaForte@2026',
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
      conversationState: 'sent-to-human',
      flowStep: 'quote-send-pending',
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
        name: 'new-quote-request',
      })
      .expect(400);
  });

  it('captura todas as mensagens na fila humana e preserva o histórico após take-over', async () => {
    const beforeSentToHumanInbounds =
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: { id_companyId: { id: conversationId, companyId: tenantId } },
      });
    expect(beforeSentToHumanInbounds).toMatchObject({
      conversationState: 'SENT_TO_HUMAN',
      flowStep: 'QUOTE_SEND_PENDING',
      version: 8,
    });
    const sentToHumanInbounds = [
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
    const sentToHumanResponses = await Promise.all(
      sentToHumanInbounds.map(({ providerMessageId, text }) =>
        signedWebhook(
          app,
          webhookPayload(providerMessageId, '5511988881111', text),
        ),
      ),
    );
    for (const response of sentToHumanResponses) {
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        accepted: true,
        duplicate: false,
        automationAllowed: false,
      });
    }
    expect(
      await prisma.whatsAppConversation.findUniqueOrThrow({
        where: { id_companyId: { id: conversationId, companyId: tenantId } },
      }),
    ).toMatchObject({
      conversationState: 'SENT_TO_HUMAN',
      flowStep: 'QUOTE_SEND_PENDING',
      version: 8,
      unreadCount:
        beforeSentToHumanInbounds.unreadCount + sentToHumanInbounds.length,
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
    const allHumanRoutedInbounds = [...sentToHumanInbounds, ...humanInbounds];
    for (const inbound of allHumanRoutedInbounds) {
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
      allHumanRoutedInbounds.map(({ providerMessageId }) => providerMessageId),
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
    expect(humanNotifications).toHaveLength(allHumanRoutedInbounds.length);
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
});

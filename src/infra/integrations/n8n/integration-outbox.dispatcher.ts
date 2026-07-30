import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { sanitizeLogText } from '../../../shared/utils/sensitive-data';
import { IntegrationOutboxStatus } from '../../database/prisma/generated/client';
import { PrismaService } from '../../database/prisma/prisma.service';

interface DispatchableOutboxEvent {
  id: string;
  companyId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number;
  executionId: string | null;
  correlationId: string;
  createdAt: Date;
  payload: unknown;
}

export function buildN8nEnvelope(event: DispatchableOutboxEvent) {
  return {
    schemaVersion: '1.0' as const,
    id: event.id,
    companyId: event.companyId,
    topic: event.topic,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateSequence: event.aggregateSequence,
    executionId: event.executionId,
    correlationId: event.correlationId,
    occurredAt: event.createdAt.toISOString(),
    payload: event.payload,
  };
}

@Injectable()
export class IntegrationOutboxDispatcher
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(IntegrationOutboxDispatcher.name);
  private readonly enabled: boolean;
  private readonly webhookUrl: string;
  private readonly bearerSecret: string;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly maximumBackoffMs: number;
  private readonly executionTimeoutMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('N8N_DISPATCH_ENABLED') ?? false;
    this.webhookUrl = config.get<string>('N8N_WEBHOOK_URL') ?? '';
    this.bearerSecret = config.get<string>('N8N_OUTBOUND_SECRET') ?? '';
    this.intervalMs = config.get<number>('N8N_DISPATCH_INTERVAL_MS') ?? 500;
    this.requestTimeoutMs =
      config.get<number>('N8N_REQUEST_TIMEOUT_MS') ?? 10_000;
    this.baseBackoffMs = config.get<number>('N8N_RETRY_BASE_DELAY_MS') ?? 1_000;
    this.maximumBackoffMs =
      config.get<number>('N8N_RETRY_MAX_DELAY_MS') ?? 300_000;
    this.executionTimeoutMs =
      config.get<number>('N8N_EXECUTION_TIMEOUT_MS') ?? 300_000;
    this.batchSize = config.get<number>('N8N_DISPATCH_BATCH_SIZE') ?? 20;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Dispatcher n8n desabilitado por configuração.');
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => {
        this.logger.error(
          `Falha no ciclo da outbox: ${sanitizeLogText(String(error))}`,
        );
      });
    }, this.intervalMs);
    this.timer.unref();
    void this.tick().catch((error: unknown) => {
      this.logger.error(
        `Falha no ciclo inicial da outbox: ${sanitizeLogText(String(error))}`,
      );
    });
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const staleLock = new Date(now.valueOf() - this.requestTimeoutMs * 3);
      await this.prisma.$executeRaw`
        UPDATE "integration_outbox"
        SET
          "status" = 'dead',
          "execution_id" = NULL,
          "accepted_at" = NULL,
          "execution_lease_until" = NULL,
          "locked_at" = NULL,
          "lock_id" = NULL,
          "last_error" = 'n8n execution completion timeout exhausted',
          "updated_at" = ${now}
        WHERE "attempts" >= "max_attempts"
          AND (
            "status" = 'pending'
            OR (
              "status" = 'processing'
              AND "lock_id" IS NULL
              AND "execution_lease_until" <= ${now}
            )
          )
      `;
      const candidates = await this.prisma.$queryRaw<
        Array<{ id: string; lockId: string }>
      >`
        WITH candidates AS (
          SELECT candidate."id", gen_random_uuid() AS "execution_id"
          FROM "integration_outbox" AS candidate
          WHERE candidate."topic" IN (
            'whatsapp.inbound.persisted',
            'whatsapp.inbound.human-notification',
            'whatsapp.outbound.requested'
          )
          AND candidate."available_at" <= ${now}
          AND (
            candidate."status" = 'pending'
            OR (
              candidate."status" = 'processing'
              AND (
                (
                  candidate."lock_id" IS NOT NULL
                  AND candidate."locked_at" < ${staleLock}
                )
                OR (
                  candidate."lock_id" IS NULL
                  AND candidate."execution_lease_until" <= ${now}
                )
              )
            )
          )
          AND candidate."attempts" < candidate."max_attempts"
          AND NOT EXISTS (
            SELECT 1
            FROM "integration_outbox" AS predecessor
            WHERE predecessor."company_id" = candidate."company_id"
              AND predecessor."aggregate_type" = candidate."aggregate_type"
              AND predecessor."aggregate_id" = candidate."aggregate_id"
              AND predecessor."aggregate_sequence" < candidate."aggregate_sequence"
              AND predecessor."status" <> 'delivered'
          )
          ORDER BY candidate."available_at", candidate."created_at", candidate."id"
          FOR UPDATE SKIP LOCKED
          LIMIT ${this.batchSize}
        )
        UPDATE "integration_outbox" AS claimed
        SET
          "status" = 'processing',
          "locked_at" = ${now},
          "lock_id" = candidates."execution_id",
          "execution_id" = candidates."execution_id",
          "updated_at" = ${now}
        FROM candidates
        WHERE claimed."id" = candidates."id"
        RETURNING claimed."id", claimed."lock_id"::text AS "lockId"
      `;

      await Promise.all(
        candidates.map((candidate) =>
          this.dispatch(candidate.id, candidate.lockId),
        ),
      );
    } finally {
      this.running = false;
    }
  }

  private async dispatch(outboxId: string, lockId: string): Promise<void> {
    const event = await this.prisma.integrationOutbox.findUnique({
      where: { id: outboxId },
    });
    if (!event || event.lockId !== lockId || event.executionId !== lockId) {
      return;
    }

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.bearerSecret}`,
          'content-type': 'application/json',
          'x-lume-correlation-id': event.correlationId,
          'x-lume-event-id': event.id,
          'x-lume-execution-id': lockId,
        },
        body: JSON.stringify(buildN8nEnvelope(event)),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (response.status !== 202) {
        throw new Error(
          `n8n deve confirmar aceite com HTTP 202; recebeu ${response.status}.`,
        );
      }
      const acceptedAt = new Date();
      await this.prisma.integrationOutbox.updateMany({
        where: {
          id: event.id,
          status: IntegrationOutboxStatus.PROCESSING,
          lockId,
        },
        data: {
          attempts: { increment: 1 },
          acceptedAt,
          executionLeaseUntil: new Date(
            acceptedAt.valueOf() + this.executionTimeoutMs,
          ),
          lockedAt: null,
          lockId: null,
          lastError: null,
        },
      });
      this.logger.log(
        `Evento aceito topic=${event.topic} outboxId=${event.id} executionId=${lockId} correlationId=${event.correlationId}`,
      );
    } catch (error) {
      const attempts = event.attempts + 1;
      const dead = attempts >= event.maxAttempts;
      const backoff = Math.min(
        this.baseBackoffMs * 2 ** Math.max(0, attempts - 1),
        this.maximumBackoffMs,
      );
      await this.prisma.integrationOutbox.updateMany({
        where: {
          id: event.id,
          status: IntegrationOutboxStatus.PROCESSING,
          lockId,
        },
        data: {
          status: dead
            ? IntegrationOutboxStatus.DEAD
            : IntegrationOutboxStatus.PENDING,
          attempts,
          availableAt: new Date(Date.now() + backoff),
          lockedAt: null,
          lockId: null,
          executionId: null,
          acceptedAt: null,
          executionLeaseUntil: null,
          lastError: sanitizeLogText(String(error)),
        },
      });
      this.logger.warn(
        `Entrega n8n falhou outboxId=${event.id} correlationId=${event.correlationId} attempts=${attempts} dead=${dead}`,
      );
    }
  }
}

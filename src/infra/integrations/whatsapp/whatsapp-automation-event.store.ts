import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type ClaimedWhatsAppAutomationEvent,
  type WhatsAppAutomationTopic,
} from '../../../application/contracts/whatsapp-automation.provider';
import { sanitizeLogText } from '../../../shared/utils/sensitive-data';
import {
  IntegrationOutboxStatus,
  WhatsAppAutomationExecutionStatus,
  WhatsAppAutomationProvider,
} from '../../database/prisma/generated/client';
import { PrismaService } from '../../database/prisma/prisma.service';

interface ClaimedRow {
  id: string;
  companyId: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  aggregateSequence: number;
  executionId: string;
  correlationId: string;
  createdAt: Date;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

@Injectable()
export class WhatsAppAutomationEventStore {
  private readonly requestTimeoutMs: number;
  private readonly apiExecutionTimeoutMs: number;
  private readonly baseBackoffMs: number;
  private readonly maximumBackoffMs: number;
  private readonly apiDebounceMs: number;
  private readonly apiDepartmentCollectionMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.requestTimeoutMs =
      config.get<number>('WHATSAPP_API_REQUEST_TIMEOUT_MS') ?? 10_000;
    this.apiExecutionTimeoutMs =
      config.get<number>('WHATSAPP_API_EXECUTION_TIMEOUT_MS') ?? 480_000;
    this.baseBackoffMs =
      config.get<number>('WHATSAPP_API_RETRY_BASE_DELAY_MS') ?? 1_000;
    this.maximumBackoffMs =
      config.get<number>('WHATSAPP_API_RETRY_MAX_DELAY_MS') ?? 300_000;
    this.apiDebounceMs =
      config.get<number>('WHATSAPP_API_DEBOUNCE_MS') ?? 2_000;
    this.apiDepartmentCollectionMs =
      config.get<number>('WHATSAPP_API_DEPARTMENT_COLLECTION_MS') ?? 120_000;
  }

  async claim(batchSize: number): Promise<ClaimedWhatsAppAutomationEvent[]> {
    const now = new Date();
    const staleLock = new Date(now.valueOf() - this.requestTimeoutMs * 3);
    const normalBatchReadyAt = new Date(now.valueOf() - this.apiDebounceMs);
    const departmentBatchReadyAt = new Date(
      now.valueOf() - this.apiDepartmentCollectionMs,
    );
    const departmentCompletionReadyAt = new Date(now.valueOf() - 100);
    const providerValue = WhatsAppAutomationProvider.API;

    return this.prisma.$transaction(async (transaction) => {
      await transaction.whatsAppAutomationExecution.updateMany({
        where: {
          status: {
            in: [
              WhatsAppAutomationExecutionStatus.CLAIMED,
              WhatsAppAutomationExecutionStatus.ACCEPTED,
            ],
          },
          outboxEvent: {
            status: IntegrationOutboxStatus.PROCESSING,
            OR: [
              { lockId: { not: null }, lockedAt: { lt: staleLock } },
              { lockId: null, executionLeaseUntil: { lte: now } },
            ],
          },
        },
        data: {
          status: WhatsAppAutomationExecutionStatus.RETRYABLE_FAILURE,
          completedAt: now,
          errorCode: 'EXECUTION_LEASE_EXPIRED',
          errorMessage: 'A execução não foi concluída dentro da concessão.',
        },
      });

      await transaction.$executeRaw`
        UPDATE "integration_outbox"
        SET
          "status" = 'dead',
          "execution_id" = NULL,
          "accepted_at" = NULL,
          "execution_lease_until" = NULL,
          "locked_at" = NULL,
          "lock_id" = NULL,
          "last_error" = 'automation execution completion timeout exhausted',
          "updated_at" = ${now}
        WHERE "attempts" >= "max_attempts"
          AND (
            "status" = 'pending'
            OR (
              "status" = 'processing'
              AND (
                (
                  "lock_id" IS NULL
                  AND "execution_lease_until" <= ${now}
                )
                OR (
                  "lock_id" IS NOT NULL
                  AND "locked_at" < ${staleLock}
                )
              )
            )
          )
      `;

      await transaction.whatsAppAutomationExecution.updateMany({
        where: {
          status: WhatsAppAutomationExecutionStatus.RETRYABLE_FAILURE,
          errorCode: 'EXECUTION_LEASE_EXPIRED',
          outboxEvent: { status: IntegrationOutboxStatus.DEAD },
        },
        data: {
          status: WhatsAppAutomationExecutionStatus.TERMINAL_FAILURE,
          errorCode: 'EXECUTION_LEASE_EXPIRED_EXHAUSTED',
          errorMessage: 'A execução expirou e esgotou as tentativas.',
        },
      });

      const claimed = await transaction.$queryRaw<ClaimedRow[]>`
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
            candidate."processing_provider" IS NULL
            OR candidate."processing_provider" = 'api'::"WhatsAppAutomationProvider"
          )
          AND (
            candidate."topic" NOT IN (
              'whatsapp.inbound.persisted',
              'whatsapp.inbound.human-notification'
            )
            OR (
              candidate."payload" #>> '{conversation,departmentContactOption}' IS NOT NULL
              AND (
                candidate."created_at" <= ${departmentBatchReadyAt}
                OR (
                  candidate."created_at" <= ${departmentCompletionReadyAt}
                  AND lower(btrim(candidate."payload" #>> '{message,text}')) IN (
                    'fim',
                    'concluído',
                    'concluido',
                    'pode encaminhar'
                  )
                )
              )
            )
            OR (
              candidate."payload" #>> '{conversation,departmentContactOption}' IS NULL
              AND candidate."created_at" <= ${normalBatchReadyAt}
            )
          )
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
          LIMIT ${batchSize}
        )
        UPDATE "integration_outbox" AS claimed
        SET
          "status" = 'processing',
          "locked_at" = ${now},
          "lock_id" = candidates."execution_id",
          "execution_id" = candidates."execution_id",
          "processing_provider" = 'api'::"WhatsAppAutomationProvider",
          "attempts" = claimed."attempts" + 1,
          "updated_at" = ${now}
        FROM candidates
        WHERE claimed."id" = candidates."id"
        RETURNING
          claimed."id",
          claimed."company_id" AS "companyId",
          claimed."topic",
          claimed."aggregate_type" AS "aggregateType",
          claimed."aggregate_id" AS "aggregateId",
          claimed."aggregate_sequence" AS "aggregateSequence",
          claimed."execution_id"::text AS "executionId",
          claimed."correlation_id" AS "correlationId",
          claimed."created_at" AS "createdAt",
          claimed."payload",
          claimed."attempts",
          claimed."max_attempts" AS "maxAttempts"
      `;

      if (claimed.length > 0) {
        await transaction.whatsAppAutomationExecution.createMany({
          data: claimed.map((event) => ({
            companyId: event.companyId,
            outboxEventId: event.id,
            executionId: event.executionId,
            provider: providerValue,
            attemptNumber: event.attempts,
            status: WhatsAppAutomationExecutionStatus.CLAIMED,
            startedAt: now,
          })),
        });
      }

      return claimed.map((event) => ({
        ...event,
        topic: event.topic as WhatsAppAutomationTopic,
      }));
    });
  }

  async markAccepted(event: ClaimedWhatsAppAutomationEvent): Promise<void> {
    const now = new Date();
    const provider = WhatsAppAutomationProvider.API;
    const accepted = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.integrationOutbox.updateMany({
        where: {
          id: event.id,
          companyId: event.companyId,
          status: IntegrationOutboxStatus.PROCESSING,
          executionId: event.executionId,
          lockId: event.executionId,
          processingProvider: provider,
        },
        data: {
          acceptedAt: now,
          executionLeaseUntil: new Date(
            now.valueOf() + this.apiExecutionTimeoutMs,
          ),
          lockedAt: null,
          lockId: null,
          lastError: null,
        },
      });
      if (updated.count !== 1) {
        const completedExecution =
          await transaction.whatsAppAutomationExecution.findUnique({
            where: {
              companyId_executionId: {
                companyId: event.companyId,
                executionId: event.executionId,
              },
            },
            select: { status: true, provider: true },
          });
        return Boolean(
          completedExecution &&
          completedExecution.provider === provider &&
          completedExecution.status !==
            WhatsAppAutomationExecutionStatus.CLAIMED,
        );
      }
      await transaction.whatsAppAutomationExecution.update({
        where: {
          companyId_executionId: {
            companyId: event.companyId,
            executionId: event.executionId,
          },
        },
        data: {
          status: WhatsAppAutomationExecutionStatus.ACCEPTED,
          acceptedAt: now,
          errorCode: null,
          errorMessage: null,
        },
      });
      return true;
    });
    if (!accepted) {
      throw new Error('A execução não está mais disponível para aceite.');
    }
  }

  async rejectBeforeAcceptance(
    event: ClaimedWhatsAppAutomationEvent,
    error: unknown,
  ): Promise<void> {
    const attempts = event.attempts;
    const dead = attempts >= event.maxAttempts;
    const backoff = Math.min(
      this.baseBackoffMs * 2 ** Math.max(0, attempts - 1),
      this.maximumBackoffMs,
    );
    const message = sanitizeLogText(String(error)).slice(0, 500);
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.integrationOutbox.updateMany({
        where: {
          id: event.id,
          companyId: event.companyId,
          status: IntegrationOutboxStatus.PROCESSING,
          executionId: event.executionId,
          lockId: event.executionId,
        },
        data: {
          status: dead
            ? IntegrationOutboxStatus.DEAD
            : IntegrationOutboxStatus.PENDING,
          attempts,
          availableAt: new Date(now.valueOf() + backoff),
          lockedAt: null,
          lockId: null,
          executionId: null,
          acceptedAt: null,
          executionLeaseUntil: null,
          ...(dead ? {} : { processingProvider: null }),
          lastError: message,
        },
      });
      await transaction.whatsAppAutomationExecution.updateMany({
        where: {
          companyId: event.companyId,
          executionId: event.executionId,
          status: WhatsAppAutomationExecutionStatus.CLAIMED,
        },
        data: {
          status: dead
            ? WhatsAppAutomationExecutionStatus.TERMINAL_FAILURE
            : WhatsAppAutomationExecutionStatus.RETRYABLE_FAILURE,
          completedAt: now,
          errorCode: dead ? 'DISPATCH_EXHAUSTED' : 'DISPATCH_FAILED',
          errorMessage: message,
        },
      });
    });
  }
}

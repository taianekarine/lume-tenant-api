import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WhatsAppMediaStorage } from '../../application/contracts/whatsapp-media.storage';
import { IntegrationOutboxStatus } from '../database/prisma/generated/client';
import { PrismaService } from '../database/prisma/prisma.service';

const DAY_MS = 86_400_000;

@Injectable()
export class WhatsAppRetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppRetentionService.name);
  private readonly retentionDays: number;
  private readonly integrationRetentionDays: number;
  private readonly enabled: boolean;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mediaStorage: WhatsAppMediaStorage,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('RETENTION_JOB_ENABLED') ?? true;
    this.retentionDays = config.get<number>('WHATSAPP_RETENTION_DAYS') ?? 365;
    this.integrationRetentionDays =
      config.get<number>('INTEGRATION_RETENTION_DAYS') ?? 90;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => {
      void this.run().catch((error: unknown) => {
        this.logger.error(`Falha na retenção WhatsApp: ${String(error)}`);
      });
    }, DAY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(now = new Date()): Promise<{
    messages: number;
    inbox: number;
    outbox: number;
    dataExchangeArtifacts: number;
  }> {
    const messageCutoff = new Date(now.valueOf() - this.retentionDays * DAY_MS);
    const integrationCutoff = new Date(
      now.valueOf() - this.integrationRetentionDays * DAY_MS,
    );
    const expiredMedia = await this.prisma.whatsAppMessage.findMany({
      where: {
        createdAt: { lt: messageCutoff },
        mediaStorageKey: { not: null },
      },
      select: { mediaStorageKey: true },
    });
    const [messages, inbox, outbox, dataExchangeArtifacts] =
      await this.prisma.$transaction([
        this.prisma.whatsAppMessage.deleteMany({
          where: { createdAt: { lt: messageCutoff } },
        }),
        this.prisma.integrationInbox.deleteMany({
          where: { receivedAt: { lt: integrationCutoff } },
        }),
        this.prisma.integrationOutbox.deleteMany({
          where: {
            status: IntegrationOutboxStatus.DELIVERED,
            deliveredAt: { lt: integrationCutoff },
          },
        }),
        this.prisma.dataExchangeArtifact.deleteMany({
          where: {
            expiresAt: { lt: now },
            conversions: { none: {} },
          },
        }),
      ]);
    const mediaDeletionResults = await Promise.allSettled(
      expiredMedia.map(({ mediaStorageKey }) =>
        mediaStorageKey
          ? this.mediaStorage.delete(mediaStorageKey)
          : Promise.resolve(),
      ),
    );
    const mediaDeletionFailures = mediaDeletionResults.filter(
      (result) => result.status === 'rejected',
    ).length;
    if (mediaDeletionFailures > 0) {
      this.logger.warn(
        `${mediaDeletionFailures} arquivo(s) expirado(s) exigem limpeza posterior.`,
      );
    }
    this.logger.log(
      `Retenção concluída messages=${messages.count} inbox=${inbox.count} outbox=${outbox.count} dataExchangeArtifacts=${dataExchangeArtifacts.count}`,
    );
    return {
      messages: messages.count,
      inbox: inbox.count,
      outbox: outbox.count,
      dataExchangeArtifacts: dataExchangeArtifacts.count,
    };
  }
}

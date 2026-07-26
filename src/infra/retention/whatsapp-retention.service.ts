import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
  }> {
    const messageCutoff = new Date(now.valueOf() - this.retentionDays * DAY_MS);
    const integrationCutoff = new Date(
      now.valueOf() - this.integrationRetentionDays * DAY_MS,
    );
    const [messages, inbox, outbox] = await this.prisma.$transaction([
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
    ]);
    this.logger.log(
      `Retenção concluída messages=${messages.count} inbox=${inbox.count} outbox=${outbox.count}`,
    );
    return {
      messages: messages.count,
      inbox: inbox.count,
      outbox: outbox.count,
    };
  }
}

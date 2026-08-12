import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../infra/database/prisma/prisma.service';

export interface ApiRequestMetricInput {
  companyId: string;
  userId: string;
  method: string;
  route: string;
  statusCode: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
}

const MAX_BUFFER_SIZE = 5_000;

@Injectable()
export class ApiUsageRecorderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ApiUsageRecorderService.name);
  private readonly buffer: ApiRequestMetricInput[] = [];
  private flushTimer?: NodeJS.Timeout;
  private retentionTimer?: NodeJS.Timeout;
  private flushing?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.flushTimer = setInterval(() => void this.flush(), 5_000);
    this.flushTimer.unref();
    void this.removeExpiredMetrics();
    this.retentionTimer = setInterval(
      () => void this.removeExpiredMetrics(),
      24 * 60 * 60 * 1_000,
    );
    this.retentionTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    await this.flush();
  }

  record(metric: ApiRequestMetricInput): void {
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.logger.warn('O buffer de métricas atingiu o limite configurado.');
      return;
    }
    this.buffer.push(metric);
    if (this.buffer.length >= 100) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, 1_000);
    this.flushing = this.prisma.apiRequestMetric
      .createMany({ data: batch })
      .then(() => undefined)
      .catch((error: unknown) => {
        this.buffer.unshift(
          ...batch.slice(0, Math.max(0, MAX_BUFFER_SIZE - this.buffer.length)),
        );
        this.logger.error(
          'Não foi possível persistir as métricas de uso.',
          error,
        );
      })
      .finally(() => {
        this.flushing = undefined;
        if (this.buffer.length >= 100) void this.flush();
      });
    return this.flushing;
  }

  private async removeExpiredMetrics(): Promise<void> {
    const retentionDays = this.config.getOrThrow<number>(
      'API_USAGE_RETENTION_DAYS',
    );
    const olderThan = new Date(Date.now() - retentionDays * 86_400_000);
    try {
      await this.prisma.apiRequestMetric.deleteMany({
        where: { createdAt: { lt: olderThan } },
      });
    } catch (error) {
      this.logger.error(
        'Não foi possível aplicar a retenção das métricas.',
        error,
      );
    }
  }
}

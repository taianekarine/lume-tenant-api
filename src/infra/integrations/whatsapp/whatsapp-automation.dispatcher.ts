import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  type ClaimedWhatsAppAutomationEvent,
  WhatsAppAutomationExecutionError,
} from '../../../application/contracts/whatsapp-automation.provider';
import { WhatsAppRepository } from '../../../application/contracts/whatsapp.repository';
import { deterministicCommandId } from '../../../domain/whatsapp/whatsapp-automation-flow';
import { sanitizeLogText } from '../../../shared/utils/sensitive-data';
import { ApiWhatsAppAutomationProvider } from './api-whatsapp-automation.provider';
import { WhatsAppAutomationEventStore } from './whatsapp-automation-event.store';

@Injectable()
export class WhatsAppAutomationDispatcher
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WhatsAppAutomationDispatcher.name);
  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly eventStore: WhatsAppAutomationEventStore,
    private readonly apiProvider: ApiWhatsAppAutomationProvider,
    private readonly repository: WhatsAppRepository,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('WHATSAPP_ENABLED') ?? false;
    this.intervalMs =
      config.get<number>('WHATSAPP_API_DISPATCH_INTERVAL_MS') ?? 500;
    this.batchSize =
      config.get<number>('WHATSAPP_API_DISPATCH_BATCH_SIZE') ?? 20;
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Dispatcher de automação do WhatsApp desabilitado.');
      return;
    }
    this.logger.log('Automação do WhatsApp iniciada na API.');
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
      const events = await this.eventStore.claim(this.batchSize);
      const eventsByConversation = new Map<
        string,
        ClaimedWhatsAppAutomationEvent[]
      >();
      for (const event of events) {
        const key = `${event.companyId}:${event.aggregateType}:${event.aggregateId}`;
        const group = eventsByConversation.get(key) ?? [];
        group.push(event);
        eventsByConversation.set(key, group);
      }
      await Promise.all(
        Array.from(eventsByConversation.values()).map(async (group) => {
          group.sort((left, right) =>
            left.aggregateSequence === right.aggregateSequence
              ? left.createdAt.valueOf() - right.createdAt.valueOf()
              : left.aggregateSequence - right.aggregateSequence,
          );
          for (const event of group) await this.dispatch(event);
        }),
      );
    } finally {
      this.running = false;
    }
  }

  private async dispatch(event: ClaimedWhatsAppAutomationEvent): Promise<void> {
    let accepted = false;
    try {
      await this.eventStore.markAccepted(event);
      accepted = true;
      await this.apiProvider.execute(event);
      this.logger.log(
        `Evento tratado pela API topic=${event.topic} outboxId=${event.id} executionId=${event.executionId} correlationId=${event.correlationId}`,
      );
    } catch (error) {
      if (!accepted) {
        await this.eventStore.rejectBeforeAcceptance(event, error);
      } else {
        await this.completeUnexpectedAcceptedFailure(event, error);
      }
      this.logger.warn(
        `Tratamento falhou na API outboxId=${event.id} correlationId=${event.correlationId} accepted=${accepted}`,
      );
    }
  }

  private async completeUnexpectedAcceptedFailure(
    event: ClaimedWhatsAppAutomationEvent,
    error: unknown,
  ): Promise<void> {
    const executionError =
      error instanceof WhatsAppAutomationExecutionError ? error : null;
    try {
      await this.repository.completeOutboxExecution({
        companyId: event.companyId,
        eventId: event.id,
        commandId: deterministicCommandId(
          event.executionId,
          'unexpected-accepted-failure',
        ),
        executionId: event.executionId,
        automationProvider: 'api',
        aggregateType: event.aggregateType,
        aggregateId: event.aggregateId,
        outcome: executionError?.outcome ?? 'retryable-failure',
        errorCode: executionError?.errorCode ?? 'AUTOMATION_EXECUTION_FAILED',
        errorMessage: sanitizeLogText(String(error)).slice(0, 500),
      });
    } catch (completionError) {
      this.logger.error(
        `Falha ao concluir execução aceita outboxId=${event.id}: ${sanitizeLogText(String(completionError))}`,
      );
    }
  }
}

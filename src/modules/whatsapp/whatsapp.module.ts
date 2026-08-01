import { Module } from '@nestjs/common';

import { WhatsAppRepository } from '../../application/contracts/whatsapp.repository';
import {
  ClaimEvolutionDispatchUseCase,
  CompleteOutboxExecutionUseCase,
  CreateHumanOutboundWhatsAppUseCase,
  CreateOutboundWhatsAppUseCase,
  PatchQuoteRequestUseCase,
  QuoteProposalUseCase,
  QueryWhatsAppUseCase,
  RecordEvolutionResultUseCase,
  TransitionWhatsAppConversationUseCase,
} from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { EvolutionMediaContentService } from '../../infra/integrations/evolution/evolution-media-content.service';
import { EvolutionWebhookService } from '../../infra/integrations/evolution/evolution-webhook.service';
import { IntegrationOutboxDispatcher } from '../../infra/integrations/n8n/integration-outbox.dispatcher';
import { WhatsAppRetentionService } from '../../infra/retention/whatsapp-retention.service';
import { ServiceIdentityGuard } from '../../shared/http/guards/service-identity.guard';
import { EvolutionWebhookController } from './evolution-webhook.controller';
import { InternalWhatsAppController } from './internal-whatsapp.controller';
import { NotificationsController } from './notifications.controller';
import { QuoteProposalController } from './quote-proposal.controller';
import { WhatsAppPanelController } from './whatsapp-panel.controller';

@Module({
  controllers: [
    EvolutionWebhookController,
    InternalWhatsAppController,
    WhatsAppPanelController,
    QuoteProposalController,
    NotificationsController,
  ],
  providers: [
    EvolutionWebhookService,
    EvolutionMediaContentService,
    IntegrationOutboxDispatcher,
    WhatsAppRetentionService,
    ServiceIdentityGuard,
    {
      provide: TransitionWhatsAppConversationUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new TransitionWhatsAppConversationUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: PatchQuoteRequestUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new PatchQuoteRequestUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: CreateOutboundWhatsAppUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new CreateOutboundWhatsAppUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: CreateHumanOutboundWhatsAppUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new CreateHumanOutboundWhatsAppUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: ClaimEvolutionDispatchUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new ClaimEvolutionDispatchUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: RecordEvolutionResultUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new RecordEvolutionResultUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: CompleteOutboxExecutionUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new CompleteOutboxExecutionUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: QueryWhatsAppUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new QueryWhatsAppUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: QuoteProposalUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new QuoteProposalUseCase(repository),
      inject: [WhatsAppRepository],
    },
  ],
})
export class WhatsAppModule {}

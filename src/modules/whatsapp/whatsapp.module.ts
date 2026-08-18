import { Module } from '@nestjs/common';

import { WhatsAppMediaStorage } from '../../application/contracts/whatsapp-media.storage';
import { WhatsAppRepository } from '../../application/contracts/whatsapp.repository';
import {
  CreateHumanOutboundWhatsAppUseCase,
  EnsureWhatsAppConversationUseCase,
  QuoteProposalUseCase,
  QueryWhatsAppUseCase,
  TransitionWhatsAppConversationUseCase,
} from '../../application/use-cases/whatsapp/whatsapp.use-cases';
import { EvolutionWebhookService } from '../../infra/integrations/evolution/evolution-webhook.service';
import { EvolutionMediaContentService } from '../../infra/integrations/evolution/evolution-media-content.service';
import { EvolutionProfilePictureService } from '../../infra/integrations/evolution/evolution-profile-picture.service';
import { HttpEvolutionOutboundGateway } from '../../infra/integrations/evolution/evolution-outbound.client';
import { ApiWhatsAppAutomationProvider } from '../../infra/integrations/whatsapp/api-whatsapp-automation.provider';
import { WhatsAppAutomationDecisionStore } from '../../infra/integrations/whatsapp/whatsapp-automation-decision.store';
import { WhatsAppAutomationCheckpointStore } from '../../infra/integrations/whatsapp/whatsapp-automation-checkpoint.store';
import { WhatsAppAutomationDispatcher } from '../../infra/integrations/whatsapp/whatsapp-automation.dispatcher';
import { WhatsAppAutomationEventStore } from '../../infra/integrations/whatsapp/whatsapp-automation-event.store';
import { OpenAiCompatibleWhatsAppConversationAgent } from '../../infra/integrations/whatsapp-ai/openai-compatible-whatsapp-conversation-agent';
import { WhatsAppRetentionService } from '../../infra/retention/whatsapp-retention.service';
import { WhatsAppHistoryImportService } from '../../infra/imports/whatsapp-history-import.service';
import { WhatsAppAndroidMediaImportService } from '../../infra/imports/whatsapp-android-media-import.service';
import { FileSystemWhatsAppMediaStorage } from '../../infra/storage/file-system-whatsapp-media.storage';
import { EvolutionWebhookController } from './evolution-webhook.controller';
import { NotificationsController } from './notifications.controller';
import { QuoteProposalController } from './quote-proposal.controller';
import { WhatsAppPanelController } from './whatsapp-panel.controller';
import { WhatsAppHistoryImportController } from './whatsapp-history-import.controller';
import { WhatsAppContactsController } from './whatsapp-contacts.controller';
import { WhatsAppContactsService } from './whatsapp-contacts.service';

@Module({
  controllers: [
    EvolutionWebhookController,
    WhatsAppPanelController,
    QuoteProposalController,
    NotificationsController,
    WhatsAppHistoryImportController,
    WhatsAppContactsController,
  ],
  providers: [
    EvolutionWebhookService,
    EvolutionMediaContentService,
    EvolutionProfilePictureService,
    FileSystemWhatsAppMediaStorage,
    {
      provide: WhatsAppMediaStorage,
      useExisting: FileSystemWhatsAppMediaStorage,
    },
    HttpEvolutionOutboundGateway,
    OpenAiCompatibleWhatsAppConversationAgent,
    ApiWhatsAppAutomationProvider,
    WhatsAppAutomationCheckpointStore,
    WhatsAppAutomationDecisionStore,
    WhatsAppAutomationEventStore,
    WhatsAppAutomationDispatcher,
    WhatsAppRetentionService,
    WhatsAppAndroidMediaImportService,
    WhatsAppHistoryImportService,
    WhatsAppContactsService,
    {
      provide: EnsureWhatsAppConversationUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new EnsureWhatsAppConversationUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: TransitionWhatsAppConversationUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new TransitionWhatsAppConversationUseCase(repository),
      inject: [WhatsAppRepository],
    },
    {
      provide: CreateHumanOutboundWhatsAppUseCase,
      useFactory: (repository: WhatsAppRepository) =>
        new CreateHumanOutboundWhatsAppUseCase(repository),
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

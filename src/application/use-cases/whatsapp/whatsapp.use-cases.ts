import { WhatsAppRepository } from '../../contracts/whatsapp.repository';
import type {
  ClaimEvolutionDispatchInput,
  CompleteOutboxExecutionInput,
  ConversationListQuery,
  CreateHumanOutboundInput,
  CreateOutboundInput,
  EvolutionResultInput,
  MessageListQuery,
  PersistInboundInput,
  QuoteRequestPatch,
  TransitionCommand,
  TransitionListQuery,
} from '../../contracts/whatsapp.repository';

export class PersistInboundWhatsAppUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: PersistInboundInput) {
    return this.repository.persistInbound(input);
  }
}

export class TransitionWhatsAppConversationUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: TransitionCommand) {
    return this.repository.transition(input);
  }
}

export class PatchQuoteRequestUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(companyId: string, quoteRequestId: string, input: QuoteRequestPatch) {
    return this.repository.patchQuoteRequest(companyId, quoteRequestId, input);
  }
}

export class CreateOutboundWhatsAppUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: CreateOutboundInput) {
    return this.repository.createOutbound(input);
  }
}

export class CreateHumanOutboundWhatsAppUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: CreateHumanOutboundInput) {
    return this.repository.createHumanOutbound(input);
  }
}

export class ClaimEvolutionDispatchUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: ClaimEvolutionDispatchInput) {
    return this.repository.claimEvolutionDispatch(input);
  }
}

export class RecordEvolutionResultUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: EvolutionResultInput) {
    return this.repository.recordEvolutionResult(input);
  }
}

export class CompleteOutboxExecutionUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: CompleteOutboxExecutionInput) {
    return this.repository.completeOutboxExecution(input);
  }
}

export class QueryWhatsAppUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}

  listConversations(companyId: string, query: ConversationListQuery) {
    return this.repository.listConversations(companyId, query);
  }

  getConversation(companyId: string, conversationId: string) {
    return this.repository.getConversation(companyId, conversationId);
  }

  listMessages(
    companyId: string,
    conversationId: string,
    query: MessageListQuery,
  ) {
    return this.repository.listMessages(companyId, conversationId, query);
  }

  listTransitions(
    companyId: string,
    conversationId: string,
    query: TransitionListQuery,
  ) {
    return this.repository.listTransitions(companyId, conversationId, query);
  }

  getCurrentQuoteRequest(companyId: string, conversationId: string) {
    return this.repository.getCurrentQuoteRequest(companyId, conversationId);
  }
}

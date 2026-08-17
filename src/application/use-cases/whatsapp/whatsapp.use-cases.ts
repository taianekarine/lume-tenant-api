import { WhatsAppRepository } from '../../contracts/whatsapp.repository';
import type {
  ClaimEvolutionDispatchInput,
  CompleteOutboxExecutionInput,
  ConversationListQuery,
  CreateQuoteProposalInput,
  CreateHumanOutboundInput,
  CreateOutboundInput,
  EvolutionResultInput,
  DecideQuoteProposalInput,
  MessageListQuery,
  PersistWebhookMessageInput,
  QuoteProposalListQuery,
  QuoteRequestPatch,
  ReconcileAutomationOutboxInput,
  SendQuoteProposalInput,
  TransitionCommand,
  TransitionListQuery,
  UpdateQuoteProposalStatusInput,
  UploadQuoteProposalDocumentInput,
} from '../../contracts/whatsapp.repository';

export class PersistWebhookWhatsAppMessageUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: PersistWebhookMessageInput) {
    return this.repository.persistWebhookMessage(input);
  }
}

export class TransitionWhatsAppConversationUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: TransitionCommand) {
    return this.repository.transition(input);
  }
}

export class EnsureWhatsAppConversationUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}

  execute(companyId: string, phoneNormalized: string) {
    return this.repository.ensureConversationForPhone(
      companyId,
      phoneNormalized,
    );
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

export class ReconcileAutomationOutboxUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}
  execute(input: ReconcileAutomationOutboxInput) {
    return this.repository.reconcileAutomationOutbox(input);
  }
}

export class QuoteProposalUseCase {
  constructor(private readonly repository: WhatsAppRepository) {}

  list(companyId: string, query: QuoteProposalListQuery) {
    return this.repository.listQuoteProposals(companyId, query);
  }

  notificationSummary(companyId: string, userId: string) {
    return this.repository.getQuoteProposalNotificationSummary(
      companyId,
      userId,
    );
  }

  markNotificationRead(companyId: string, userId: string) {
    return this.repository.markQuoteProposalNotificationRead(companyId, userId);
  }

  get(companyId: string, quoteRequestId: string) {
    return this.repository.getQuoteProposal(companyId, quoteRequestId);
  }

  create(input: CreateQuoteProposalInput) {
    return this.repository.createQuoteProposal(input);
  }

  decide(input: DecideQuoteProposalInput) {
    return this.repository.decideQuoteProposal(input);
  }

  updateStatus(input: UpdateQuoteProposalStatusInput) {
    if (input.status === 'approved' || input.status === 'rejected') {
      return this.repository.decideQuoteProposal({
        companyId: input.companyId,
        quoteRequestId: input.quoteRequestId,
        actorUserId: input.actorUserId,
        commandId: input.commandId,
        expectedVersion: input.expectedVersion,
        decision: input.status,
        reason: input.reason,
      });
    }

    return this.repository.updateQuoteProposalStatus(input);
  }

  upload(input: UploadQuoteProposalDocumentInput) {
    return this.repository.uploadQuoteProposalDocument(input);
  }

  send(input: SendQuoteProposalInput) {
    return this.repository.sendQuoteProposal(input);
  }

  getDocument(companyId: string, documentId: string) {
    return this.repository.getQuoteProposalDocument(companyId, documentId);
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

  getAutomationBatch(
    companyId: string,
    conversationId: string,
    sourceEventId: string,
    windowSeconds: number,
  ) {
    return this.repository.getAutomationBatch(
      companyId,
      conversationId,
      sourceEventId,
      windowSeconds,
    );
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

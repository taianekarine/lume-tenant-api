import { describe, expect, it } from 'vitest';

import {
  WhatsAppRepository,
  type ClaimEvolutionDispatchInput,
  type ConversationListQuery,
  type CreateQuoteProposalInput,
  type DecideQuoteProposalInput,
  type CreateHumanOutboundInput,
  type CreateOutboundInput,
  type EvolutionResultInput,
  type MessageListQuery,
  type PersistInboundInput,
  type QuoteProposalListQuery,
  type QuoteRequestPatch,
  type SendQuoteProposalInput,
  type TransitionCommand,
  type TransitionListQuery,
  type UpdateQuoteProposalStatusInput,
  type UploadQuoteProposalDocumentInput,
  type WebhookChannelConfiguration,
} from '../../contracts/whatsapp.repository';
import {
  ClaimEvolutionDispatchUseCase,
  CreateHumanOutboundWhatsAppUseCase,
  CreateOutboundWhatsAppUseCase,
  PatchQuoteRequestUseCase,
  PersistInboundWhatsAppUseCase,
  QuoteProposalUseCase,
  QueryWhatsAppUseCase,
  RecordEvolutionResultUseCase,
  TransitionWhatsAppConversationUseCase,
} from './whatsapp.use-cases';

class RecordingWhatsAppRepository extends WhatsAppRepository {
  calls: string[] = [];

  async findWebhookChannel(
    _channelId: string,
  ): Promise<WebhookChannelConfiguration | null> {
    this.calls.push('findWebhookChannel');
    return null;
  }
  async persistInbound(_input: PersistInboundInput) {
    this.calls.push('persistInbound');
    return { operation: 'persistInbound' };
  }
  async transition(_input: TransitionCommand) {
    this.calls.push('transition');
    return { operation: 'transition' };
  }
  async patchQuoteRequest(
    _companyId: string,
    _quoteRequestId: string,
    _input: QuoteRequestPatch,
  ) {
    this.calls.push('patchQuoteRequest');
    return { operation: 'patchQuoteRequest' };
  }
  async createOutbound(_input: CreateOutboundInput) {
    this.calls.push('createOutbound');
    return { operation: 'createOutbound' };
  }
  async createHumanOutbound(_input: CreateHumanOutboundInput) {
    this.calls.push('createHumanOutbound');
    return { operation: 'createHumanOutbound' };
  }
  async claimEvolutionDispatch(_input: ClaimEvolutionDispatchInput) {
    this.calls.push('claimEvolutionDispatch');
    return { operation: 'claimEvolutionDispatch' };
  }
  async recordEvolutionResult(_input: EvolutionResultInput) {
    this.calls.push('recordEvolutionResult');
    return { operation: 'recordEvolutionResult' };
  }
  async listConversations(_companyId: string, _query: ConversationListQuery) {
    this.calls.push('listConversations');
    return { operation: 'listConversations' };
  }
  async getConversation(_companyId: string, _conversationId: string) {
    this.calls.push('getConversation');
    return { operation: 'getConversation' };
  }
  async getAutomationBatch(
    _companyId: string,
    _conversationId: string,
    _sourceEventId: string,
    _windowSeconds: number,
  ) {
    this.calls.push('getAutomationBatch');
    return { operation: 'getAutomationBatch' };
  }
  async listMessages(
    _companyId: string,
    _conversationId: string,
    _query: MessageListQuery,
  ) {
    this.calls.push('listMessages');
    return { operation: 'listMessages' };
  }
  async getCurrentQuoteRequest(_companyId: string, _conversationId: string) {
    this.calls.push('getCurrentQuoteRequest');
    return { operation: 'getCurrentQuoteRequest' };
  }
  async listQuoteProposals(_companyId: string, _query: QuoteProposalListQuery) {
    this.calls.push('listQuoteProposals');
    return { operation: 'listQuoteProposals' };
  }
  async getQuoteProposalNotificationSummary(
    _companyId: string,
    _userId: string,
  ) {
    this.calls.push('getQuoteProposalNotificationSummary');
    return {
      notificationId: 'commercial.pending-quote-proposals' as const,
      pendingTotal: 0,
      unreadTotal: 0,
    };
  }
  async markQuoteProposalNotificationRead(_companyId: string, _userId: string) {
    this.calls.push('markQuoteProposalNotificationRead');
    return {
      notificationId: 'commercial.pending-quote-proposals' as const,
      pendingTotal: 0,
      unreadTotal: 0,
      markedRead: 0,
      readAt: new Date(0).toISOString(),
    };
  }
  async getQuoteProposal(_companyId: string, _quoteRequestId: string) {
    this.calls.push('getQuoteProposal');
    return { operation: 'getQuoteProposal' };
  }
  async createQuoteProposal(_input: CreateQuoteProposalInput) {
    this.calls.push('createQuoteProposal');
    return { operation: 'createQuoteProposal' };
  }
  async decideQuoteProposal(_input: DecideQuoteProposalInput) {
    this.calls.push('decideQuoteProposal');
    return { operation: 'decideQuoteProposal' };
  }
  async updateQuoteProposalStatus(_input: UpdateQuoteProposalStatusInput) {
    this.calls.push('updateQuoteProposalStatus');
    return { operation: 'updateQuoteProposalStatus' };
  }
  async uploadQuoteProposalDocument(_input: UploadQuoteProposalDocumentInput) {
    this.calls.push('uploadQuoteProposalDocument');
    return { operation: 'uploadQuoteProposalDocument' };
  }
  async sendQuoteProposal(_input: SendQuoteProposalInput) {
    this.calls.push('sendQuoteProposal');
    return { operation: 'sendQuoteProposal' };
  }
  async getQuoteProposalDocument(_companyId: string, _documentId: string) {
    this.calls.push('getQuoteProposalDocument');
    return { operation: 'getQuoteProposalDocument' };
  }
  async listTransitions(
    _companyId: string,
    _conversationId: string,
    _query: TransitionListQuery,
  ) {
    this.calls.push('listTransitions');
    return { operation: 'listTransitions' };
  }
}

describe('casos de uso WhatsApp', () => {
  it('delega comandos transacionais ao repositório', async () => {
    const repository = new RecordingWhatsAppRepository();
    const common = {
      companyId: 'company',
      conversationId: 'conversation',
      commandId: 'command',
    };

    await new PersistInboundWhatsAppUseCase(repository).execute(
      {} as PersistInboundInput,
    );
    await new TransitionWhatsAppConversationUseCase(repository).execute({
      ...common,
      expectedVersion: 1,
      name: 'mark-read',
      actorType: 'system',
    });
    await new PatchQuoteRequestUseCase(repository).execute('company', 'quote', {
      commandId: 'command',
      expectedVersion: 1,
    });
    await new CreateOutboundWhatsAppUseCase(repository).execute({
      ...common,
      automatic: true,
      kind: 'text',
      text: 'Olá',
    });
    await new CreateHumanOutboundWhatsAppUseCase(repository).execute({
      ...common,
      idempotencyKey: 'idempotency',
      expectedVersion: 1,
      actorUserId: 'user',
      text: 'Resposta humana',
    });
    await new ClaimEvolutionDispatchUseCase(repository).execute({
      companyId: 'company',
      messageId: 'message',
      attemptId: 'attempt',
      commandId: 'command',
    });
    await new RecordEvolutionResultUseCase(repository).execute({
      companyId: 'company',
      messageId: 'message',
      commandId: 'command',
      attemptId: 'attempt',
      status: 'sent',
    });

    expect(repository.calls).toEqual([
      'persistInbound',
      'transition',
      'patchQuoteRequest',
      'createOutbound',
      'createHumanOutbound',
      'claimEvolutionDispatch',
      'recordEvolutionResult',
    ]);
  });

  it('delega todas as consultas com o companyId recebido', async () => {
    const repository = new RecordingWhatsAppRepository();
    const query = new QueryWhatsAppUseCase(repository);

    await query.listConversations('company', { page: 1, pageSize: 20 });
    await query.getConversation('company', 'conversation');
    await query.getAutomationBatch(
      'company',
      'conversation',
      'source-event',
      120,
    );
    await query.listMessages('company', 'conversation', {
      page: 1,
      pageSize: 50,
    });
    await query.listTransitions('company', 'conversation', {
      page: 1,
      pageSize: 50,
    });
    await query.getCurrentQuoteRequest('company', 'conversation');

    expect(repository.calls).toEqual([
      'listConversations',
      'getConversation',
      'getAutomationBatch',
      'listMessages',
      'listTransitions',
      'getCurrentQuoteRequest',
    ]);
  });

  it('delega upload, consulta e envio de proposta sem acessar o provedor', async () => {
    const repository = new RecordingWhatsAppRepository();
    const proposals = new QuoteProposalUseCase(repository);

    await proposals.list('company', {
      page: 1,
      pageSize: 20,
      stage: 'pending',
    });
    await proposals.get('company', 'quote');
    await proposals.create({
      companyId: 'company',
      conversationId: 'conversation',
      actorUserId: 'user',
      commandId: 'command',
      expectedVersion: 1,
      contactName: 'Cliente',
      serviceType: 'Fretamento eventual',
      origin: 'Uberlândia',
      destination: 'Goiânia',
      departureAt: new Date(),
      passengerCount: 20,
      vehicleAtDisposal: false,
      localTransfers: false,
    });
    await proposals.decide({
      companyId: 'company',
      quoteRequestId: 'quote',
      actorUserId: 'user',
      commandId: 'decision',
      expectedVersion: 2,
      decision: 'approved',
    });
    await proposals.updateStatus({
      companyId: 'company',
      quoteRequestId: 'quote',
      actorUserId: 'user',
      commandId: 'status',
      expectedVersion: 3,
      status: 'under-review',
    });
    await proposals.upload({
      companyId: 'company',
      quoteRequestId: 'quote',
      actorUserId: 'user',
      commandId: 'upload',
      expectedVersion: 1,
      file: {
        originalName: 'orcamento.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 9,
        content: Buffer.from('%PDF-EOF'),
      },
    });
    await proposals.send({
      companyId: 'company',
      quoteRequestId: 'quote',
      proposalDocumentId: 'document',
      batchId: 'batch',
      batchDocumentIds: ['document'],
      actorUserId: 'user',
      commandId: 'send',
      expectedVersion: 1,
    });
    await proposals.getDocument('company', 'document');
    await proposals.notificationSummary('company', 'user');
    await proposals.markNotificationRead('company', 'user');

    expect(repository.calls).toEqual([
      'listQuoteProposals',
      'getQuoteProposal',
      'createQuoteProposal',
      'decideQuoteProposal',
      'updateQuoteProposalStatus',
      'uploadQuoteProposalDocument',
      'sendQuoteProposal',
      'getQuoteProposalDocument',
      'getQuoteProposalNotificationSummary',
      'markQuoteProposalNotificationRead',
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  WhatsAppRepository,
  type ClaimEvolutionDispatchInput,
  type ConversationListQuery,
  type CreateHumanOutboundInput,
  type CreateOutboundInput,
  type EvolutionResultInput,
  type MessageListQuery,
  type PersistInboundInput,
  type QuoteRequestPatch,
  type TransitionCommand,
  type TransitionListQuery,
  type WebhookChannelConfiguration,
} from '../../contracts/whatsapp.repository';
import {
  ClaimEvolutionDispatchUseCase,
  CreateHumanOutboundWhatsAppUseCase,
  CreateOutboundWhatsAppUseCase,
  PatchQuoteRequestUseCase,
  PersistInboundWhatsAppUseCase,
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
      'listMessages',
      'listTransitions',
      'getCurrentQuoteRequest',
    ]);
  });
});
